/** 10495: ONE account gate (shared/account-gate.js).
 *
 * A signed-in user who has not allowed data use (or revoked it) stays signed
 * in, but no request carrying the account token, email, cookie or chat leaves
 * the extension — automatic or user-initiated. Checks, with real modules, a
 * fake browser and a stubbed fetch (no real network):
 *  - static: every account-token read for network use goes through the gate;
 *  - zero account requests without consent for every route (background,
 *    transports, relay, login workers, support, account pages, popup);
 *  - Paid select → consent screen → "Don't allow" reverts; sign-out local only;
 *  - revoke aborts in flight: support long-poll, relay poll, payment poll and a
 *    running Paid batch (its next request never starts);
 *  - a blocked page translation opens the consent tab once (deduped; focus);
 *  - Thunderbird fallback when `data_collection` is refused; Firefox asks for
 *    the four types synchronously inside the Allow click;
 *  - diagnostics confirmation (cancel keeps off, confirm turns on, Firefox
 *    request inside the confirm click). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const ROOT = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, ROOT), 'utf8');
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); console.log('PASS ' + name); };
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ static
await check('Static: the account token is read for network use only through shared/account-gate.js', () => {
  const files = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else if (entry.name.endsWith('.js')) files.push(full);
  } };
  const src = new URL('src/', ROOT).pathname;
  walk(src);
  // Allowed: the gate itself; writes on sign-in/sign-out (object keys in a
  // write/set call); storage-change key watchers; the settings epoch watcher;
  // log redaction; the paid popup's own-write queue (keys of its write helper).
  const allowed = [
    { file: 'shared/log-serialization.js', line: /paidSessionToken\|accessToken/ },
    { file: 'background/translation-settings.js', line: /for \(const key of \[.*'paidSessionToken'.*\]\) \{/ },
    { file: 'popup/controllers/paid-service-controller.js', line: /for \(const key of \["paidSessionToken", "paidApiBase"\]\) \{/ },
    { file: 'popup/controllers/paid-service-controller.js', line: /for \(const \[key, current\] of \[\["paidSessionToken", token\]/ },
  ];
  const watcher = /\[[^\]]*['"]paidSessionToken['"][^\]]*\]\.some\(\(?(?:key|k)\)? => (?:changes\[key\]|\(?k\)? in changes|k in changes)/;
  const write = /\b(?:write|writeSession|setStorage|set)\(\{[^}]*paidSessionToken\s*:|^\s*paidSessionToken\s*:\s*(?:''|"")\s*,?\s*$|paidSessionToken:\s*(?:''|""|result\.token|nextToken)/;
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(src, file).split(path.sep).join('/');
    if (rel === 'shared/account-gate.js') continue;
    read('src/' + rel).split('\n').forEach((text, index) => {
      if (!text.includes('paidSessionToken')) return;
      if (allowed.some(rule => rule.file === rel && rule.line.test(text))) return;
      if (watcher.test(text) || write.test(text)) return;
      offenders.push(`${rel}:${index + 1}: ${text.trim().slice(0, 160)}`);
    });
  }
  assert.deepEqual(offenders, [], 'read paidSessionToken only through shared/account-gate.js:\n' + offenders.join('\n'));
  // No storage read of the token outside the gate, in any spelling.
  for (const file of files) {
    const rel = path.relative(src, file).split(path.sep).join('/');
    if (rel === 'shared/account-gate.js') continue;
    const text = read('src/' + rel);
    assert.doesNotMatch(text, /(?:getStorage|readLoginState|read|get)\(\s*\[[^\]]*['"]paidSessionToken['"]/, rel + ' reads the token from storage');
    assert.doesNotMatch(text, /(?<!changes)\.paidSessionToken\b/, rel + ' reads .paidSessionToken');
  }
});

await check('Static: every module that sends account requests takes the session from the gate', () => {
  for (const file of ['background/ai-profile-resolver.js', 'background/ai/transports/server.js', 'background/transports/translate.js',
    'background/transports/account-request.js', 'background/login-auth.js',
    'background/login/endpoint/login_endpoint_background.js', 'background/repair/coordinator.js', 'background/support.js',
    'popup/controllers/paid-service-controller.js', 'popup/controllers/login-service-controller.js', 'paid/client.js', 'paid/account.js',
    'support/client.js', 'support/chat.js', 'support/popup-entry.js']) {
    assert.match(read('src/' + file), /from ['"][./]+(?:shared\/)?account-gate\.js['"]|from ['"]\.\/account-request\.js['"]/, file + ' imports the account gate');
  }
  // The relay pump gets its token (and the revocation signal) from gate callers.
  assert.match(read('src/background/transports/account-request.js'), /acquire\(base, session\.token, \{gate: session\.signal\}\)/);
  assert.match(read('src/background/login/endpoint/login_endpoint_background.js'), /acquireBrowserRelay\(ctx\.base,ctx\.token,\{gate:accountSignal\(\)\}\)/);
  // The settings no longer carry the token; the resolver reads it through the gate.
  assert.doesNotMatch(read('src/shared/settings.js'), /"paidSessionToken"/);
});

// ------------------------------------------------------------------ fake browser
let inClick = false;
const local = {}, session = {};
const storageListeners = new Set(), permissionEvents = { added: new Set(), removed: new Set() };
const permissionCalls = [], tabsCreated = [], tabsUpdated = [], windowsUpdated = [];
const tabs = new Map();
let manifest = { version: '2026.10.4.95' };
const keysOf = (keys, area) => keys == null ? Object.keys(area) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
const area = store => ({
  get(keys, cb) { const v = Object.fromEntries(keysOf(keys, store).filter(k => k in store).map(k => [k, structuredClone(store[k])])); cb?.(v); return Promise.resolve(v); },
  set(patch, cb) { const changes = {}; for (const [k, v] of Object.entries(patch)) { changes[k] = { oldValue: store[k], newValue: structuredClone(v) }; store[k] = structuredClone(v); }
    cb?.(); for (const fn of storageListeners) fn(changes, store === local ? 'local' : 'session'); return Promise.resolve(); },
  remove(keys, cb) { const changes = {}; for (const k of [].concat(keys)) { changes[k] = { oldValue: store[k] }; delete store[k]; }
    cb?.(); for (const fn of storageListeners) fn(changes, store === local ? 'local' : 'session'); return Promise.resolve(); },
});
const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
globalThis.chrome = {
  runtime: { id: 'gate-fixture', lastError: null, getManifest: () => manifest, getURL: p => 'chrome-extension://gate/' + p,
    onMessage: event(), onInstalled: event(), onStartup: event(), sendMessage: (_m, cb) => cb?.({}) },
  storage: { local: area(local), session: area(session),
    onChanged: { addListener: fn => storageListeners.add(fn), removeListener: fn => storageListeners.delete(fn) } },
  permissions: {
    request(query, cb) { permissionCalls.push({ ns: 'chrome', method: 'request', query: structuredClone(query), inClick }); cb(true); },
    contains(query, cb) { cb(true); }, remove(query, cb) { cb?.(true); },
    onAdded: { addListener: fn => permissionEvents.added.add(fn), removeListener: fn => permissionEvents.added.delete(fn) },
    onRemoved: { addListener: fn => permissionEvents.removed.add(fn), removeListener: fn => permissionEvents.removed.delete(fn) },
  },
  tabs: {
    create(props, cb) { const tab = { id: 900 + tabsCreated.length, windowId: 1, url: props.url }; tabsCreated.push(tab); tabs.set(tab.id, tab); cb?.(tab); },
    get(id, cb) { const tab = tabs.get(id); if (!tab) { chrome.runtime.lastError = { message: 'No tab' }; cb?.(undefined); chrome.runtime.lastError = null; return; } cb?.(tab); },
    query(_q, cb) { cb?.([]); }, update(id, props, cb) { tabsUpdated.push([id, props]); cb?.(tabs.get(id)); },
    onUpdated: event(), onRemoved: event(), sendMessage: (_t, _m, _o, cb) => cb?.(),
  },
  windows: { update(id, props, cb) { windowsUpdated.push([id, props]); cb?.(); }, onFocusChanged: event(), WINDOW_ID_NONE: -1 },
  alarms: { create() {}, clear(_n, cb) { cb?.(); }, onAlarm: event() },
  scripting: { executeScript: (_q, cb) => cb?.([]) },
  webNavigation: { onBeforeNavigate: event() },
  contextMenus: { create() {}, removeAll: cb => cb?.(), onClicked: event() },
};

// fetch stub: records every request; account requests are counted by path,
// Authorization header and body (token / email / cookie / chat text).
const TOKEN = 't'.repeat(64), EMAIL = 'reader@example.com', BASE = 'http://localhost:7860';
const sent = [];
let hold = null, holdStream = null;
globalThis.fetch = async (url, init = {}) => {
  const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : { ...(init.headers || {}) };
  const row = { url: String(url), path: new URL(String(url)).pathname, method: init.method || 'GET', auth: headers.Authorization || headers.authorization || '',
    body: typeof init.body === 'string' ? init.body : '' };
  sent.push(row);
  if (holdStream?.(row)) {
    // Response headers arrived; the answer streams until the request is aborted
    // (the body errors like a real fetch body does).
    const body = new ReadableStream({ start(controller) {
      const fail = () => controller.error(init.signal?.reason || new DOMException('The operation was aborted.', 'AbortError'));
      if (init.signal?.aborted) fail(); else init.signal?.addEventListener('abort', fail, { once: true });
    } });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }
  if (hold?.(row)) {
    return new Promise((_resolve, reject) => {
      const fail = () => reject(init.signal?.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init.signal?.aborted) fail(); else init.signal?.addEventListener('abort', fail, { once: true });
    });
  }
  const json = row.path === '/meta' ? { ok: true, paid: { available: true, configured: true } }
    : row.path === '/paid/auth/status' ? { available: true, registration_enabled: true }
    : row.path === '/paid/me' ? { email: EMAIL, credits: { available: '100', held: '0' }, models: [{ id: 'qa/test', eligible_tp: '100' }], addons: { entitlements: [] } }
    : { ok: true };
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
};
const ACCOUNT_PATH = /^\/(?:paid|login|support)\b|\/paid\/support|\/login\//;
const accountRequests = (from = 0) => sent.slice(from).filter(r => ACCOUNT_PATH.test(r.path) || r.auth.includes(TOKEN) ||
  r.body.includes(TOKEN) || r.body.includes(EMAIL) || /cookie/i.test(r.body));

// ------------------------------------------------------------------ fake DOM (dialogs)
class Node {
  constructor(tag, doc) { this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this.attributes = {}; this.dataset = {}; this.handlers = {}; this.hidden = false; this.disabled = false; this.id = ''; this.className = ''; this._text = ''; this.style = {}; this.checked = false; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  append(...nodes) { for (const n of nodes) { if (typeof n === 'string') { this._text += n; continue; } n.remove?.(); n.parentNode = this; this.children.push(n); } }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] || []).filter(x => x !== fn); }
  focus() { this.ownerDocument.activeElement = this; }
  walk() { return [this, ...this.children.flatMap(c => c.walk?.() || [])]; }
}
function makeDocument() {
  const doc = { handlers: {}, activeElement: null, visibilityState: 'visible' };
  doc.createElement = tag => new Node(tag, doc);
  doc.createTextNode = text => text;
  doc.documentElement = new Node('html', doc); doc.head = new Node('head', doc); doc.body = new Node('body', doc);
  doc.documentElement.append(doc.head, doc.body);
  doc.getElementById = id => doc.documentElement.walk().find(n => n.id === id) || null;
  doc.addEventListener = (t, fn) => { (doc.handlers[t] ||= []).push(fn); };
  doc.removeEventListener = (t, fn) => { doc.handlers[t] = (doc.handlers[t] || []).filter(x => x !== fn); };
  return doc;
}
globalThis.document = makeDocument();
function click(node) { assert(node, 'element to click exists'); inClick = true; try { for (const fn of node.handlers.click || []) fn({ preventDefault() {} }); } finally { inClick = false; } }
const byId = id => globalThis.document.getElementById(id);
async function waitFor(id) { for (let i = 0; i < 300 && !byId(id); i++) await settle(1); return byId(id); }

// ------------------------------------------------------------------ modules
const gate = await import('../src/shared/account-gate.js');
const consent = await import('../src/shared/data-consent.js');
const { DATA_CONSENT_KEY, DATA_CONSENT_REQUIRED, DATA_CONSENT_REVOKED } = consent;
const grant = () => { local[DATA_CONSENT_KEY] = { version: 1, granted: true, at: 1 }; };
const signIn = () => Object.assign(local, { paidSessionToken: TOKEN, paidApiBase: BASE, paidEmail: EMAIL, customApiUrl: BASE, apiUrlDefault: BASE, apiDefaultsFetchedAt: Date.now() });
signIn();

await check('Gate: without consent no token comes out; accountState has no token; with consent the token and a live signal', async () => {
  const locked = await gate.readAccountSession();
  assert.equal(locked.ok, false); assert.equal(locked.locked, true); assert.equal(locked.signedIn, true); assert.equal(locked.token, undefined);
  assert(!JSON.stringify(locked).includes(TOKEN), 'the locked result never carries the token');
  const state = await gate.accountState();
  assert.deepEqual(Object.keys(state).sort(), ['base', 'consent', 'email', 'signedIn']); assert.equal(state.signedIn, true); assert.equal(state.consent, false);
  await assert.rejects(gate.requireAccountSession(), e => e.code === DATA_CONSENT_REQUIRED && e.requestDispatched === false);
  grant();
  const open = await gate.readAccountSession();
  assert.equal(open.ok, true); assert.equal(open.token, TOKEN); assert.equal(open.signal.aborted, false);
  const events = [];
  const stop = gate.onAccountGateChanged(detail => events.push(detail));
  const signal = gate.accountSignal(), joined = gate.withAccountSignal(new AbortController().signal);
  await gate.revokeAccountConsent();
  assert.equal(signal.aborted, true, 'revocation aborts the current generation'); assert.equal(joined.aborted, true);
  assert.equal(signal.reason.code, DATA_CONSENT_REVOKED);
  assert(events.some(e => e.consent === false), 'listeners hear the revocation');
  assert.equal(gate.accountSignal().aborted, false, 'a new generation for later requests');
  assert.equal(local[consent.DATA_CONSENT_OFFERED_KEY]?.revoked, true, 'a revocation is a decision: the one-time offer does not pop up afterwards');
  delete local[consent.DATA_CONSENT_OFFERED_KEY];
  stop();
});

// ------------------------------------------------------------------ background routes, no consent
const { resolveJobAiProfile } = await import('../src/background/ai-profile-resolver.js');
const { translateViaServer } = await import('../src/background/ai/transports/server.js');
const { translateServerRoute } = await import('../src/background/ai/routes/server.js');
const { submitJobViaRest, translateViaSyncRest } = await import('../src/background/transports/translate.js');
const { createLoginAuthWorker } = await import('../src/background/login-auth.js');
const { autoConnectLogin } = await import('../src/background/login/endpoint/login_endpoint_background.js');
const { acquireBrowserRelay } = await import('../src/background/login/endpoint/login_browser_relay.js');
const support = await import('../src/background/support.js');
const { createSupportClient } = await import('../src/support/client.js');
const { waitPath } = await import('../src/support/live.js');
const { createAccountClient } = await import('../src/paid/client.js');
const { createPaymentMonitor } = await import('../src/paid/payment.js');
const unit = [{ id: 'P0', text: 'Hello' }];
const aiPaid = { provider: 'paid', model: 'qa/test', api_key: TOKEN, prompt: 'S', thinking: 'minimum' };
const aiLogin = { provider: 'login', model: 'lgs_' + 'a'.repeat(48) + '/m', api_key: TOKEN, prompt: 'S', thinking: 'minimum' };

await check('No consent: Paid/Login translation, transports, relay, Login workers, support and account pages send nothing', async () => {
  delete local[DATA_CONSENT_KEY]; await gate.refreshAccountGate();
  const before = sent.length;
  for (const settings of [{ aiServiceMode: 'paid', paidModel: 'qa/test' }, { aiServiceMode: 'paid', paidTranslationSource: 'login', loginProvider: 'login_claude' }])
    await assert.rejects(resolveJobAiProfile(settings), e => e.code === DATA_CONSENT_REQUIRED && e.requestDispatched === false);
  assert.equal(sent.length, before, 'the resolver sends nothing at all (not even /meta)');
  for (const ai of [aiPaid, aiLogin]) await assert.rejects(translateViaServer(unit, { base: BASE, targetLang: 'th', sourceLang: 'en', operationId: 'op-' + ai.provider, ai }), e => /^DATA_CONSENT_/.test(e.code));
  await assert.rejects(translateServerRoute(unit, { base: BASE, targetLang: 'th', sourceLang: 'en', operationId: 'op-route', ai: aiLogin }), e => /^DATA_CONSENT_/.test(e.code));
  await assert.rejects(submitJobViaRest(BASE, { ai: aiPaid, mode: 'lens_text' }), e => /^DATA_CONSENT_/.test(e.code));
  await assert.rejects(translateViaSyncRest(BASE, { ai: aiLogin, mode: 'lens_text' }), e => /^DATA_CONSENT_/.test(e.code));
  // Login OAuth worker with a pending flow: no status request.
  session.loginPendingAuthV1 = { flow_id: 'lgf_' + 'c'.repeat(48), provider: 'login_chatgpt', state: 's'.repeat(12), expiresAt: Date.now() + 60000, apiBase: BASE, scope: 'x', transport: 'oauth' };
  const worker = createLoginAuthWorker({ currentBase: async () => BASE, tabs: async () => [], fetchFn: globalThis.fetch, schedule: () => 0, unschedule() {} });
  await worker.wake(); worker.dispose(); delete session.loginPendingAuthV1;
  // Auto-connect: every Login provider (not only Gemini/DeepSeek).
  for (const provider of ['login_claude', 'login_chatgpt', 'login_gemini', 'login_deepseek']) {
    local.loginProvider = provider;
    const result = await autoConnectLogin();
    assert.equal(result.reason, 'data_consent_required', provider);
  }
  // Support: popup open / browser focus / worker start / page-load auth.
  assert.equal(await support.supportAuthenticated(), false);
  await support.pollSupport('test'); await support.refreshSupport('focus');
  const client = createSupportClient();
  await assert.rejects(client.request('/paid/support'), e => e.code === DATA_CONSENT_REQUIRED);
  await assert.rejects(client.request('/paid/auth/request', { auth: false, body: { email: EMAIL } }), e => e.code === DATA_CONSENT_REQUIRED);
  await assert.rejects(client.signIn(EMAIL, '123456'), e => e.code === DATA_CONSENT_REQUIRED);
  // Account pages: details, payment and add-on reads.
  const account = createAccountClient();
  await assert.rejects(account.request('/paid/account'), e => e.code === DATA_CONSENT_REQUIRED);
  await assert.rejects(account.request('/paid/orders/ord_' + 'a'.repeat(32)), e => e.code === DATA_CONSENT_REQUIRED);
  await settle();
  assert.deepEqual(accountRequests(before), [], 'zero account requests');
  assert.deepEqual(sent.slice(before), [], 'and nothing else either');
});

await check('No consent: sign-out clears this device only and sends no request (support chat and account page)', async () => {
  const before = sent.length;
  await createSupportClient().signOut();
  assert.equal(local.paidSessionToken, ''); assert.equal(local.paidApiBase, '');
  signIn();
  await createAccountClient().logout();
  assert.equal(local.paidSessionToken, '');
  assert.deepEqual(sent.slice(before), []);
  signIn();
});

await check('No consent: a pending payment poll stops (blocked) instead of retrying', async () => {
  const account = createAccountClient();
  const timers = [];
  const monitor = createPaymentMonitor({ request: path => account.request(path), schedule: (fn, ms) => { timers.push(ms); return timers.length; }, unschedule() {}, storageEvents: null });
  const before = sent.length;
  await monitor.refresh('ord_' + 'b'.repeat(32)).catch(() => {});
  monitor.watch({ id: 'ord_' + 'b'.repeat(32), status: 'waiting' });
  assert.equal(sent.length, before);
  monitor.dispose();
});

// ------------------------------------------------------------------ popup Paid controller
const { createPaidServiceController } = await import('../src/popup/controllers/paid-service-controller.js');
const el = (value = '') => ({ value, textContent: '', style: { display: '' }, disabled: false, hidden: false, handlers: {}, attrs: {}, dataset: {},
  addEventListener(n, fn) { this.handlers[n] = fn; }, removeEventListener() {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
  removeAttribute() {}, replaceChildren(...c) { this.children = c; }, append() {}, focus() {}, classList: { toggle() {} } });
const elNames = ['mode', 'sources', 'lang', 'apiUrl', 'aiService', 'aiServiceWrap', 'aiPaidPanel', 'aiPaidUnavailable', 'aiPaidConnectionMessage', 'aiPaidTitle',
  'aiPaidSubtitle', 'aiPaidLogin', 'aiPaidAccount', 'aiPaidEmailStep', 'aiPaidCodeStep', 'aiPaidEmail', 'aiPaidCode', 'aiPaidCodeEmail', 'aiPaidSend', 'aiPaidCheck',
  'aiPaidVerify', 'aiPaidResend', 'aiPaidChangeEmail', 'aiPaidEmailLabel', 'aiPaidCredits', 'aiPaidHeld', 'aiPaidAccountState', 'aiPaidModel', 'aiPaidRefresh',
  'aiPaidLogout', 'aiPaidStatus', 'aiPaidConsent', 'aiPaidConsentAllow', 'aiPaidBuy', 'aiPaidDetails', 'aiPaidSource', 'aiPaidSourceWrap', 'aiPaidTpModel',
  'aiLoginPanel', 'aiProviderWrap', 'aiKeyWrap', 'aiModelWrap', 'aiEndpointWrap', 'aiPageImageWrap'];
function popup() {
  const els = Object.fromEntries(elNames.map(n => [n, el()]));
  els.mode.value = 'lens_text'; els.sources.value = 'ai'; els.apiUrl.value = BASE; els.aiService.value = local.aiServiceMode || 'manual';
  const state = { lastApiOk: true, lastSavedApiUrl: BASE, healthSeq: 0 };
  let controller;
  controller = createPaidServiceController({ els, state, getStorage: async keys => chrome.storage.local.get(keys), setStorage: async patch => chrome.storage.local.set(patch),
    toggleUi: () => controller.applyVisibility(), beforeSwitch: async () => ({ ok: true }) });
  return { els, state, controller };
}

await check('Popup, signed in without consent: open, idle signals and visibility send no account request; Sign out stays usable', async () => {
  delete local[DATA_CONSENT_KEY]; local.aiServiceMode = 'paid'; local.uiLanguageV1 = 'th'; signIn();
  const before = sent.length;
  const { els, state, controller } = popup();
  await controller.initialize(); controller.setAvailability(true, BASE); await settle();
  // Change tokens, usage ledger and becoming visible are refresh signals.
  await chrome.storage.local.set({ tpChangeTokensV1: { scope: 's', tokens: { account: 'a1' }, changed: ['account'], seq: 2, at: Date.now() } });
  await controller.reconnect(); await settle();
  assert.deepEqual(accountRequests(before), [], 'nothing account-related left the popup');
  assert.equal(els.aiPaidLogin.style.display, 'none', 'still signed in: no sign-in form');
  assert.equal(els.aiPaidAccount.style.display, '', 'the account area stays (greyed)');
  assert.equal(els.aiPaidConsent.hidden, false, 'the locked banner shows');
  const P = globalThis.TPPrivacyContent;
  assert.equal(els.aiPaidConsentAllow.textContent, P.messages('th').reviewAllow, 'authored Thai (shared/privacy-content.js)');
  assert.equal(els.aiPaidConsent.attrs.translate, 'no', 'the authored Thai is kept out of the machine translator');
  delete local.uiLanguageV1;
  assert.equal(state.paidReady, false);
  // Sign out without consent: local only.
  await els.aiPaidLogout.handlers.click(); await settle();
  assert.equal(local.paidSessionToken, ''); assert.deepEqual(accountRequests(before), []);
  controller.dispose(); signIn();
});

await check('Popup: choosing Paid shows the consent screen at once; "Don\'t allow" puts Manual back (saved) and sends nothing', async () => {
  delete local[DATA_CONSENT_KEY]; local.aiServiceMode = 'manual'; delete local.paidSessionToken;
  const { els, controller } = popup();
  await controller.initialize(); controller.setAvailability(true, BASE); await settle();
  const before = sent.length;
  els.aiService.value = 'paid';
  const changed = els.aiService.handlers.change();
  assert(await waitFor('tp-data-consent'), 'the consent screen appears when Paid is chosen');
  click(byId('tp-consent-later'));
  await changed; await settle();
  assert.equal(els.aiService.value, 'manual'); assert.equal(local.aiServiceMode, 'manual');
  assert.deepEqual(sent.slice(before), [], 'nothing sent');
  // Allow: Paid is kept and the sign-in readiness check may go out.
  els.aiService.value = 'paid';
  const again = els.aiService.handlers.change();
  assert(await waitFor('tp-data-consent')); click(byId('tp-consent-allow'));
  await again; await settle();
  assert.equal(local.aiServiceMode, 'paid'); assert.equal(local[DATA_CONSENT_KEY]?.granted, true);
  assert(sent.slice(before).some(r => r.path === '/paid/auth/status'), 'after Allow the sign-in check runs');
  controller.dispose(); signIn();
});

// ------------------------------------------------------------------ revoke aborts in flight
await check('Revoke aborts in flight: support long-poll, relay poll, payment poll; nothing more is sent', async () => {
  grant(); await gate.refreshAccountGate(); signIn();
  hold = row => ['/paid/support/wait', '/login/relay/poll', '/paid/orders/ord_' + 'c'.repeat(32)].includes(row.path);
  const client = createSupportClient();
  const identity = await client.scope();
  const live = client.request(waitPath({ after: 1, version: 1, timeout: 25 }), { identity, timeoutMs: 40000 });
  const release = acquireBrowserRelay(BASE, TOKEN, { gate: gate.accountSignal() });
  const account = createAccountClient();
  const payment = account.request('/paid/orders/ord_' + 'c'.repeat(32));
  await settle();
  assert(sent.some(r => r.path === '/paid/support/wait') && sent.some(r => r.path === '/login/relay/poll') && sent.some(r => r.path.startsWith('/paid/orders/')), 'all three are in flight');
  const outcome = Promise.allSettled([live, payment]);
  const started = Date.now();
  await gate.revokeAccountConsent();
  const results = await outcome;
  assert(Date.now() - started < 1000, 'aborted at once');
  assert(results.every(r => r.status === 'rejected'), 'long-poll and payment poll rejected');
  const after = sent.length;
  await sleep(400); await settle();
  assert.equal(sent.length, after, 'no further poll after the revocation (relay pump stopped)');
  release(); hold = null;
});

await check('Revoke during a running Paid batch: the request in flight aborts (DATA_CONSENT_REVOKED, also mid-stream); the next page never starts', async () => {
  grant(); await gate.refreshAccountGate();
  hold = row => row.path.includes('/ai/translate') || row.path.includes('/translate');
  const page1 = translateViaServer(unit, { base: BASE, targetLang: 'th', sourceLang: 'en', operationId: 'batch-1', ai: aiPaid });
  await settle();
  assert(sent.some(r => r.body.includes('batch-1')), 'page 1 was sent');
  await gate.revokeAccountConsent();
  await assert.rejects(page1, e => e.code === DATA_CONSENT_REVOKED);
  const before = sent.length;
  await assert.rejects(translateViaServer(unit, { base: BASE, targetLang: 'th', sourceLang: 'en', operationId: 'batch-2', ai: aiPaid }), e => /^DATA_CONSENT_/.test(e.code));
  assert.equal(sent.length, before, 'page 2: nothing sent');
  hold = null;
  // Revoked while the answer streams (headers already in): the page gets the
  // revoked error, not a silent tab cancellation (AbortError).
  grant(); await gate.refreshAccountGate();
  holdStream = row => row.path.includes('/ai/translate');
  const streaming = translateViaServer(unit, { base: BASE, targetLang: 'th', sourceLang: 'en', operationId: 'batch-3', ai: aiPaid });
  await settle(60);
  assert(sent.some(r => r.body.includes('batch-3')), 'page 3 was sent and is streaming');
  await gate.revokeAccountConsent();
  await assert.rejects(streaming, e => e.code === DATA_CONSENT_REVOKED && e.name !== 'AbortError' && e.requestDispatched === true);
  holdStream = null;
});

await check('Background: revocation (storage or Firefox permissions.onRemoved) runs onLocked once and mirrors the state for content scripts', async () => {
  grant();
  let locked = 0;
  const stop = gate.installAccountGateBackground({ onLocked: () => { locked++; } });
  await settle();
  assert.equal(local[gate.ACCOUNT_GATE_STATE_KEY]?.consent, true);
  await chrome.storage.local.remove(DATA_CONSENT_KEY); await settle();
  assert.equal(locked, 1); assert.equal(local[gate.ACCOUNT_GATE_STATE_KEY]?.consent, false);
  assert.equal(local[consent.DATA_CONSENT_OFFERED_KEY]?.revoked, true, 'a revocation anywhere ends the one-time offer');
  delete local[consent.DATA_CONSENT_OFFERED_KEY];
  assert(permissionEvents.removed.size > 0, 'permissions.onRemoved is watched (Firefox)');
  stop();
  const index = read('src/background/index.js');
  assert.match(index, /installAccountGateBackground\(\{ onLocked: \(\) => \{\s*bumpSettingsEpoch\(\);\s*supportLocked\(\);/);
});

// ------------------------------------------------------------------ page translate blocked
await check('Page translation blocked: the consent tab opens once per action; a second action focuses the same tab', async () => {
  const { openConsentTab } = await import('../src/background/consent-tab.js');
  tabsCreated.length = 0; tabsUpdated.length = 0;
  const first = await openConsentTab('action-1');
  assert.equal(first.opened, true); assert.equal(tabsCreated.length, 1); assert.equal(tabsCreated[0].url, 'chrome-extension://gate/popup/consent.html');
  assert.deepEqual(await openConsentTab('action-1'), { deduped: true }, 'the same blocked action opens nothing more');
  const second = await openConsentTab('action-2');
  assert.equal(second.focused, true); assert.equal(tabsCreated.length, 1, 'no second tab');
  assert.deepEqual(tabsUpdated.at(-1), [tabsCreated[0].id, { active: true }]); assert.deepEqual(windowsUpdated.at(-1), [1, { focused: true }]);
  tabs.delete(tabsCreated[0].id);
  assert.equal((await openConsentTab('action-3')).opened, true, 'closed by the user: a new one opens');
  const menu = read('src/background/context-menu.js');
  assert.match(menu, /e\?\.code === DATA_CONSENT_REQUIRED\) \{[\s\S]{0,400}openConsentTab\(actionKey\)/);
  assert.match(menu, /const actionKey = crypto\.randomUUID\(\);/);
  assert.match(read('src/content/image-buttons.js'), /resp\.shown !== true/, 'no second (English) toast on the page');
  const { publicTpError } = await import('../src/shared/error-contract.js');
  assert.equal(publicTpError(consent.dataConsentError()).userMessage, 'ต้องอนุญาตข้อมูลก่อน เปิดแท็บขออนุญาตให้แล้ว ยังไม่ได้ส่งคำขอและไม่หักเครดิต');
  assert.equal(consent.DATA_CONSENT_MESSAGE, globalThis.TPPrivacyContent.MESSAGES.en.pageBlocked);
  assert.equal(publicTpError(consent.dataConsentError()).userMessage, globalThis.TPPrivacyContent.MESSAGES.th.pageBlocked);
});

// ------------------------------------------------------------------ Firefox / Thunderbird
await check('Firefox: Allow asks for the four data types synchronously inside the click', async () => {
  const declared = JSON.parse(read('platform/firefox.json')).browser_specific_settings;
  manifest = { version: '2026.10.4.95', browser_specific_settings: declared };
  const granted = new Set(); const schemaError = false;
  globalThis.browser = { permissions: {
    request(query, ...extra) {
      assert.equal(extra.length, 0);
      if (schemaError && query.data_collection) throw new TypeError('Type error for parameter permissions (Unexpected property "data_collection")');
      permissionCalls.push({ ns: 'browser', method: 'request', query: structuredClone(query), inClick });
      for (const t of query.data_collection || []) granted.add(t); return Promise.resolve(true); },
    contains(query) { if (schemaError && query.data_collection) throw new TypeError('Unexpected property "data_collection"'); return Promise.resolve((query.data_collection || []).every(t => granted.has(t))); },
    remove(query) { for (const t of query.data_collection || []) granted.delete(t); return Promise.resolve(true); },
    onAdded: event(), onRemoved: event() },
    // Gecko `browser.storage`: promise-only, same backing store.
    storage: { local: { get: keys => chrome.storage.local.get(keys), set: patch => chrome.storage.local.set(patch), remove: keys => chrome.storage.local.remove(keys) },
      onChanged: chrome.storage.onChanged } };
  delete local[DATA_CONSENT_KEY];
  assert.equal(consent.usesBuiltinDataConsent(), true);
  permissionCalls.length = 0;
  const asked = gate.showConsentScreen();
  assert(await waitFor('tp-data-consent')); click(byId('tp-consent-allow'));
  assert.equal((await asked).consent, true);
  const request = permissionCalls.find(c => c.ns === 'browser' && c.method === 'request');
  assert.equal(request.inClick, true, 'inside the click');
  assert.deepEqual(request.query.data_collection, ['personallyIdentifyingInfo', 'financialAndPaymentInfo', 'authenticationInfo', 'personalCommunications']);
  delete globalThis.browser; manifest = { version: '2026.10.4.95' };
});

// ------------------------------------------------------------------ diagnostics confirmation
await check('Diagnostics: switching on asks first (focus on Cancel); Cancel keeps it off; Turn on turns it on; Firefox asks inside the confirm click', async () => {
  const { createDiagnosticsController } = await import('../src/popup/controllers/diagnostics-controller.js');
  const settings = await import('../src/shared/settings.js');
  const box = el(); box.checked = false;
  const writes = [];
  const controller = createDiagnosticsController({ doc: globalThis.document, el: box, language: async () => 'th',
    read: async () => local.diagnosticsUploadV1 === true,
    write: on => { writes.push({ on, inClick }); return settings.writeDiagnosticsUpload(on); } });
  await controller.initialize();
  box.checked = true; const first = box.handlers.change();
  const dialog = await waitFor('tp-diag-confirm');
  assert(dialog, 'confirmation shown'); assert.equal(box.checked, false, 'still off while asking');
  assert.equal(globalThis.document.activeElement?.id, 'tp-diag-cancel', 'default focus on Cancel');
  assert.equal(byId('tp-diag-title').textContent, globalThis.TPPrivacyContent.DIAGNOSTICS.th.title);
  assert.equal(byId('tp-diag-body').textContent, globalThis.TPPrivacyContent.DIAGNOSTICS.th.body);
  click(byId('tp-diag-cancel')); await first;
  assert.equal(box.checked, false); assert.deepEqual(writes, []);
  box.checked = true; const second = box.handlers.change();
  await waitFor('tp-diag-confirm'); click(byId('tp-diag-confirm-on')); await second; await settle();
  assert.equal(box.checked, true); assert.deepEqual(writes, [{ on: true, inClick: true }]);
  box.checked = false; await box.handlers.change();
  assert.equal(byId('tp-diag-confirm'), null, 'turning off needs no confirmation'); assert.equal(box.checked, false);
  // Firefox: technicalAndInteraction requested synchronously in the confirm click.
  manifest = { version: '2026.10.4.95', browser_specific_settings: JSON.parse(read('platform/firefox.json')).browser_specific_settings };
  const calls = [];
  globalThis.browser = { permissions: { request(q) { calls.push({ q, inClick }); return Promise.resolve(true); }, contains: () => Promise.resolve(true),
    remove: () => Promise.resolve(true), onAdded: event(), onRemoved: event() } };
  const ff = el(); const ffController = createDiagnosticsController({ doc: globalThis.document, el: ff, language: async () => 'en' });
  ff.checked = true; const turning = ff.handlers.change();
  await waitFor('tp-diag-confirm'); click(byId('tp-diag-confirm-on')); await turning;
  assert.deepEqual(calls, [{ q: { data_collection: ['technicalAndInteraction'] }, inClick: true }]);
  ffController.dispose(); controller.dispose();
  delete globalThis.browser; manifest = { version: '2026.10.4.95' };
});

await check('Thunderbird: when the browser refuses `data_collection` (schema error) the consent falls back to storage; cookies still asked inside the click', async () => {
  const declared = JSON.parse(read('platform/thunderbird.json')).browser_specific_settings;
  manifest = { version: '2026.10.4.95', browser_specific_settings: declared };
  const granted = new Set(); const schemaError = true;
  globalThis.browser = { permissions: {
    request(query, ...extra) {
      assert.equal(extra.length, 0);
      if (schemaError && query.data_collection) throw new TypeError('Type error for parameter permissions (Unexpected property "data_collection")');
      permissionCalls.push({ ns: 'browser', method: 'request', query: structuredClone(query), inClick }); return Promise.resolve(true); },
    contains(query) { if (query.data_collection) throw new TypeError('Unexpected property "data_collection"'); return Promise.resolve(true); },
    remove() { return Promise.resolve(true); }, onAdded: event(), onRemoved: event() },
    storage: { local: { get: keys => chrome.storage.local.get(keys), set: patch => chrome.storage.local.set(patch), remove: keys => chrome.storage.local.remove(keys) },
      onChanged: chrome.storage.onChanged } };
  delete local[DATA_CONSENT_KEY];
  assert.equal(consent.usesBuiltinDataConsent(), true, 'declared in the manifest: tried first');
  permissionCalls.length = 0;
  assert.equal(await consent.hasDataConsent(), false);
  assert.equal(consent.usesBuiltinDataConsent(), false, 'switched to the storage record');
  const tb = gate.showConsentScreen({ permissions: ['cookies'] });
  assert(await waitFor('tp-data-consent')); click(byId('tp-consent-allow'));
  const answer = await tb;
  assert.equal(answer.consent, true); assert.equal(local[DATA_CONSENT_KEY]?.granted, true);
  assert.deepEqual(permissionCalls.filter(c => c.method === 'request').map(c => [c.query, c.inClick]), [[{ permissions: ['cookies'] }, true]], 'cookies still asked inside the click');
  assert.equal(local[consent.DATA_CONSENT_MODE_KEY], 'storage', 'remembered for this profile');
  // The diagnostics switch follows the same fallback (storage) on this profile.
  const settings = await import('../src/shared/settings.js');
  assert.equal(await settings.writeDiagnosticsUpload(true), true); assert.equal(local.diagnosticsUploadV1, true);
  await settings.writeDiagnosticsUpload(false);
  delete globalThis.browser; manifest = { version: '2026.10.4.95' };
});

await check('Tools no longer has a Privacy & data section; the diagnostics switch sits in Advanced directly under "Remove server pacing for this local API" (outside its local-only wrap), before "Where the work runs"', () => {
  const html = read('src/popup/popup.html');
  const tools = html.slice(html.indexOf('id="panel-tools"'));
  assert.doesNotMatch(tools, /Privacy &amp; data/); assert.doesNotMatch(tools, /data-consent-(?:allow|revoke|state)/);
  const advanced = tools.slice(tools.indexOf('>Advanced<'), tools.indexOf('>Reset<'));
  const at = (needle) => { const i = advanced.indexOf(needle); assert(i > 0, needle); return i; };
  // 10496 owner request: api-url < pacing wrap (closed) < diagnostics < engine-mode.
  const pacingWrap = at('id="api-local-unlimited-wrap"'), pacing = at('id="api-local-unlimited"'), diagnostics = at('id="diagnostics-upload"');
  const pacingWrapEnd = advanced.indexOf('</div>', advanced.indexOf('id="api-local-unlimited-tip"'));
  assert(at('id="api-url"') < pacingWrap && pacingWrap < pacing && pacing < pacingWrapEnd && pacingWrapEnd < diagnostics && diagnostics < at('id="engine-mode"'),
    'order: Custom API URL, pacing row (local only), diagnostics switch, Where the work runs');
  assert.doesNotMatch(advanced.slice(pacingWrap, pacingWrapEnd), /diagnostics-upload/, 'the diagnostics switch is not inside the local-only pacing wrap');
  const diagWrap = advanced.slice(advanced.lastIndexOf('<div', diagnostics), diagnostics);
  assert.doesNotMatch(diagWrap, /display:\s*none|hidden/, 'the diagnostics switch is visible for every API');
  assert.match(advanced, /id="diagnostics-upload-hint"/);
  assert(!fs.existsSync(new URL('src/popup/controllers/privacy-controller.js', ROOT)), 'the old Tools controller is gone');
  // Every account control in the popup is greyable; Sign out is not.
  for (const id of ['ai-paid-buy', 'ai-paid-details', 'ai-paid-refresh', 'ai-paid-source', 'ai-paid-model-picker', 'ai-login-provider', 'ai-login-connect',
    'ai-login-refresh', 'ai-login-cancel', 'ai-login-logout', 'ai-login-model', 'contact-admin'])
    assert.match(html, new RegExp(`id="${id}"[^>]*data-account-control`), id);
  assert.match(html, /id="ai-paid-logout"[^>]*data-account-free/);
  assert.match(html, /id="ai-paid-consent"[\s\S]{0,200}Account data is not allowed, so Paid and Login translation is paused\.[\s\S]{0,200}Review and allow/);
});

console.log(JSON.stringify({ passed: true, checks: checks.length }));
process.exit(0);
