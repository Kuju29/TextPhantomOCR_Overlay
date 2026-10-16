/**
 * Tools › Advanced › "Send diagnostic logs to the API server" (10495).
 * Default off. Turning it ON asks first (default focus: Cancel); turning it
 * off needs no confirmation. Firefox/Thunderbird: the technicalAndInteraction
 * permission is requested synchronously inside the confirm button's click.
 * The wording is authored in shared/privacy-content.js (Thai and English).
 */
import "../../shared/privacy-content.js";
import { readDiagnosticsUpload, writeDiagnosticsUpload } from "../../shared/settings.js";
import { consentLanguage } from "../../shared/data-consent-dialog.js";

const STYLE = `
.tp-diag-confirm{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:12px;
  background:rgba(5,8,16,.72);font:13px/1.5 var(--tp-font,system-ui,sans-serif);color:var(--tp-text,#e9edfa);box-sizing:border-box}
.tp-diag-confirm *{box-sizing:border-box}
.tp-diag-card{width:min(100%,360px);max-height:100%;overflow-y:auto;overflow-x:hidden;padding:16px;border-radius:var(--tp-radius,14px);
  background:var(--tp-surface,#121828);border:1px solid var(--tp-line-2,rgba(255,255,255,.16));box-shadow:0 18px 48px rgba(0,0,0,.45);overflow-wrap:anywhere}
.tp-diag-card h2{margin:0 0 8px;font-size:15px;line-height:1.3}
.tp-diag-card p{margin:0}
.tp-diag-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}
.tp-diag-actions button{width:100%;min-height:36px;padding:0 10px;border-radius:var(--tp-radius-sm,9px);font:inherit;font-weight:700;cursor:pointer;
  border:1px solid var(--tp-line-2,rgba(255,255,255,.22));background:var(--tp-surface-2,#1a2238);color:inherit}
.tp-diag-actions button:focus-visible{outline:none;box-shadow:var(--tp-focus,0 0 0 3px rgba(124,92,255,.35))}
`;

/**
 * Show the confirmation. `onConfirm` runs synchronously inside the confirm
 * button's click (the browser permission prompt needs that click).
 * @returns {Promise<boolean>} true when confirmed
 */
export function confirmDiagnostics({ doc = document, lang = "en", onConfirm = () => {} } = {}) {
  const text = globalThis.TPPrivacyContent.diagnostics(lang);
  return new Promise(resolve => {
    if (!doc.getElementById("tp-diag-confirm-style")) {
      const style = doc.createElement("style"); style.id = "tp-diag-confirm-style"; style.textContent = STYLE;
      (doc.head || doc.documentElement).append(style);
    }
    const root = doc.createElement("div");
    root.className = "tp-diag-confirm"; root.id = "tp-diag-confirm";
    root.setAttribute("role", "alertdialog"); root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "tp-diag-title"); root.setAttribute("aria-describedby", "tp-diag-body");
    root.dataset.lang = lang;
    if (lang === "th") { root.setAttribute("translate", "no"); root.lang = "th"; }
    const card = doc.createElement("div"); card.className = "tp-diag-card";
    const title = doc.createElement("h2"); title.id = "tp-diag-title"; title.textContent = text.title;
    const body = doc.createElement("p"); body.id = "tp-diag-body"; body.textContent = text.body;
    const cancel = doc.createElement("button"); cancel.type = "button"; cancel.id = "tp-diag-cancel"; cancel.textContent = text.cancel;
    const confirm = doc.createElement("button"); confirm.type = "button"; confirm.id = "tp-diag-confirm-on"; confirm.textContent = text.confirm;
    const actions = doc.createElement("div"); actions.className = "tp-diag-actions"; actions.append(cancel, confirm);
    card.append(title, body, actions); root.append(card);
    let done = false;
    const finish = value => {
      if (done) return; done = true;
      root.remove(); doc.removeEventListener("keydown", onKey, true); resolve(value);
    };
    const onKey = event => { if (event.key === "Escape") { event.preventDefault(); finish(false); } };
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => {
      // Synchronous: no await before the permission request.
      try { onConfirm(); } finally { finish(true); }
    });
    doc.addEventListener("keydown", onKey, true);
    (doc.body || doc.documentElement).append(root);
    cancel.focus?.();
  });
}

export function createDiagnosticsController({ doc = document, el = doc.getElementById("diagnostics-upload"),
  read = readDiagnosticsUpload, write = writeDiagnosticsUpload, language = consentLanguage } = {}) {
  let busy = false, disposed = false;
  const settle = promise => Promise.resolve(promise)
    .then(on => { if (!disposed && el) el.checked = on === true; },
      () => read().then(on => { if (!disposed && el) el.checked = on === true; }, () => { if (el) el.checked = false; }))
    .finally(() => { busy = false; if (el) el.disabled = false; });
  async function onChange() {
    if (!el || busy) { if (el) el.checked = !el.checked; return; }
    if (!el.checked) {
      // Turning off: no confirmation.
      busy = true; el.disabled = true;
      await settle(write(false));
      return;
    }
    // Turning on: stays off until the user confirms.
    el.checked = false; busy = true; el.disabled = true;
    let pending = null;
    const confirmed = await confirmDiagnostics({ doc, lang: await language(),
      onConfirm: () => { pending = write(true); } });
    if (disposed) return;
    if (!confirmed || !pending) { busy = false; el.disabled = false; el.checked = false; el.focus?.(); return; }
    await settle(pending);
  }
  el?.addEventListener("change", onChange);
  async function initialize() { if (el) el.checked = await read().catch(() => false); }
  function dispose() { disposed = true; el?.removeEventListener("change", onChange); }
  return { initialize, dispose };
}
