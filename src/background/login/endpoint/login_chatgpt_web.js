/**
 * ChatGPT free plan: the prompt is typed into the chatgpt.com website in a
 * background tab of this browser and the finished answer is read back. The
 * website performs its own sign-in, Turnstile and request checks; TextPhantom
 * only uses the composer and Send button like a person. Nothing is fetched,
 * copied or replayed from the website's private API.
 *
 * ONE chatgpt.com tab: an open one (the person's own included) is used, one is
 * opened in the background only when none is open, and TextPhantom never closes
 * it. Each translation run is its own ChatGPT conversation (handle `wc_…` → its
 * chatgpt.com/c/… address); runs take turns in that tab (turns are serial).
 */
import {queryTabs, getTab, createTab} from '../../../shared/browser-api.js';
import {getLoginSession, setLoginSession} from '../../../shared/login-session.js';
import {noteLoginTab, loginTabClosedDuringWork} from '../login-tab-guard.js';

const ORIGIN = 'https://chatgpt.com', HOME = 'https://chatgpt.com/';
const KEY = 'tpChatgptWebV2', LEGACY_KEY = 'tpChatgptWebChatsV1';
const MAX_CHATS = 64, CHAT_URL = /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]{8,80}$/;
// The Login check must answer well inside the extension's import request,
// otherwise the real reason is lost and the person sees "sign-in expired".
const PROBE_READY_MS = 40000, TURN_READY_MS = 45000;  // Import waits up to 120 s
const HANDLE = /^wc_[a-f0-9]{32}$/, ACCOUNT = /^[a-f0-9]{64}$/;
const FILES = ['content/login/webchat/login_provider_chatgpt.js', 'content/login/webchat/login_webchat_dom.js'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, '0')).join('');

export function webchatJobProblem(job) {
  const w = job?.webchat;
  if (job?.method !== 'WEBCHAT' || job?.path !== '/' || !w || typeof w !== 'object') return 'route';
  if (!['probe', 'turn'].includes(w.action) || !ACCOUNT.test(w.account || '')) return 'body';
  if (w.action === 'turn' && (typeof w.prompt !== 'string' || !w.prompt.trim() || w.prompt.length > 200000 ||
      typeof w.chat !== 'string' || (w.chat && !HANDLE.test(w.chat)))) return 'body';
  const keys = Object.keys(w).sort().join(',');
  if (keys !== (w.action === 'probe' ? 'account,action' : 'account,action,chat,prompt')) return 'body';
  return '';
}

let chain = Promise.resolve();
function serial(action) { const run = chain.then(action, action); chain = run.catch(() => {}); return run; }
async function readState() {
  const value = (await getLoginSession([KEY]))[KEY];
  return value && typeof value === 'object' ? {tabId: value.tabId ?? null, chats: value.chats || {}} : {tabId: null, chats: {}};
}
async function saveState(value) { await setLoginSession({[KEY]: value}); }

