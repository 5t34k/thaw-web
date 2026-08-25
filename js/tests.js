// Test suite for the FROST Backup Recovery web app.
//
// Ported 1:1 from test.py, which uses test vectors from the Rust reference
// implementation (frost_backup/tests/common/mod.rs). Runs in the browser
// (see tests.html) and under Node via a small window shim (see run-tests.js).
//
// Exposes window.runFrostTests() -> { results, passed, failed }.
(function () {
  "use strict";

  const F = window.Frost;
  const {
    ShareBackup,
    ShareBackupError,
    computeWordsChecksum,
    recoverSecret,
    generateXpriv,
    generateDescriptor,
    descsumCreate,
    CHECKSUM_CHARSET,
    bytesToHex,
    hexToBytes,
  } = F;

  // ---- test vectors (from frost_backup/tests/common/mod.rs) -----------------

  const TEST_SHARES_1_OF_1 = [
    "#1 ABSURD AMOUNT DOCTOR ACOUSTIC AVOID LETTER ADVICE CAGE ABSURD AMOUNT DOCTOR ACOUSTIC AVOID LETTER ADVICE CAGE ABSURD AMOUNT DOCTOR ACOUSTIC AVOID LETTER ADVICE CURTAIN SOON",
  ];
  const EXPECTED_SECRET_1_OF_1 =
    "0101010101010101010101010101010101010101010101010101010101010101";

  const TEST_SHARES_2_OF_3 = [
    "#1 MUTUAL JEANS SNAP STING BLESS JOURNEY MORAL BREAD ROOM LIMIT DOSE GRAVITY SORT DELIVER OUTDOOR RIPPLE DONKEY BLOUSE PLAY CART CENTURY MAXIMUM MAKE LOCAL MOBILE",
    "#2 CASH TRASH FOIL PREFER BUTTER IDEA BRAVE BITTER ITEM WINK DRIFT SMILE TOMATO LUNCH OPTION HERO THREE ENGINE BLESS MANAGE HORSE JAR ADVICE SHERIFF BUSINESS",
    "#3 REGION FINISH TRAVEL LAUNDRY CHEAP HAIR PLUNGE BANANA CRACK INTEREST DURING COTTON PHONE DISAGREE CRUNCH AIRPORT CANCEL FOLD LAUNDRY PONY LOBSTER LENS MAMMAL CLOTH FINGER",
  ];
  const EXPECTED_SECRET_2_OF_3 =
    "0101010101010101010101010101010101010101010101010101010101010101";

  const TEST_SHARES_3_OF_5 = [
    "#1 DUTCH GLAD TORCH EXACT PROGRAM GRASS CLUB SCRAP MUSCLE TUITION TISSUE CLERK SEA SUMMER SHIP VERY FREQUENT DIAL SYRUP MAMMAL SIMILAR MISERY PLAY RING ARM",
    "#2 SUGAR GENERAL PARK VOYAGE CREEK FLY MOTOR ALWAYS WAVE SUNNY WARRIOR DIAMOND WAVE SUNSET ANY LEFT LIGHT FLOAT VAULT GENUINE ELBOW TENNIS BECOME TABLE CLAIM",
    "#3 ORANGE HAMMER UNFOLD REFUSE IMMUNE FAVORITE POET MEDIA CARRY SEGMENT PULL BRUSH DAMAGE ADDRESS FILE PORTION UNFOLD BLAST ACCOUNT NATION TELL BELT DENY ABILITY FOOD",
    "#4 MIRACLE KETCHUP SLIM MAZE GUESS FEBRUARY IDLE ENDORSE BARELY POLAR AGAIN SIBLING CLARIFY SHELL EAGER FISCAL DISTANCE FEW ABOVE SURE FRAME ENFORCE BUTTER MORNING ZOO",
    "#5 PUMPKIN NEUTRAL DESTROY INSTALL BEHAVE FOLD UNDER EAST SHORT MAGNET WORLD DEVICE SPECIAL BUYER STONE MILLION JUNIOR BEAN UPON CRYSTAL SCENE LEARN SEARCH GALAXY SUMMER",
  ];
  const EXPECTED_SECRET_3_OF_5 =
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

  // TEST_SHARES_2_OF_3[0] with last word "MOBILE" -> "ABANDON".
  const INVALID_SHARE_CHECKSUM =
    "#1 MUTUAL JEANS SNAP STING BLESS JOURNEY MORAL BREAD ROOM LIMIT DOSE GRAVITY SORT DELIVER OUTDOOR RIPPLE DONKEY BLOUSE PLAY CART CENTURY MAXIMUM MAKE LOCAL ABANDON";

  // ---- tiny test harness -----------------------------------------------------

  const tests = [];
  const test = (group, name, fn) => tests.push({ group, name, fn });

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || "assertion failed");
  }
  function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error(
        (msg ? msg + ": " : "") + `expected ${expected}, got ${actual}`
      );
    }
  }
  function assertThrows(fn, matchSubstr, msg) {
    let threw = false;
    try {
      fn();
    } catch (e) {
      threw = true;
      if (matchSubstr && !String(e.message).includes(matchSubstr)) {
        throw new Error(
          (msg ? msg + ": " : "") +
            `error message '${e.message}' does not contain '${matchSubstr}'`
        );
      }
    }
    if (!threw) {
      throw new Error((msg ? msg + ": " : "") + "expected an error but none thrown");
    }
  }
  const hex = (bytes) => bytesToHex(bytes);

  // ---- TestShareParsing ------------------------------------------------------

  test("Share parsing", "parse valid share (1-of-1)", () => {
    const s = ShareBackup.fromString(TEST_SHARES_1_OF_1[0]);
    assertEqual(s.index, 1);
    assertEqual(s.scalarBytes.length, 32);
  });

  test("Share parsing", "parse valid shares (2-of-3)", () => {
    TEST_SHARES_2_OF_3.forEach((str, i) => {
      const s = ShareBackup.fromString(str);
      assertEqual(s.index, i + 1);
      assertEqual(s.scalarBytes.length, 32);
    });
  });

  test("Share parsing", "parse valid shares (3-of-5)", () => {
    TEST_SHARES_3_OF_5.forEach((str, i) => {
      const s = ShareBackup.fromString(str);
      assertEqual(s.index, i + 1);
      assertEqual(s.scalarBytes.length, 32);
    });
  });

  test("Share parsing", "invalid checksum rejected", () => {
    assertThrows(
      () => ShareBackup.fromString(INVALID_SHARE_CHECKSUM),
      "Words checksum failed"
    );
  });

  test("Share parsing", "invalid format (no #) rejected", () => {
    assertThrows(() => ShareBackup.fromString("1 WORD WORD WORD"), "Invalid format");
  });

  test("Share parsing", "wrong word count rejected", () => {
    assertThrows(
      () => ShareBackup.fromString("#1 WORD WORD WORD"),
      "Expected 25 words"
    );
  });

  test("Share parsing", "non-BIP39 word rejected", () => {
    const invalid = "#1 " + Array(25).fill("INVALID").join(" ");
    assertThrows(() => ShareBackup.fromString(invalid), "not in BIP39 wordlist");
  });

  test("Share parsing", "share index 0 rejected", () => {
    assertThrows(
      () => new ShareBackup(0, new Uint8Array(32), 0),
      "index cannot be 0"
    );
  });

  // ---- TestSecretRecovery ----------------------------------------------------

  const parse = (arr) => arr.map((s) => ShareBackup.fromString(s));

  test("Secret recovery", "recover 1-of-1", () => {
    assertEqual(hex(recoverSecret(parse(TEST_SHARES_1_OF_1))), EXPECTED_SECRET_1_OF_1);
  });

  test("Secret recovery", "recover 2-of-3 (shares 1,2)", () => {
    assertEqual(
      hex(recoverSecret(parse(TEST_SHARES_2_OF_3.slice(0, 2)))),
      EXPECTED_SECRET_2_OF_3
    );
  });

  test("Secret recovery", "recover 2-of-3 (shares 1,3)", () => {
    assertEqual(
      hex(recoverSecret(parse([TEST_SHARES_2_OF_3[0], TEST_SHARES_2_OF_3[2]]))),
      EXPECTED_SECRET_2_OF_3
    );
  });

  test("Secret recovery", "recover 2-of-3 (shares 2,3)", () => {
    assertEqual(
      hex(recoverSecret(parse(TEST_SHARES_2_OF_3.slice(1)))),
      EXPECTED_SECRET_2_OF_3
    );
  });

  test("Secret recovery", "recover 3-of-5 (shares 1,2,3)", () => {
    assertEqual(
      hex(recoverSecret(parse(TEST_SHARES_3_OF_5.slice(0, 3)))),
      EXPECTED_SECRET_3_OF_5
    );
  });

  test("Secret recovery", "recover 3-of-5 (shares 3,4,5)", () => {
    assertEqual(
      hex(recoverSecret(parse(TEST_SHARES_3_OF_5.slice(2)))),
      EXPECTED_SECRET_3_OF_5
    );
  });

  test("Secret recovery", "recover 3-of-5 (shares 1,3,5)", () => {
    assertEqual(
      hex(
        recoverSecret(
          parse([TEST_SHARES_3_OF_5[0], TEST_SHARES_3_OF_5[2], TEST_SHARES_3_OF_5[4]])
        )
      ),
      EXPECTED_SECRET_3_OF_5
    );
  });

  test("Secret recovery", "empty shares fails", () => {
    assertThrows(() => recoverSecret([]), "No shares provided");
  });

  test("Secret recovery", "duplicate indices fails", () => {
    const shares = [
      ShareBackup.fromString(TEST_SHARES_2_OF_3[0]),
      ShareBackup.fromString(TEST_SHARES_2_OF_3[0]),
    ];
    assertThrows(() => recoverSecret(shares), "Duplicate share indices");
  });

  test("Secret recovery", "mismatched wallets fail (poly checksum)", () => {
    const mixed = [
      ShareBackup.fromString(TEST_SHARES_2_OF_3[0]),
      ShareBackup.fromString(TEST_SHARES_3_OF_5[1]),
    ];
    assertThrows(() => recoverSecret(mixed), "Polynomial checksum failed");
  });

  // ---- TestBitcoinOutputs ----------------------------------------------------

  test("Bitcoin outputs", "xpriv generation (mainnet)", () => {
    const xpriv = generateXpriv(hexToBytes(EXPECTED_SECRET_1_OF_1), "mainnet");
    assert(xpriv.startsWith("xprv"), "should start with xprv");
    assert(xpriv.length > 100, "should be ~110 chars");
  });

  test("Bitcoin outputs", "xpriv generation (testnet)", () => {
    const xpriv = generateXpriv(hexToBytes(EXPECTED_SECRET_1_OF_1), "testnet");
    assert(xpriv.startsWith("tprv"), "should start with tprv");
    assert(xpriv.length > 100, "should be ~110 chars");
  });

  test("Bitcoin outputs", "xpriv deterministic", () => {
    const a = generateXpriv(hexToBytes(EXPECTED_SECRET_1_OF_1), "mainnet");
    const b = generateXpriv(hexToBytes(EXPECTED_SECRET_1_OF_1), "mainnet");
    assertEqual(a, b);
  });

  test("Bitcoin outputs", "descriptor format", () => {
    const xpriv = generateXpriv(hexToBytes(EXPECTED_SECRET_1_OF_1), "mainnet");
    const d = generateDescriptor(xpriv);
    assert(d.startsWith("tr("), "starts with tr(");
    assert(d.includes("/0/0/0/0/<0;1>/*"), "has derivation path");
    assert(d.includes(xpriv), "contains xpriv");
    assertEqual(d[d.length - 9], "#", "checksum separator");
    assert(
      d.slice(-8).split("").every((c) => CHECKSUM_CHARSET.includes(c)),
      "checksum chars valid"
    );
  });

  test("Bitcoin outputs", "descriptor deterministic", () => {
    const xpriv = generateXpriv(hexToBytes(EXPECTED_SECRET_1_OF_1), "mainnet");
    assertEqual(generateDescriptor(xpriv), generateDescriptor(xpriv));
  });

  test("Bitcoin outputs", "golden vector: exact xpriv + descriptor", () => {
    const xpriv = generateXpriv(hexToBytes(EXPECTED_SECRET_1_OF_1), "mainnet");
    assertEqual(
      xpriv,
      "xprv9s21ZrQH143K24Mfq5zL5MhWK9hUhhGbd45hLXo2Pq2oqzMMo63oStZzF" +
        "93yjHmmfwkTW7jWmaf7X9aF3GP9D3mXSChQcm2zAZG6kerWdMw"
    );
    assertEqual(
      generateDescriptor(xpriv),
      "tr(xprv9s21ZrQH143K24Mfq5zL5MhWK9hUhhGbd45hLXo2Pq2oqzMMo63oStZzF" +
        "93yjHmmfwkTW7jWmaf7X9aF3GP9D3mXSChQcm2zAZG6kerWdMw/0/0/0/0/<0;1>/*)" +
        "#5g5wtnwn"
    );
  });

  // ---- TestDescriptorChecksum ------------------------------------------------

  test("Descriptor checksum", "BIP-380 published vector", () => {
    assertEqual(descsumCreate("raw(deadbeef)"), "raw(deadbeef)#89f8spxm");
  });

  test("Descriptor checksum", "generated descriptor carries valid checksum", () => {
    const xpriv = generateXpriv(hexToBytes(EXPECTED_SECRET_2_OF_3), "mainnet");
    const d = generateDescriptor(xpriv);
    const hashIdx = d.lastIndexOf("#");
    const body = d.slice(0, hashIdx);
    const checksum = d.slice(hashIdx + 1);
    assert(body.length > 0 && checksum.length === 8, "shape");
    assert(
      checksum.split("").every((c) => CHECKSUM_CHARSET.includes(c)),
      "charset"
    );
    assertEqual(descsumCreate(body), d, "recompute matches");
  });

  // ---- TestEndToEnd ----------------------------------------------------------

  test("End-to-end", "full recovery 1-of-1", () => {
    const secret = recoverSecret(parse(TEST_SHARES_1_OF_1));
    assertEqual(hex(secret), EXPECTED_SECRET_1_OF_1);
    const xpriv = generateXpriv(secret, "mainnet");
    assert(xpriv.startsWith("xprv"), "xprv");
    assert(generateDescriptor(xpriv).includes("tr("), "descriptor");
  });

  test("End-to-end", "full recovery 2-of-3", () => {
    const secret = recoverSecret(parse(TEST_SHARES_2_OF_3.slice(0, 2)));
    assertEqual(hex(secret), EXPECTED_SECRET_2_OF_3);
    const xpriv = generateXpriv(secret, "mainnet");
    assert(xpriv.startsWith("xprv"), "xprv");
    assert(generateDescriptor(xpriv).includes("tr("), "descriptor");
  });

  test("End-to-end", "full recovery 3-of-5", () => {
    const secret = recoverSecret(parse(TEST_SHARES_3_OF_5.slice(0, 3)));
    assertEqual(hex(secret), EXPECTED_SECRET_3_OF_5);
    const xpriv = generateXpriv(secret, "mainnet");
    assert(xpriv.startsWith("xprv"), "xprv");
    assert(generateDescriptor(xpriv).includes("tr("), "descriptor");
  });

  test("End-to-end", "different share combos yield same secret", () => {
    const c1 = recoverSecret(parse(TEST_SHARES_2_OF_3.slice(0, 2)));
    const c2 = recoverSecret(
      parse([TEST_SHARES_2_OF_3[0], TEST_SHARES_2_OF_3[2]])
    );
    const c3 = recoverSecret(parse(TEST_SHARES_2_OF_3.slice(1)));
    assertEqual(hex(c1), hex(c2));
    assertEqual(hex(c2), hex(c3));
    assertEqual(hex(c1), EXPECTED_SECRET_2_OF_3);
  });

  // ---- TestWordsChecksum -----------------------------------------------------

  test("Words checksum", "checksum in range", () => {
    const c = computeWordsChecksum(1, new Uint8Array(32), 0);
    assert(c >= 0 && c < 2048, "0 <= checksum < 2048");
  });

  test("Words checksum", "different inputs differ", () => {
    const c1 = computeWordsChecksum(1, new Uint8Array(32), 0);
    const s2 = new Uint8Array(32);
    s2[0] = 1;
    const c2 = computeWordsChecksum(1, s2, 0);
    assert(c1 !== c2, "should differ");
  });

  // ---- runner ----------------------------------------------------------------

  function runFrostTests() {
    const results = [];
    let passed = 0;
    let failed = 0;
    for (const t of tests) {
      try {
        t.fn();
        results.push({ group: t.group, name: t.name, ok: true });
        passed++;
      } catch (e) {
        results.push({ group: t.group, name: t.name, ok: false, error: e.message });
        failed++;
      }
    }
    return { results, passed, failed, total: tests.length };
  }

  window.runFrostTests = runFrostTests;
})();
