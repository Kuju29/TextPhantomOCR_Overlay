import { createSupportClient, supportScopeId } from './client.js';
import { activateSupport } from './visibility.js';
import { accountState, onAccountGateChanged } from '../shared/account-gate.js';
const client = createSupportClient();
const button = document.getElementById('contact-admin');
const status = document.getElementById('contact-admin-status');
const badge = document.getElementById('contact-admin-badge'), badgeCount = document.getElementById('contact-admin-unread');
let unread = 0;
// The badge only reflects the signed-in customer's own thread; it never affects whether the entry is shown.
function renderUnread(count) {
  if (!badge || !badgeCount) return;
  const value = Math.max(0, Math.floor(Number(count) || 0));
  badge.hidden = !value; badgeCount.textContent = value > 99 ? '99+' : value ? String(value) : '';
}
const request = message => new Promise((resolve, reject) => {
  try { chrome.runtime.sendMessage(message, result => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve(result);
  }); } catch (error) { reject(error); }
});
const configured = (force = false) => request({ type: 'TP_SUPPORT_CONFIG', force }).then(result => result?.configured === true, () => false);
// Configuration alone does not prove a completed Paid customer sign-in.
// This read is authenticated, works in every AI mode and creates no chat.
// 10495: chat is tied to the TextPhantom account. Without data-use consent a
// signed-in customer sees Contact admin greyed ([data-account-control]: a click
// opens the consent screen) and nothing is read from the account service.
let locked = false;
async function signedIn(force = false) {
  try {
    const account = await accountState();
    locked = account.signedIn && !account.consent;
    if (!account.consent) return locked && await configured(false);
    const identity = await client.scope();
    if (!(await configured(force))) return false;
    const data = await client.request('/paid/support', { identity });
    unread = data?.thread?.unread || 0;
    return typeof data?.email === 'string' && Boolean(data.email.trim());
  } catch { return false; }
}
let checkId = 0, checking = null;
// Opening the popup fires the initial check, `focus` and `visibilitychange`
// together; they share one read (10493: owner logs showed 3-4 identical
// /paid/support reads per popup open). An account/API change starts a fresh one.
function update({ fresh = false } = {}) {
  if (checking && !fresh) return checking;
  const id = ++checkId; button.hidden = true;
  if (status) { status.hidden = true; status.textContent = ''; }
  const run = (async () => {
    const ready = await signedIn(true);
    if (id === checkId) { button.hidden = !ready; renderUnread(ready && !locked ? unread : 0); }
  })().finally(() => { if (checking === run) checking = null; });
  checking = run;
  return run;
}
button?.addEventListener('click', async () => {
  button.disabled = true;
  if (status) { status.hidden = true; status.textContent = ''; }
  try {
    if (!(await signedIn()) || locked) { await update(); return; }
    // Only explicit Contact admin unhides the launcher. This never ends a case.
    await activateSupport(client);
    const opened = await request({ type: 'TP_SUPPORT_SHOW' });
    if (opened?.ok) { window.close(); return; }
    if (status) {
      status.hidden = false;
      status.textContent = opened?.code === 'SUPPORT_PAGE_UNAVAILABLE'
        ? 'Open a regular website to contact admin.'
        : 'Chat could not open. Try again on this page.';
    }
  } catch (error) {
    if (error.status === 401 || ['SIGN_IN_REQUIRED', 'STALE_SUPPORT_RESPONSE'].includes(error.code)) {
      ++checkId; button.hidden = true;
      return;
    }
    if (status) { status.hidden = false; status.textContent = 'Chat could not open. Try again on this page.'; }
  } finally { button.disabled = false; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (['paidSessionToken', 'paidApiBase', 'customApiUrl', 'apiUrlDefault'].some(key => changes[key])) client.invalidate();
  if (['paidSessionToken', 'paidApiBase', 'customApiUrl', 'apiUrlDefault', 'supportConfiguration'].some(key => changes[key])) void update({ fresh: true });
  else if (changes.supportUnread && button && !button.hidden) {
    const value = changes.supportUnread.newValue;
    void client.scope().then(supportScopeId).then(current => { if (!button.hidden && value?.scope === current) renderUnread(value.unread); }, () => {});
  }
});
window.addEventListener('focus', () => { if (button) void update(); });
onAccountGateChanged(detail => { if (button && detail?.reason !== 'session') { client.invalidate(); void update({ fresh: true }); } });
document.addEventListener('visibilitychange', () => {
  if (button && document.visibilityState === 'visible') void update();
});
if (button) void update();
// Opening the popup is a refresh hint for the page launcher's unread count
// (the background reads it at most once per 5 min for hints).
void request({ type: 'TP_SUPPORT_REFRESH' }).catch(() => {});
