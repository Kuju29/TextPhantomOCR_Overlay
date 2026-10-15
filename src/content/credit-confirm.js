// Centered confirm box shown when Paid credits may not cover a translation
// run. The answer goes back to the background before anything is sent to AI.
(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  // Thai for a Thai browser or when Thai is the selected interface language.
  const thai = () => /^th\b/i.test(String(navigator.language || "")) || globalThis.TPPageText?.language === "th";
  const fmt = n => Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "?";
  const TEXT = {
    th: {
      title: "เครดิตอาจไม่พอ",
      body: e => `แปล ${fmt(e.images)} ภาพ ประมาณ ${fmt(e.estimateTp)} TP · คงเหลือ ${fmt(e.availableTp)} TP`,
      cover: e => `น่าจะพอสำหรับประมาณ ${fmt(e.coverableImages)} จาก ${fmt(e.images)} ภาพ`,
      basis: e => e.basis === "your_recent_usage" ? "ประมาณจากการใช้งานล่าสุดของคุณกับโมเดลนี้" : "ประมาณจากราคาโมเดล (ยังไม่มีประวัติการใช้งาน)",
      note: "ถ้าแปลต่อ ระบบจะแปลเท่าที่เครดิตพอ ภาพที่เหลือจะแสดงว่าเครดิตไม่พอ โดยไม่ส่ง AI และไม่หักเครดิต",
      yes: "แปลต่อ", no: "ยกเลิก",
    },
    en: {
      title: "Credits may not be enough",
      body: e => `${fmt(e.images)} images ≈ ${fmt(e.estimateTp)} TP · balance ${fmt(e.availableTp)} TP`,
      cover: e => `Probably enough for about ${fmt(e.coverableImages)} of ${fmt(e.images)} images`,
      basis: e => e.basis === "your_recent_usage" ? "Estimated from your recent use of this model." : "Estimated from the model price (no usage history yet).",
      note: "If you continue, images are translated while credits last. The rest show “not enough credits” — nothing is sent to AI or charged for them.",
      yes: "Continue", no: "Cancel",
    },
  };

  let open = null;
  function confirmPaidCredits(estimate) {
    if (open) return open;
    const t = TEXT[thai() ? "th" : "en"];
    open = new Promise(resolve => {
      const host = document.createElement("div");
      host.id = "tp-paid-credit-confirm";
      host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>
        .back{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;
          font:14px/1.5 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}
        .box{background:#fff;color:#1d1d1f;max-width:min(420px,calc(100vw - 32px));width:100%;border-radius:12px;
          box-shadow:0 12px 40px rgba(0,0,0,.35);padding:20px 22px;box-sizing:border-box}
        h2{margin:0 0 10px;font-size:17px}
        p{margin:6px 0} .muted{color:#5f6368;font-size:12.5px} .strong{font-weight:600}
        .row{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
        button{font:inherit;border-radius:8px;padding:8px 16px;cursor:pointer;border:1px solid #c7c7cc;background:#fff;color:#1d1d1f}
        button.yes{background:#0b57d0;border-color:#0b57d0;color:#fff}
        @media (prefers-color-scheme:dark){.box{background:#202124;color:#e8eaed}.muted{color:#9aa0a6}
          button{background:#303134;color:#e8eaed;border-color:#5f6368}}
      </style>
      <div class="back"><div class="box" role="alertdialog" aria-modal="true" aria-labelledby="t">
        <h2 id="t"></h2><p class="strong" id="b"></p><p id="c"></p><p class="muted" id="s"></p><p class="muted" id="n"></p>
        <div class="row"><button class="no" type="button"></button><button class="yes" type="button"></button></div>
      </div></div>`;
      root.getElementById("t").textContent = t.title;
      root.getElementById("b").textContent = t.body(estimate);
      root.getElementById("c").textContent = t.cover(estimate);
      root.getElementById("s").textContent = t.basis(estimate);
      root.getElementById("n").textContent = t.note;
      const yes = root.querySelector(".yes"), no = root.querySelector(".no");
      yes.textContent = t.yes; no.textContent = t.no;
      const finish = value => { document.removeEventListener("keydown", onKey, true); host.remove(); open = null; resolve(value); };
      const onKey = e => { if (e.key === "Escape") { e.preventDefault(); finish(false); } };
      yes.addEventListener("click", () => finish(true));
      no.addEventListener("click", () => finish(false));
      document.addEventListener("keydown", onKey, true);
      (document.body || document.documentElement).appendChild(host);
      no.focus();
    });
    return open;
  }
  TP.confirmPaidCredits = confirmPaidCredits;
})();