function send(tabId, message) {
  return new Promise(resolve => chrome.tabs.sendMessage(tabId, {type: 'TP_LOGIN_WEBCHAT_DOM', ...message}, {frameId: 0}, value => {
    if (chrome.runtime.lastError) {
      // A tab the person closed says so, rather than "not ready, reload it".
      getTab(tabId).then(tab => resolve({ok: false, code: tab ? 'login_tab_disconnected' : 'login_tab_closed'}),
        () => resolve({ok: false, code: 'login_tab_closed'}));
      return;
    }
    // Only an answer from the Login page script counts (it always says ready/code
    // or carries text); any other reply means another script answered first.
    const own = value && typeof value === 'object' && value.ignored !== true &&
      (typeof value.ready === 'boolean' || typeof value.code === 'string' || typeof value.text === 'string' || value.state !== undefined);
    resolve(own ? value : {ok: false, code: 'login_dom_wrong_reply'});
  }));
}
async function inject(tabId) {
  const tab = await getTab(tabId).catch(() => null);
  if (!tab?.url || new URL(tab.url).origin !== ORIGIN) return false;
  try { await chrome.scripting.executeScript({target: {tabId, frameIds: [0]}, world: 'ISOLATED', files: FILES}); return true; }
  catch { return false; }
}
async function keep(tabId) {
  try { await new Promise(resolve => chrome.tabs.update(tabId, {autoDiscardable: false}, () => { void chrome.runtime.lastError; resolve(); })); } catch {}
}
/** Probe until the website is ready (signed in, composer usable) or a final state. */
async function ready(tabId, {empty = false, wait = TURN_READY_MS, relocate = null} = {}) {
  const until = Date.now() + wait;
  // The DOM probe itself decides readiness, so a still-loading tab is probed too
  // (waiting for status 'complete' timed out on live pages); the reason says
  // which step never happened.
  let last = {ok: false, code: 'login_tab_loading'}, woke = false;
  while (Date.now() < until) {
    let tab = await getTab(tabId).catch(() => null);
    // The browser can swap a tab for a new one (prerender / sign-in redirect);
    // the old id is then gone although the page is still open.
    if (!tab && relocate) { tab = await relocate().catch(() => null); if (tab) tabId = tab.id; }
    if (!tab) return {ok: false, code: 'login_tab_closed'};
    if (tab.discarded) {
      last = {ok: false, code: 'login_tab_discarded'};
      // Wake a sleeping tab once; reloading it every loop would never let it finish.
      if (!woke) { woke = true; await new Promise(resolve => chrome.tabs.reload(tabId, {}, () => { void chrome.runtime.lastError; resolve(); })); }
    } else if (!await inject(tabId)) last = {ok: false, code: tab.status === 'complete' ? 'login_inject_failed' : 'login_tab_loading'};
    else {
      last = await send(tabId, {action: 'probe', provider: 'login_chatgpt'});
      if (last.ok && last.ready && (!empty || last.empty)) return last;
      if (last.ok && last.code === 'login_challenge') return {ok: false, code: 'login_challenge'};
      if (last.ok && last.code === 'login_required') return {ok: false, code: 'login_required'};
    }
    await sleep(400);
  }
  return last.ok ? {ok: false, code: last.code || 'login_browser_timeout'} : last;
}
const ERRORS = {login_required: 'signed_out', login_session_expired: 'signed_out', login_challenge: 'challenge',
  login_account_changed: 'account_changed', login_tab_busy: 'busy', login_quota_exceeded: 'limit',
  login_tab_closed: 'tab_unavailable', login_origin_invalid: 'tab_unavailable',
  // The page loaded but is not usable yet; the code tells the person what to fix.
  login_tab_disconnected: 'not_ready', login_composer_missing: 'not_ready', login_composer_disabled: 'not_ready',
  login_session_http_error: 'not_ready', login_session_content_invalid: 'not_ready', login_session_probe_timeout: 'not_ready',
  login_session_probe_failed: 'not_ready', login_browser_timeout: 'not_ready', login_inject_failed: 'not_ready',
  login_tab_loading: 'not_ready', login_tab_discarded: 'not_ready', login_dom_error: 'not_ready', login_dom_wrong_reply: 'not_ready'};
const DETAIL = /^login_[a-z_]{1,40}$/;
const failed = code => ({error: ERRORS[code] || 'network', detail: DETAIL.test(code || '') ? code : ''});
const json = value => ({status: 200, content_type: 'application/json', headers: {}, body: JSON.stringify(value)});

async function siteTabs() {
  return (await queryTabs({url: ORIGIN + '/*'})).filter(tab => tab.url && new URL(tab.url).origin === ORIGIN)
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
}
/** The one chatgpt.com tab: the one used last, else any open one, else a new
 * background tab. Never closed by TextPhantom. */
async function siteTab({open = true} = {}) {
  const state = await readState(), tabs = await siteTabs();
  let tab = tabs.find(t => t.id === state.tabId && !t.discarded) || tabs.find(t => !t.discarded && t.status === 'complete') ||
    tabs.find(t => !t.discarded) || tabs[0] || null;
  // The tab this work used was closed by the person: not reopened until
  // Translate is pressed again (login-tab-guard.js).
  if (!tab && open && loginTabClosedDuringWork('chatgpt.com')) return null;
  if (!tab && open) tab = await createTab({url: HOME, active: false});
  if (tab) noteLoginTab('chatgpt.com', tab.id);
  if (tab && tab.id !== state.tabId) await saveState({...state, tabId: tab.id});
  if (tab) await keep(tab.id);
  return tab;
}
/** Open `url` in the tab and wait until the new page has loaded (never probe the
 * page that is being left). */
