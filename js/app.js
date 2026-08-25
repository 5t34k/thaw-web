// UI wiring for the thaw recovery page. All computation happens in window.Frost;
// this file only manages the DOM.
(function () {
  "use strict";

  const F = window.Frost;
  const $ = (id) => document.getElementById(id);

  // inline icons
  const ICON = {
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/></svg>',
    idle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg>',
  };

  // ---- share rows ------------------------------------------------------------
  const sharesEl = $("shares");

  function makeShareRow() {
    const wrap = document.createElement("div");
    wrap.className = "share";
    wrap.innerHTML = `
      <div class="share-head">
        <span class="share-badge"><span class="idx">#?</span> Share</span>
        <button class="link-btn" type="button" data-remove>${ICON.trash} remove</button>
      </div>
      <textarea placeholder="#1 absurd amount doctor acoustic avoid letter advice cage ..." spellcheck="false" autocapitalize="characters" autocomplete="off"></textarea>
      <div class="share-status idle">${ICON.idle}<span>Waiting for input…</span></div>
    `;
    const ta = wrap.querySelector("textarea");
    const status = wrap.querySelector(".share-status");

    ta.addEventListener("input", () => validateShare(wrap, ta, status));
    wrap.querySelector("[data-remove]").addEventListener("click", () => {
      wrap.remove();
      updateRemoveButtons();
    });
    sharesEl.appendChild(wrap);
    updateRemoveButtons();
  }

  // keep at least one share row; hide the remove control when only one remains
  function updateRemoveButtons() {
    const rows = sharesEl.querySelectorAll(".share");
    rows.forEach((row) => {
      row.querySelector("[data-remove]").style.visibility =
        rows.length > 1 ? "visible" : "hidden";
    });
  }

  function setStatus(status, cls, icon, text) {
    status.className = "share-status " + cls;
    status.innerHTML = icon + "<span></span>";
    status.querySelector("span").textContent = text;
  }

  function validateShare(wrap, ta, status) {
    const val = ta.value.trim();
    const idx = wrap.querySelector(".idx");
    if (!val) {
      wrap.classList.remove("valid", "invalid");
      idx.textContent = "#?";
      setStatus(status, "idle", ICON.idle, "Waiting for input…");
      return null;
    }
    try {
      const share = F.ShareBackup.fromString(val);
      wrap.classList.remove("invalid");
      wrap.classList.add("valid");
      idx.textContent = "#" + share.index;
      setStatus(status, "ok", ICON.ok, "Checksum valid");
      return share;
    } catch (e) {
      wrap.classList.remove("valid");
      wrap.classList.add("invalid");
      idx.textContent = "#!";
      setStatus(status, "err", ICON.err, e.message);
      return null;
    }
  }

  $("addShare").addEventListener("click", makeShareRow);
  makeShareRow();
  makeShareRow();

  // ---- network toggle --------------------------------------------------------
  let network = "mainnet";
  $("network").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-net]");
    if (!btn) return;
    network = btn.dataset.net;
    $("network")
      .querySelectorAll("button")
      .forEach((b) => b.classList.toggle("active", b === btn));
  });

  // ---- recover ---------------------------------------------------------------
  const results = $("results");
  const recoverError = $("recoverError");

  function showError(msg) {
    results.classList.remove("show");
    recoverError.querySelector(".msg").textContent = msg;
    recoverError.classList.add("show");
  }

  $("recover").addEventListener("click", () => {
    recoverError.classList.remove("show");
    results.classList.remove("show");

    const rows = Array.from(sharesEl.querySelectorAll(".share"));
    const shares = [];
    let hadInput = false;
    for (const row of rows) {
      const ta = row.querySelector("textarea");
      const status = row.querySelector(".share-status");
      if (!ta.value.trim()) continue;
      hadInput = true;
      const share = validateShare(row, ta, status);
      if (!share) {
        showError("Fix the highlighted share(s) before recovering.");
        return;
      }
      shares.push(share);
    }

    if (!hadInput) {
      showError("Enter at least one share.");
      return;
    }

    let secret, xpriv, descriptor;
    try {
      secret = F.recoverSecret(shares);
      xpriv = F.generateXpriv(secret, network);
      descriptor = F.generateDescriptor(xpriv);
    } catch (e) {
      showError(e.message);
      return;
    }

    $("sharesUsed").textContent = shares.map((s) => "#" + s.index).join("  ");

    const secretBox = $("secretValue");
    secretBox.querySelector(".val").textContent = F.bytesToHex(secret);
    secretBox.classList.remove("revealed"); // re-blur on each recovery

    const xprivBox = $("xprivValue");
    xprivBox.querySelector(".val").textContent = xpriv;
    xprivBox.classList.remove("revealed"); // re-blur on each recovery

    const descriptorBox = $("descriptorValue");
    descriptorBox.querySelector(".val").textContent = descriptor;
    descriptorBox.classList.remove("revealed"); // re-blur on each recovery

    results.classList.add("show");
    if (results.scrollIntoView) {
      results.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  // ---- reveal / copy ---------------------------------------------------------
  function copyText(el) {
    const v = el.querySelector(".val");
    return v ? v.textContent : el.textContent;
  }

  document.addEventListener("click", (e) => {
    const revealCover = e.target.closest("[data-reveal]");
    if (revealCover) {
      $(revealCover.dataset.reveal).classList.add("revealed");
      return;
    }

    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) {
      const text = copyText($(copyBtn.dataset.copy));
      const done = () => {
        const original = copyBtn.innerHTML;
        copyBtn.classList.add("copied");
        copyBtn.textContent = "Copied";
        setTimeout(() => {
          copyBtn.classList.remove("copied");
          copyBtn.innerHTML = original;
        }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
      } else {
        fallbackCopy(text, done);
      }
    }
  });

  // clipboard API is often blocked over file:// - fall back to execCommand.
  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch (_) {
      /* ignore */
    }
    document.body.removeChild(ta);
  }
})();
