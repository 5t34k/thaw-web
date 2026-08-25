// FROST Backup Emergency Recovery - core logic.
//
// Direct port of reconstruct_frost_backups.py. Recombines FROST backup shares
// into a BIP32 xpriv and a Taproot descriptor, with full checksum verification.
// Runs entirely in the browser; nothing leaves the page.
//
// Depends on (loaded first, as classic-script globals):
//   window.nobleSecp256k1  - secp256k1 point arithmetic
//   window.sha256 / sha256d
//   window.BIP39_WORDLIST  - 2048-word English list
//
// Exposes window.Frost with the same surface as the Python module.
(function () {
  "use strict";

  const secp = window.nobleSecp256k1;
  const sha256 = window.sha256;
  const sha256d = window.sha256d;

  // secp256k1 curve order (scalar field for Shamir arithmetic).
  const SECP256K1_ORDER =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  // Constants from the FROST backup specification (v0).
  const NUM_WORDS = 25;
  const BITS_PER_WORD = 11;
  const TOTAL_BITS = NUM_WORDS * BITS_PER_WORD; // 275
  const SCALAR_BITS = 256;
  const POLY_CHECKSUM_BITS = 8;
  const WORDS_CHECKSUM_BITS = 11;
  const POLY_CHECKSUM_START = SCALAR_BITS; // 256
  const WORDS_CHECKSUM_START = POLY_CHECKSUM_START + POLY_CHECKSUM_BITS; // 264

  class ShareBackupError extends Error {
    constructor(message) {
      super(message);
      this.name = "ShareBackupError";
    }
  }

  // ---- byte / bigint helpers -------------------------------------------------

  function bytesToHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
      s += bytes[i].toString(16).padStart(2, "0");
    }
    return s;
  }

  function hexToBytes(hex) {
    if (hex.length % 2) throw new Error("odd-length hex");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  function bytesToBigInt(bytes) {
    let n = 0n;
    for (let i = 0; i < bytes.length; i++) {
      n = (n << 8n) | BigInt(bytes[i]);
    }
    return n;
  }

  // Big-endian encode `value` into exactly `length` bytes.
  function bigIntToBytes(value, length) {
    if (value < 0n) throw new Error("negative value");
    const out = new Uint8Array(length);
    let v = value;
    for (let i = length - 1; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    if (v !== 0n) throw new Error("value does not fit in " + length + " bytes");
    return out;
  }

  function intToBytes(value, length) {
    return bigIntToBytes(BigInt(value), length);
  }

  function concatBytes(...arrays) {
    let total = 0;
    for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) {
      out.set(a, off);
      off += a.length;
    }
    return out;
  }

  // Modular inverse via Fermat's little theorem (field is prime).
  function modInverse(a, m) {
    return modPow(((a % m) + m) % m, m - 2n, m);
  }

  function modPow(base, exp, mod) {
    let result = 1n;
    base %= mod;
    while (exp > 0n) {
      if (exp & 1n) result = (result * base) % mod;
      exp >>= 1n;
      base = (base * base) % mod;
    }
    return result;
  }

  function mod(a, m) {
    return ((a % m) + m) % m;
  }

  // ---- BIP39 wordlist --------------------------------------------------------

  const WORDLIST = window.BIP39_WORDLIST;
  const WORD_INDEX = (() => {
    const map = new Map();
    for (let i = 0; i < WORDLIST.length; i++) map.set(WORDLIST[i], i);
    return map;
  })();

  // ---- checksums -------------------------------------------------------------

  // 11-bit words checksum: first 11 bits of SHA256(index_u32 || scalar || poly_u16).
  function computeWordsChecksum(index, scalarBytes, polyChecksum) {
    const digest = sha256(
      concatBytes(intToBytes(index, 4), scalarBytes, intToBytes(polyChecksum, 2))
    );
    const twoBytes = (digest[0] << 8) | digest[1];
    return twoBytes >> 5;
  }

  // 8-bit polynomial checksum. NOTE: index is a 32-byte scalar here (differs
  // from the 4-byte u32 used by the words checksum).
  function computePolyChecksum(index, scalarBytes, polyCommitment) {
    const digest = sha256(
      concatBytes(intToBytes(index, 32), scalarBytes, polyCommitment)
    );
    return digest[0];
  }

  // ---- ShareBackup -----------------------------------------------------------

  class ShareBackup {
    constructor(index, scalarBytes, polyChecksum) {
      if (index === 0) throw new ShareBackupError("Share index cannot be 0");
      if (scalarBytes.length !== 32) {
        throw new ShareBackupError(
          `Scalar must be 32 bytes, got ${scalarBytes.length}`
        );
      }
      this.index = index;
      this.scalarBytes = scalarBytes;
      this.polyChecksum = polyChecksum;
    }

    static fromString(shareString) {
      const trimmed = shareString.trim();
      const match = trimmed.match(/^#(\d+)\s+([\s\S]+)$/);
      if (!match) {
        throw new ShareBackupError(
          "Invalid format. Expected: #<index> <25 words>"
        );
      }

      const index = parseInt(match[1], 10);
      const words = match[2].toUpperCase().split(/\s+/).filter((w) => w.length);

      if (words.length !== NUM_WORDS) {
        throw new ShareBackupError(
          `Expected ${NUM_WORDS} words, got ${words.length}`
        );
      }

      const wordIndices = [];
      for (let i = 0; i < words.length; i++) {
        const wordLower = words[i].toLowerCase();
        if (!WORD_INDEX.has(wordLower)) {
          throw new ShareBackupError(
            `Word #${i + 1} '${words[i]}' not in BIP39 wordlist`
          );
        }
        wordIndices.push(WORD_INDEX.get(wordLower));
      }

      // Unpack 275 bits MSB-first: 256 (scalar) + 8 (poly) + 11 (words checksum).
      const scalarBytes = new Uint8Array(32);
      let polyChecksum = 0;
      let wordsChecksum = 0;
      let bitsProcessed = 0;

      for (const wordIdx of wordIndices) {
        for (let bitOffset = BITS_PER_WORD - 1; bitOffset >= 0; bitOffset--) {
          const bit = (wordIdx >> bitOffset) & 1;
          if (bit !== 0) {
            if (bitsProcessed < SCALAR_BITS) {
              const byteIndex = Math.floor(bitsProcessed / 8);
              const bitInByte = bitsProcessed % 8;
              scalarBytes[byteIndex] |= 1 << (7 - bitInByte);
            } else if (bitsProcessed < WORDS_CHECKSUM_START) {
              const checksumBit = bitsProcessed - POLY_CHECKSUM_START;
              polyChecksum |= 1 << (POLY_CHECKSUM_BITS - 1 - checksumBit);
            } else if (bitsProcessed < TOTAL_BITS) {
              const checksumBit = bitsProcessed - WORDS_CHECKSUM_START;
              wordsChecksum |= 1 << (WORDS_CHECKSUM_BITS - 1 - checksumBit);
            }
          }
          bitsProcessed++;
        }
      }

      const expected = computeWordsChecksum(index, scalarBytes, polyChecksum);
      if (expected !== wordsChecksum) {
        throw new ShareBackupError(
          `Words checksum failed (expected ${expected}, got ${wordsChecksum}). ` +
            "Likely transcription error."
        );
      }

      return new ShareBackup(index, scalarBytes, polyChecksum);
    }
  }

  // ---- elliptic-curve reconstruction ----------------------------------------

  // Public share image: share_scalar * G, compressed (33 bytes).
  function computeShareImage(index, scalarBytes) {
    const point = secp.getPublicKey(scalarBytes, true);
    return [index, point];
  }

  function verifyPolynomialChecksum(share, polyCommitment) {
    const expected = computePolyChecksum(
      share.index,
      share.scalarBytes,
      polyCommitment
    );
    return expected === share.polyChecksum;
  }

  // Coefficient of x^degree in the Lagrange basis polynomial L_i(x), in the
  // secp256k1 scalar field.
  function lagrangeCoefficientForDegree(degree, shareIndex, allIndices) {
    let poly = [1n];
    const xi = BigInt(shareIndex);

    for (const xjRaw of allIndices) {
      const xj = BigInt(xjRaw);
      if (xj === xi) continue;

      const denom = mod(xi - xj, SECP256K1_ORDER);
      const denomInv = modInverse(denom, SECP256K1_ORDER);

      const newPoly = new Array(poly.length + 1).fill(0n);
      for (let i = 0; i < poly.length; i++) {
        newPoly[i + 1] = mod(newPoly[i + 1] + poly[i], SECP256K1_ORDER);
        newPoly[i] = mod(newPoly[i] - poly[i] * xj, SECP256K1_ORDER);
      }
      poly = newPoly.map((c) => mod(c * denomInv, SECP256K1_ORDER));
    }

    return degree < poly.length ? poly[degree] : 0n;
  }

  // Reconstruct the polynomial commitment (threshold * 33 bytes) from share
  // images via Lagrange interpolation on curve points.
  function reconstructPolynomialCommitment(shareImages, threshold) {
    const indices = shareImages.map(([idx]) => idx);
    const polyPoints = [];

    for (let degree = 0; degree < threshold; degree++) {
      let acc = null;

      for (const [xi, pointBytes] of shareImages) {
        const weight = lagrangeCoefficientForDegree(degree, xi, indices);
        if (weight === 0n) continue; // 0 * P = identity, contributes nothing
        const point = secp.ProjectivePoint.fromHex(pointBytes);
        const weighted = point.multiply(weight);
        acc = acc === null ? weighted : acc.add(weighted);
      }

      if (acc === null) {
        throw new Error("degenerate polynomial commitment (all weights zero)");
      }
      polyPoints.push(acc.toRawBytes(true));
    }

    return concatBytes(...polyPoints);
  }

  // Lagrange coefficient L_i(0) in the secp256k1 scalar field.
  function lagrangeCoefficient(xi, xValues) {
    let numerator = 1n;
    let denominator = 1n;
    const x_i = BigInt(xi);

    for (const xjRaw of xValues) {
      const xj = BigInt(xjRaw);
      if (xj !== x_i) {
        numerator = mod(numerator * mod(-xj, SECP256K1_ORDER), SECP256K1_ORDER);
        denominator = mod(
          denominator * mod(x_i - xj, SECP256K1_ORDER),
          SECP256K1_ORDER
        );
      }
    }

    const denomInv = modInverse(denominator, SECP256K1_ORDER);
    return mod(numerator * denomInv, SECP256K1_ORDER);
  }

  // Recover the 32-byte secret from a set of shares. Verifies the polynomial
  // checksum for every share (detects shares from different wallets).
  function recoverSecret(shares, threshold) {
    if (!shares || shares.length === 0) {
      throw new Error("No shares provided");
    }
    if (threshold == null) threshold = shares.length;

    const indices = shares.map((s) => s.index);
    const scalars = shares.map((s) => bytesToBigInt(s.scalarBytes));

    if (new Set(indices).size !== indices.length) {
      throw new Error("Duplicate share indices detected");
    }

    const shareImages = shares.map((s) =>
      computeShareImage(s.index, s.scalarBytes)
    );
    const polyCommitment = reconstructPolynomialCommitment(
      shareImages,
      threshold
    );

    for (const share of shares) {
      if (!verifyPolynomialChecksum(share, polyCommitment)) {
        throw new Error(
          `Polynomial checksum failed for share #${share.index}. ` +
            "Shares may be from different wallets."
        );
      }
    }

    let secret = 0n;
    for (let i = 0; i < indices.length; i++) {
      const coeff = lagrangeCoefficient(indices[i], indices);
      secret = mod(secret + coeff * scalars[i], SECP256K1_ORDER);
    }

    return bigIntToBytes(secret, 32);
  }

  // ---- base58check + xpriv ---------------------------------------------------

  const BASE58_ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  function base58Encode(bytes) {
    let num = bytesToBigInt(bytes);
    let out = "";
    while (num > 0n) {
      const rem = num % 58n;
      num = num / 58n;
      out = BASE58_ALPHABET[Number(rem)] + out;
    }
    // Preserve leading zero bytes as '1'.
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
      out = "1" + out;
    }
    return out;
  }

  // BIP32 extended private key (depth 0, no parent, zero chain code) - matching
  // the Rust reference frost_backup/src/lib.rs.
  function generateXpriv(secretBytes, network) {
    network = network || "mainnet";
    const version = hexToBytes(
      network === "mainnet" ? "0488ADE4" : "04358394"
    );
    const depth = new Uint8Array([0]);
    const parentFingerprint = new Uint8Array(4);
    const childNumber = new Uint8Array(4);
    const chainCode = new Uint8Array(32);
    const keyData = concatBytes(new Uint8Array([0]), secretBytes);

    const serialized = concatBytes(
      version,
      depth,
      parentFingerprint,
      childNumber,
      chainCode,
      keyData
    );
    const checksum = sha256d(serialized).slice(0, 4);
    return base58Encode(concatBytes(serialized, checksum));
  }

  // ---- BIP-380 descriptor checksum ------------------------------------------

  const INPUT_CHARSET =
    "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
  const CHECKSUM_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const GENERATOR = [
    0xf5dee51989n,
    0xa9fdca3312n,
    0x1bab10e32dn,
    0x3706b1677an,
    0x644d626ffdn,
  ];

  function descsumPolymod(symbols) {
    let chk = 1n;
    for (const value of symbols) {
      const top = chk >> 35n;
      chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value);
      for (let i = 0; i < 5; i++) {
        chk ^= (top >> BigInt(i)) & 1n ? GENERATOR[i] : 0n;
      }
    }
    return chk;
  }

  function descsumExpand(s) {
    const groups = [];
    const symbols = [];
    for (const c of s) {
      const v = INPUT_CHARSET.indexOf(c);
      if (v < 0) return null;
      symbols.push(v & 31);
      groups.push(v >> 5);
      if (groups.length === 3) {
        symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]);
        groups.length = 0;
      }
    }
    if (groups.length === 1) {
      symbols.push(groups[0]);
    } else if (groups.length === 2) {
      symbols.push(groups[0] * 3 + groups[1]);
    }
    return symbols;
  }

  function descsumCreate(s) {
    const expanded = descsumExpand(s);
    if (expanded === null) throw new Error("invalid descriptor character");
    const symbols = expanded.concat([0, 0, 0, 0, 0, 0, 0, 0]);
    const checksum = descsumPolymod(symbols) ^ 1n;
    let out = s + "#";
    for (let i = 0; i < 8; i++) {
      const idx = Number((checksum >> (5n * BigInt(7 - i))) & 31n);
      out += CHECKSUM_CHARSET[idx];
    }
    return out;
  }

  // Taproot descriptor with BIP-380 checksum.
  function generateDescriptor(xpriv) {
    return descsumCreate(`tr(${xpriv}/0/0/0/0/<0;1>/*)`);
  }

  // ---- exports ---------------------------------------------------------------

  window.Frost = {
    SECP256K1_ORDER,
    NUM_WORDS,
    ShareBackupError,
    ShareBackup,
    computeWordsChecksum,
    computeShareImage,
    computePolyChecksum,
    verifyPolynomialChecksum,
    lagrangeCoefficientForDegree,
    reconstructPolynomialCommitment,
    lagrangeCoefficient,
    recoverSecret,
    generateXpriv,
    generateDescriptor,
    descsumCreate,
    CHECKSUM_CHARSET,
    INPUT_CHARSET,
    // helpers exposed for the UI / tests
    bytesToHex,
    hexToBytes,
  };
})();