async function navigate(tabId, url) {
  await new Promise(resolve => chrome.tabs.update(tabId, {url}, () => { void chrome.runtime.lastError; resolve(); }));
  for (let i = 0; i < 40; i++) {
    const tab = await getTab(tabId).catch(() => null);
    if (!tab || (tab.url === url && tab.status === 'complete')) return;
    await sleep(250);
  }
}
/** After the first answer chatgpt.com moves the tab to /c/<id>; wait briefly for it. */
async function chatAddress(tabId) {
  for (let i = 0; i < 12; i++) {
    const tab = await getTab(tabId).catch(() => null);
    if (CHAT_URL.test(tab?.url || '')) return tab.url;
    await sleep(500);
  }
  return '';
}

async function probeJob(w) {
  const tab = await siteTab();
  if (!tab) return failed('login_tab_closed');
  const state = await ready(tab.id, {wait: PROBE_READY_MS, relocate: () => siteTab({open: false})});
  if (!state.ok) return failed(state.code);
  return json({ready: true, account: state.accountFingerprint === w.account ? w.account : state.accountFingerprint});
}

async function turnJob(w) {
  let saved = await readState();
  const handle = w.chat || 'wc_' + hex(16);
  const address = w.chat ? saved.chats[w.chat]?.url : HOME;
  if (!address) return {error: 'chat_lost'};
  const tab = await siteTab();
  if (!tab) return failed('login_tab_closed');
  if (tab.url !== address) await navigate(tab.id, address);
  const state = await ready(tab.id, {empty: !w.chat, relocate: () => siteTab({open: false})});
  if (!state.ok) return failed(state.code);
  if (state.accountFingerprint !== w.account) return {error: 'account_changed'};
  const result = await send(tab.id, {action: 'execute', provider: 'login_chatgpt', turnId: 'tp_' + hex(12), prompt: w.prompt,
    accountFingerprint: w.account, modelLabel: ''});
  if (!result.ok || typeof result.text !== 'string' || !result.text.trim()) return failed(result.code);
  const url = w.chat ? address : await chatAddress(tab.id);
  saved = await readState();
  const chats = {...saved.chats};
  if (url) chats[handle] = {url, usedAt: Date.now()};
  const kept = Object.fromEntries(Object.entries(chats).sort((a, b) => (b[1].usedAt || 0) - (a[1].usedAt || 0)).slice(0, MAX_CHATS));
  await saveState({...saved, chats: kept});
  // Without a conversation address the next page of this run gets chat_lost.
  return json({text: result.text, chat: handle});
}

/** One relay job (probe or turn). Turns run one at a time in this browser. */
export function webchatJob(job) {
  if (webchatJobProblem(job)) return Promise.resolve({error: 'not_allowed', detail: 'login_webchat_job_invalid'});
  return serial(() => (job.webchat.action === 'probe' ? probeJob(job.webchat) : turnJob(job.webchat))
    .catch(() => ({error: 'network', detail: 'login_webchat_failed'})));
}

// TextPhantom never closes chatgpt.com tabs; clear the idle sweep older versions set.
try { globalThis.chrome?.alarms?.clear?.('tp-webchat-idle'); } catch {}
try { void globalThis.chrome?.storage?.session?.remove?.(LEGACY_KEY); } catch {}

// Keep a chat handle when the browser replaces its tab with a new id.
try {
  chrome.tabs?.onReplaced?.addListener((added, removed) => {
    void (async () => {
      const state = await readState();
      if (state.tabId === removed) await saveState({...state, tabId: added});
    })().catch(() => {});
  });
} catch {}

/** Disconnect: forget the conversations. The chatgpt.com tab stays open. */
export async function forgetWebchats() {
  await saveState({tabId: null, chats: {}});
}
