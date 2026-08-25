# thaw - FROST Backup Recovery (Web App)

> **Unofficial, community-built tool - not affiliated with or endorsed by
> Frostsnap.** It is an independent web port of the official recovery script,
> [`frostsnap-thaw`](https://github.com/frostsnap/frostsnap-thaw).

[Try the thaw-web tool.](https://thaw.5t34k.com).

A **100% client-side** browser version of the official [`frostsnap-thaw`](https://github.com/frostsnap/frostsnap-thaw)
emergency recovery tool. It reconstructs a Bitcoin wallet **xpriv** and
**descriptor** from your Frostsnap backup shares, so you can recover funds if
the Frostsnap app is unavailable.

> ⚠️ **Emergency use only.** This tool reconstructs your full secret key and
> displays it on screen. This secret allows all funds to be swept. Only
> run it on a fresh, air-gapped, offline machine you trust. Wipe the machine
> when done.

## Running it offline

1. Copy this whole folder onto an offline machine (USB stick, etc.).
2. Double-click **`index.html`** to open it in any modern browser.


## Usage

1. **Enter your shares** - one per box, in the format `#<index> <25 words>`.
   Enter your threshold number of shares (e.g. 2 shares for a 2-of-3 wallet).
   Each share is checksum-verified as you type.
2. **Pick the network** (mainnet for real bitcoin).
3. **Recover** - the app derives the secret, xpriv, and descriptor.

The secret is blurred by default; click **Reveal** to show it.

## Importing into a wallet

The **descriptor** is the complete recovery artifact: it encodes the key, the
Taproot script type, and the derivation path, and carries its own checksum.
Import it into any descriptor-aware wallet.


## What it implements

Identical logic to the Python tool (`frost_backup` spec v0):

- **Share parsing** with the 11-bit BIP-39 words checksum (catches
  transcription errors).
- **Secret recovery** via Lagrange interpolation in the secp256k1 scalar field.
- **Polynomial checksum verification** - reconstructs the polynomial commitment
  from share images and confirms all shares belong to the same wallet.
- **BIP-32 xpriv** generation (base58check).
- **BIP-380 Taproot descriptor** with checksum.

## Project layout

```
index.html                     recovery UI
tests.html                     in-browser test runner (32 tests)
css/styles.css                 styling (dark + light)
js/frost.js                    core recovery logic (port of the .py)
js/app.js                      UI wiring
js/tests.js                    test suite + vectors
js/vendor/noble-secp256k1.js   @noble/secp256k1 (audited EC math), vendored
js/vendor/sha256.js            self-contained SHA-256
js/vendor/bip39-wordlist.js    BIP-39 English wordlist (2048 words)
run-tests.js                   run the same suite from the terminal (Node, no deps)
```

## Cryptography / trust notes

- **secp256k1** point arithmetic uses Paul Miller's audited
  [`@noble/secp256k1`](https://github.com/paulmillr/noble-secp256k1) (v2.2.3),
  vendored unchanged except that its final ESM `export` line is replaced with a
  global assignment so it loads as a classic script from `file://`.
- **SHA-256** is a compact self-contained implementation
  (`js/vendor/sha256.js`); its correctness is pinned by the golden-vector,
  words-checksum, and polynomial-checksum tests.
- **BIP-39 wordlist** is the canonical English list (sha256
  `2f5eed53…24dbda`), vendored from `@scure/bip39`.


