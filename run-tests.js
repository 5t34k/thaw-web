// Node harness: loads the browser classic-scripts with a minimal window shim
// and runs the same test suite the browser runs (tests.html). Lets CI / the
// terminal verify the app without a browser.
//
//   node run-tests.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

global.window = global.window || {};

const files = [
  "js/vendor/bip39-wordlist.js",
  "js/vendor/noble-secp256k1.js",
  "js/vendor/sha256.js",
  "js/frost.js",
  "js/tests.js",
];

for (const f of files) {
  const code = fs.readFileSync(path.join(__dirname, f), "utf8");
  vm.runInThisContext(code, { filename: f });
}

const { results, passed, failed, total } = window.runFrostTests();

let currentGroup = null;
for (const r of results) {
  if (r.group !== currentGroup) {
    currentGroup = r.group;
    console.log("\n" + currentGroup);
  }
  const mark = r.ok ? "  \x1b[32m✓\x1b[0m" : "  \x1b[31m✗\x1b[0m";
  console.log(`${mark} ${r.name}${r.ok ? "" : "  -> " + r.error}`);
}

console.log("\n" + "=".repeat(60));
if (failed === 0) {
  console.log(`\x1b[32mALL ${total} TESTS PASSED ✓\x1b[0m`);
} else {
  console.log(`\x1b[31m${failed}/${total} TESTS FAILED ✗\x1b[0m`);
}
console.log("=".repeat(60));

process.exit(failed === 0 ? 0 : 1);
