import { getStorage, setStorage } from '../shared/storage.js';
import { createSupportClient, supportScopeId } from '../support/client.js';
import { createSupportConfiguration } from '../support/config.js';
import { syncSupportVisibility } from '../support/visibility.js';
import { queryTabs } from '../shared/browser-api.js';
import { openSupportDock, injectSupportDocks } from './support-dock.js';
import { changedTopics } from '../shared/change-signals.js';
import { accountAllowed, ACCOUNT_GATE_STATE_KEY } from '../shared/account-gate.js';

const client = createSupportClient(), configuration = createSupportConfiguration();
/** 10495: consent withdrawn — abort support requests in flight, forget unread. */
export function supportLocked() { client.invalidate(); authReads.clear(); void setStorage({ supportUnread: null }).catch(() => {}); }
const dockChannels = new Map();
// No unread alarm or presence timer. Unread is read when (a) the support change
// token moves on any account/support response (shared/change-signals.js), (b)
// the popup opens or the browser regains focus -- at most once per
// REFRESH_GAP_MS, (c) after the customer sends a message: FOLLOW_UP_MINUTES
// backoff, stopping once an admin replied or the chat ended. Presence is sent
// only by the expanded chat (or while typing), >= PRESENCE_GAP_MS apart.
export const REFRESH_GAP_MS = 5 * 60000;
export const PRESENCE_GAP_MS = 2 * 60000;
export const FOLLOW_UP_MINUTES = Object.freeze([1, 2, 5, 15, 30]);
const FOLLOW_UP_ALARM = 'tp-support-followup', LEGACY_ALARM = 'tp-support-unread';
const STATE_KEY = 'supportPollState';
let polling = false, rerun = false, presenceAt = 0, presenceBusy = false, polledDoneAt = 0;
const OWN_READ_MS = 3000;
const sessionArea = () => chrome.storage?.session || null;
async function pollState(patch = null) {
  const area = sessionArea() ? 'session' : 'local';
  const store = area === 'session' ? chrome.storage.session : chrome.storage.local;
  const read = () => new Promise(resolve => { try { store.get([STATE_KEY], value => { void chrome.runtime.lastError; resolve(value?.[STATE_KEY] || {}); }); } catch { resolve({}); } });
  const current = await read();
  if (!patch) return current;
  const next = { ...current, ...patch };
  await new Promise(resolve => { try { store.set({ [STATE_KEY]: next }, () => { void chrome.runtime.lastError; resolve(); }); } catch { resolve(); } });
  return next;
}
// The page's own URL as its sender reports it. support/chat.html is web
// accessible through a dynamic URL on Chromium (use_dynamic_url), where
// getURL('support/chat.html') returns the per-session GUID address while the
// loaded page (sender.url, origin) keeps chrome-extension://<id>/. getURL('')
// is always that stable base.
const extensionPage = path => { try { return new URL(path, chrome.runtime.getURL('')).href; } catch { return null; } };
const fromPage = (sender, path) => { const page = extensionPage(path); return Boolean(page) && String(sender?.url || '').startsWith(page); };
async function activity(sender, message = {}) {
  // Only the private chat frame reports activity, and only while expanded or typing.
  if (!fromPage(sender, 'support/chat.html')) return;
  if (!['expanded', 'typing'].includes(message.reason)) return;
  if (presenceBusy || Date.now() - presenceAt < PRESENCE_GAP_MS) return;
  presenceBusy = true;
  try {
    // 10495: no support request without data-use consent (silent no-op).
    if (!(await accountAllowed())) return;
    const saved = await getStorage(['supportActivated']);
    if (!saved.supportActivated || !(await configuration.check()).configured) return;
    if (sender.tab) {
      const active = await queryTabs({ active: true, lastFocusedWindow: true });
      if (!active.some(tab => tab.id === sender.tab.id)) return;
    }
    await client.request('/paid/support/presence', { body: {} }); presenceAt = Date.now();
  }
  catch (_) {} finally { presenceBusy = false; }
}
async function followUp(thread) {
  const state = await pollState();
  if (!state.followUp) return;
  // Stop once an admin answered (unread / waiting_customer) or the chat ended.
  if (!thread || thread.state === 'resolved' || thread.state === 'waiting_customer' || thread.unread > 0) {
    await pollState({ followUp: null }); try { chrome.alarms?.clear?.(FOLLOW_UP_ALARM); } catch {}
  }
}
function armFollowUp(step) {
  const minutes = FOLLOW_UP_MINUTES[step];
  if (minutes == null || !chrome.alarms?.create) return false;
  chrome.alarms.create(FOLLOW_UP_ALARM, { when: Date.now() + minutes * 60000 });
  return true;
}
export async function supportMessageSent() {
  await pollState({ followUp: { step: 0, startedAt: Date.now() } });
  armFollowUp(0);
}
async function followUpDue() {
  const state = await pollState();
  if (!state.followUp) return;
  const step = (state.followUp.step || 0) + 1;
  await pollSupport('follow_up');
  const after = await pollState();
  if (!after.followUp) return; // Answered or ended.
  if (armFollowUp(step)) await pollState({ followUp: { ...after.followUp, step } });
  else await pollState({ followUp: null });
}
/** A refresh hint (popup open, browser focus, worker start): at most once per REFRESH_GAP_MS. */
export async function refreshSupport(reason = 'hint') {
  const state = await pollState();
  if (Date.now() - (state.polledAt || 0) < REFRESH_GAP_MS) return false;
  await pollState({ polledAt: Date.now() }); // the gap holds even if a read is already running
  await pollSupport(reason);
  return true;
}
export async function pollSupport(reason = 'signal') {
  if (polling) { rerun = true; return; }
  polling = true;
  try {
    await pollState({ polledAt: Date.now(), reason });
    // 10495: no unread read (or any support request) without data-use consent.
    if (!(await accountAllowed())) return;
    const saved = await getStorage(['supportActivated', 'supportDockHidden', 'supportChatMuted']);
    const gate = await configuration.check();
    if (!saved.supportActivated || !gate.configured) return;
    const identity = await client.scope(), scope = await supportScopeId(identity);
    const data = await client.request('/paid/support', { identity });
    const visible = await syncSupportVisibility(data, scope), summary = visible.supportUnread;
    await followUp(data?.thread || null);
    if (summary?.unread && !visible.supportDockHidden && visible.supportChatMuted?.scope !== scope) {
      const tabs = await queryTabs({ active: true, lastFocusedWindow: true });
      if (tabs[0]?.id != null) await openSupportDock(tabs[0].id, 'minimized');
    }
  } catch (error) {
    if (error.status === 401 || error.code === 'SIGN_IN_REQUIRED') await setStorage({ supportUnread: null });
  } finally { polling = false; polledDoneAt = Date.now(); if (rerun) { rerun = false; void pollSupport(reason); } }
}
const viewArea = () => chrome.storage.session || chrome.storage.local;
const viewStore = (method, value) => new Promise(resolve => viewArea()[method](value, result => { void chrome.runtime.lastError; resolve(result || {}); }));
let viewWrites = Promise.resolve();
async function tabView(tab, next = null, expectedScope = '') {
  let scope = '';
  try { scope = await supportScopeId(await client.scope()); } catch (_) {}
  await viewWrites;
  if (next !== null) {
    if (expectedScope && scope !== expectedScope) return { view: 'minimized' };
    viewWrites = viewWrites.then(async () => {
      const saved = await viewStore('get', ['supportTabViews']);
      let current = ''; try { current = await supportScopeId(await client.scope()); } catch (_) {}
      if (current !== scope) return;
      await viewStore('set', { supportTabViews: { ...(saved.supportTabViews || {}), [tab]: { scope, view: next } } });
    });
    await viewWrites;
    return { view: next };
  }
  const saved = await viewStore('get', ['supportTabViews']), value = saved.supportTabViews?.[tab];
  let current = ''; try { current = await supportScopeId(await client.scope()); } catch (_) {}
  if (current !== scope) return { view: 'minimized' };
  return { view: value?.scope === scope && value.view === 'expanded' ? 'expanded' : 'minimized' };
}
// Every tab's dock asks on page load (and all of them at once after a browser
// start, an extension update or a configuration change). Concurrent asks for the
// same account share one /paid/support read; nothing is reused once it settled.
const authReads = new Map();
export async function supportAuthenticated() {
  // 10495: without data-use consent the dock is unavailable: no /meta, no auth read.
  if (!(await accountAllowed())) return false;
  if (!(await configuration.check()).configured) return false;
  const identity = await client.scope(), key = await supportScopeId(identity);
  let read = authReads.get(key);
  if (!read) {
    read = client.request('/paid/support', { identity })
      .then(data => typeof data?.email === 'string' && Boolean(data.email.trim()))
      .finally(() => { if (authReads.get(key) === read) authReads.delete(key); });
    authReads.set(key, read);
  }
  return read;
}
globalThis.chrome?.runtime?.onMessage?.addListener((message, sender, reply) => {
  if (message?.type === 'TP_SUPPORT_SHOW') {
    if (String(sender.url || '').split(/[?#]/)[0] !== chrome.runtime.getURL('popup/popup.html')) {
      reply({ ok: false, code: 'SUPPORT_PAGE_UNAVAILABLE' }); return false;
    }
    (async () => {
      if (!(await accountAllowed())) return { ok: false, code: 'DATA_CONSENT_REQUIRED' };
      const tabs = await queryTabs({ active: true, currentWindow: true });
      // openSupportDock injects the dock first when this tab does not have it yet.
      // Pages that cannot host the dock (brave://, chrome://, the
      // Web Store, PDF viewer) show the popup's "open a regular website" message; no
      // separate chat window pops up.
      return tabs[0]?.id != null ? openSupportDock(tabs[0].id) : { ok: false, code: 'SUPPORT_PAGE_UNAVAILABLE' };
    })().then(reply, () => reply({ ok: false, code: 'SUPPORT_DOCK_UNAVAILABLE' }));
    return true;
  }
  if (message?.type === 'TP_SUPPORT_TAB_VIEW') {
    const tab = sender?.tab?.id;
    if (tab == null) { reply({ view: 'minimized' }); return false; }
    const next = ['expanded', 'minimized'].includes(message.view) && fromPage(sender, 'support/chat.html') ? message.view : null;
    tabView(tab, next, message.scope || '').then(reply, () => reply({ view: 'minimized' }));
    return true;
  }
  if (message?.type === 'TP_SUPPORT_CHANNEL') {
    const tab = sender?.tab?.id;
    if (tab == null) { reply({ channel: '' }); return false; }
    if (!dockChannels.has(tab)) dockChannels.set(tab, crypto.randomUUID());
    reply({ channel: dockChannels.get(tab) });
    return false;
  }
  if (message?.type === 'TP_SUPPORT_CONFIG') {
    configuration.check({ force: message.force === true }).then(reply, () => reply({ configured: false }));
    return true;
  }
  if (message?.type === 'TP_SUPPORT_AUTH') {
    supportAuthenticated().then(authenticated => reply({ authenticated }), () => reply({ authenticated: false }));
    return true;
  }
  if (message?.type === 'TP_SUPPORT_ACTIVITY') { void activity(sender || {}, message); reply({ ok: true }); }
  if (message?.type === 'TP_SUPPORT_SENT' && fromPage(sender, 'support/chat.html')) {
    void supportMessageSent(); reply({ ok: true });
  }
  if (message?.type === 'TP_SUPPORT_REFRESH' && extensionPage('popup/popup.html') && String(sender?.url || '').split(/[?#]/)[0] === extensionPage('popup/popup.html')) {
    void refreshSupport('popup'); reply({ ok: true });
  }
  return false;
});
globalThis.chrome?.tabs?.onRemoved?.addListener(tab => {
  dockChannels.delete(tab);
  viewWrites = viewWrites.then(async () => { const saved = await viewStore('get', ['supportTabViews']); const values = saved.supportTabViews || {}; delete values[tab]; await viewStore('set', { supportTabViews: values }); });
});
function boot() {
  // Remove the periodic alarm of older versions (alarms survive updates).
  try { chrome.alarms?.clear?.(LEGACY_ALARM); } catch {}
  // A worker start is not a reason to fetch; it is only a refresh hint.
  void refreshSupport('worker_start');
}
// Add the dock to tabs that were open before this install/update or browser start, so
// customers do not need to reload a page before the chat appears.
globalThis.chrome?.runtime?.onInstalled?.addListener?.(() => { void injectSupportDocks(); });
globalThis.chrome?.runtime?.onStartup?.addListener?.(() => { void injectSupportDocks(); });
if (globalThis.chrome?.alarms) {
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === FOLLOW_UP_ALARM) void followUpDue(); });
  chrome.runtime.onStartup?.addListener(() => { viewWrites = viewWrites.then(() => viewStore('set', { supportTabViews: {} })); boot(); });
  boot();
}
// Browser focus is a refresh hint (gap-limited), never a cadence.
globalThis.chrome?.windows?.onFocusChanged?.addListener?.(windowId => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void refreshSupport('focus');
});
globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.supportDockHidden?.newValue === true) viewWrites = viewWrites.then(() => viewStore('set', { supportTabViews: {} }));
  if (['paidSessionToken', 'paidApiBase', 'customApiUrl', 'apiUrlDefault', 'supportActivated', ACCOUNT_GATE_STATE_KEY].some(key => changes[key])) {
    client.invalidate(); configuration.invalidate(); presenceAt = 0; void pollSupport('account');
    return;
  }
  // The support change token moved on some response: the conversation changed.
  // A move revealed by our own read already came with the fresh state.
  if (changedTopics(changes).includes('support') && !polling && Date.now() - polledDoneAt > OWN_READ_MS) void pollSupport('change_token');
});
