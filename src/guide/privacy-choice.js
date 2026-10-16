/**
 * "Your choice" in the guide's Privacy & data tab (10495). Only inside the
 * extension (chrome.runtime.id): the current status, "Allow" when not allowed
 * and a small, quiet "Revoke" when allowed (an in-extension way to withdraw).
 *
 * Allow calls the consent request synchronously in the click (Firefox shows
 * its data-collection prompt only for a user action). Revoke stops account
 * work at once (shared/account-gate.js); finished translations stay.
 */
import '../shared/privacy-content.js';
import { requestDataConsent } from '../shared/data-consent.js';
import { refreshAccountGate, revokeAccountConsent, onAccountGateChanged } from '../shared/account-gate.js';

const P = globalThis.TPPrivacyContent;
let allowed = null, busy = false;

function lang() { return globalThis.TPPrivacyGuide?.lang || 'en'; }

function render() {
  const body = document.getElementById('privacy-choice-body');
  if (!body || allowed === null) return;
  const labels = P.guide(lang());
  const status = document.createElement('span');
  status.className = 'choice-status'; status.id = 'privacy-choice-status';
  status.dataset.allowed = String(allowed);
  status.textContent = labels.status + ': ' + (allowed ? labels.allowed : labels.notAllowed);
  status.setAttribute('role', 'status');
  const parts = [status];
  if (!allowed) {
    const allow = document.createElement('button');
    allow.type = 'button'; allow.className = 'choice-allow'; allow.id = 'privacy-choice-allow';
    allow.textContent = labels.allow; allow.disabled = busy;
    allow.addEventListener('click', () => {
      if (busy) return;
      busy = true; allow.disabled = true;
      // Synchronous: no await before the browser permission request.
      const asked = requestDataConsent();
      Promise.resolve(asked).finally(async () => { busy = false; allowed = await refreshAccountGate(); render(); });
    });
    parts.push(allow);
  } else {
    const revoke = document.createElement('button');
    revoke.type = 'button'; revoke.className = 'choice-revoke'; revoke.id = 'privacy-choice-revoke';
    revoke.textContent = labels.revoke; revoke.disabled = busy;
    revoke.addEventListener('click', async () => {
      if (busy) return;
      busy = true; revoke.disabled = true;
      try { await revokeAccountConsent(); } finally { busy = false; allowed = await refreshAccountGate(); render(); }
    });
    parts.push(revoke);
    const note = document.createElement('p'); note.className = 'choice-note'; note.textContent = labels.revokeNote;
    parts.push(note);
  }
  body.replaceChildren(...parts);
}

if (globalThis.chrome?.runtime?.id) {
  allowed = await refreshAccountGate();
  render();
  document.addEventListener('tp-privacy-lang', render);
  onAccountGateChanged(async detail => { if (detail?.reason === 'session') return; allowed = detail?.consent === true; render(); });
}
