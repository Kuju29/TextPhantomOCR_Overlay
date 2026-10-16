/**
 * The one consent screen (10494, layout 10495), drawn inside an extension page
 * (popup, support chat, account page, guide or the consent tab). Its text is the
 * SUMMARY in shared/privacy-content.js — the same text the user guide's
 * "Privacy & data" tab shows. One "Allow" covers Paid, Login and chat with the
 * admin; "Don't allow" sends nothing.
 */
import './privacy-content.js';
import { hasDataConsent, requestDataConsent, onDataConsentChanged } from './data-consent.js';

const PRIVACY = globalThis.TPPrivacyContent;

// Last known answer, for click handlers that must ask the browser for a
// permission synchronously (Firefox loses the user action after an await).
let known = null;
export const dataConsentKnown = () => known;
export async function refreshDataConsent() {
  try { known = await hasDataConsent(); } catch { known = false; }
  return known;
}
try {
  if (globalThis.chrome?.runtime?.id) { void refreshDataConsent(); onDataConsentChanged(() => void refreshDataConsent()); }
} catch {}

// Summary + messages per language (both authored in privacy-content.js).
export const CONSENT_TEXT = Object.freeze({
  en: Object.freeze({ ...PRIVACY.SUMMARY.en, ...PRIVACY.MESSAGES.en }),
  th: Object.freeze({ ...PRIVACY.SUMMARY.th, ...PRIVACY.MESSAGES.th }),
});

export async function consentLanguage() {
  try {
    const area = globalThis.chrome?.storage?.local;
    const values = await new Promise(resolve => {
      const returned = area.get('uiLanguageV1', value => resolve(value || {}));
      if (returned && typeof returned.then === 'function') returned.then(value => resolve(value || {}), () => resolve({}));
    });
    return values?.uiLanguageV1 === 'th' ? 'th' : 'en';
  } catch { return 'en'; }
}

export async function consentText(key) {
  return CONSENT_TEXT[await consentLanguage()][key];
}

/** Open the guide's Privacy & data tab in a new tab. */
export function openPrivacyDetails(lang = 'en') {
  const path = PRIVACY.GUIDE_PRIVACY_PATH.replace('#privacy', `?lang=${lang}#privacy`);
  let url = path;
  try { url = globalThis.chrome?.runtime?.getURL?.(path) || path; } catch {}
  try {
    if (globalThis.chrome?.tabs?.create) { globalThis.chrome.tabs.create({ url }, () => void globalThis.chrome.runtime?.lastError); return; }
  } catch {}
  globalThis.open?.(url, '_blank', 'noopener');
}

const STYLE = `
.tp-consent{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;
  padding:12px;background:rgba(5,8,16,.72);font:13px/1.5 var(--tp-font,system-ui,sans-serif);color:var(--tp-text,#e9edfa);box-sizing:border-box}
.tp-consent *{box-sizing:border-box}
.tp-consent-card{width:min(100%,380px);max-width:100%;max-height:100%;overflow-y:auto;overflow-x:hidden;padding:16px;
  border-radius:var(--tp-radius,14px);background:var(--tp-surface,#121828);border:1px solid var(--tp-line-2,rgba(255,255,255,.16));
  box-shadow:0 18px 48px rgba(0,0,0,.45);overflow-wrap:anywhere}
.tp-consent h2{margin:0 0 10px;font-size:16px;line-height:1.3}
.tp-consent h3{margin:10px 0 4px;font-size:13px;font-weight:700;line-height:1.35}
.tp-consent ul{margin:0 0 4px;padding-left:18px}
.tp-consent li{margin:0 0 5px}
.tp-consent-note{margin:10px 0 0;padding:8px 10px;border-radius:var(--tp-radius-sm,9px);background:var(--tp-surface-2,#1a2238)}
.tp-consent-foot{margin:10px 0 0;color:var(--tp-muted,#8d97b3);font-size:12px}
.tp-consent-foot a{color:var(--tp-accent,#9db7ff);text-decoration:underline;cursor:pointer}
.tp-consent-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}
.tp-consent button{width:100%;min-height:38px;padding:0 10px;border-radius:var(--tp-radius-sm,9px);font:inherit;font-weight:700;cursor:pointer;
  border:1px solid var(--tp-line-2,rgba(255,255,255,.22));background:var(--tp-surface-2,#1a2238);color:inherit}
.tp-consent button.tp-consent-allow{border-color:transparent;background:var(--tp-grad,linear-gradient(135deg,#7c5cff,#4da3ff));color:#fff}
.tp-consent button:focus-visible{outline:none;box-shadow:var(--tp-focus,0 0 0 3px rgba(124,92,255,.35))}
.tp-consent button:disabled{opacity:.6;cursor:default}
.tp-consent[data-page]{position:static;min-height:100vh;background:var(--tp-bg,#0a0d18)}
`;

let open = null;

/**
 * Build the summary block (title, the two groups, note, foot) for `lang`.
 * Shared by the dialog and by tests that compare it with the guide.
 */
export function renderConsentSummary(doc, lang, { onDetails = null } = {}) {
  const text = PRIVACY.summary(lang);
  const node = (tag, value, attrs = {}) => { const el = doc.createElement(tag); el.textContent = value; for (const [k, v] of Object.entries(attrs)) el[k] = v; return el; };
  const parts = [node('h2', text.title, { id: 'tp-consent-title' })];
  for (const group of PRIVACY.SUMMARY_GROUPS) {
    parts.push(node('h3', text[group.heading], { className: 'tp-consent-' + group.heading }));
    const list = doc.createElement('ul');
    for (const key of group.items) list.append(node('li', text[key], { className: 'tp-consent-' + key }));
    parts.push(list);
  }
  parts.push(node('p', text.note, { className: 'tp-consent-note' }));
  const foot = node('p', text.foot + ' · ', { className: 'tp-consent-foot' });
  const link = node('a', text.link, { className: 'tp-consent-details', id: 'tp-consent-details', href: '#' });
  link.addEventListener('click', event => { event.preventDefault?.(); (onDetails || (() => openPrivacyDetails(lang)))(); });
  foot.append(link);
  parts.push(foot);
  return parts;
}

/**
 * Show the consent screen. `permissions` (e.g. ['cookies'] for Login) are asked
 * in the same click as the consent. `delegate` replaces the Allow action where
 * this page cannot ask itself (Firefox dock: opens the consent tab).
 * @returns {Promise<{consent:boolean, permissions:boolean, shown:boolean}>}
 */
export function openDataConsentDialog({ permissions = [], doc = globalThis.document, delegate = null, page = false, lang = null } = {}) {
  if (open) return open;
  open = (async () => {
    const language = lang === 'th' || lang === 'en' ? lang : await consentLanguage(), text = CONSENT_TEXT[language];
    return new Promise(resolve => {
      if (!doc.getElementById('tp-consent-style')) {
        const style = doc.createElement('style'); style.id = 'tp-consent-style'; style.textContent = STYLE;
        (doc.head || doc.documentElement).append(style);
      }
      const root = doc.createElement('div');
      root.className = 'tp-consent'; root.id = 'tp-data-consent';
      if (page) root.dataset.page = '';
      root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'tp-consent-title');
      root.dataset.lang = language;
      // Thai is authored; keep the interface translator away from it.
      if (language === 'th') { root.setAttribute('translate', 'no'); root.lang = 'th'; }
      const card = doc.createElement('div'); card.className = 'tp-consent-card';
      const button = (label, className, id) => { const el = doc.createElement('button'); el.type = 'button'; el.textContent = label; el.className = className; el.id = id; return el; };
      const later = button(text.later, 'tp-consent-later', 'tp-consent-later');
      const allow = button(text.allow, 'tp-consent-allow', 'tp-consent-allow');
      const actions = doc.createElement('div'); actions.className = 'tp-consent-actions'; actions.append(later, allow);
      card.append(...renderConsentSummary(doc, language), actions);
      root.append(card);
      let settled = false;
      const finish = result => {
        if (settled) return; settled = true;
        root.remove(); doc.removeEventListener('keydown', onKey, true); open = null;
        if (result.consent) known = true;
        resolve({ ...result, shown: true });
      };
      const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); finish({ consent: false, permissions: false }); } };
      allow.addEventListener('click', () => {
        // Synchronous: the browser prompt (Firefox data collection, cookies)
        // needs this click. Nothing above awaits before the request starts.
        allow.disabled = later.disabled = true;
        let asked;
        try { asked = delegate ? delegate() : requestDataConsent({ permissions }); }
        catch { asked = { consent: false, permissions: false }; }
        Promise.resolve(asked).then(finish, () => finish({ consent: false, permissions: false }));
      });
      later.addEventListener('click', () => finish({ consent: false, permissions: false }));
      doc.addEventListener('keydown', onKey, true);
      (doc.body || doc.documentElement).append(root);
      allow.focus?.();
    });
  })();
  return open;
}

/** Consent already given → {consent:true, shown:false}; otherwise the screen. */
export async function ensureDataConsent(options = {}) {
  if (await hasDataConsent()) return { consent: true, permissions: null, shown: false };
  return openDataConsentDialog(options);
}
