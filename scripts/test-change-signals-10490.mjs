// 10490: change-driven updates in the extension -- no timers while idle, unread via
// change tokens, presence/long-poll only while the chat is expanded, popup refresh
// triggers, bounded recovery backoff, bounded pending-order polling, Login alarms
// only while a sign-in flow is pending, dock layout without a 1 s timer.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
globalThis.crypto ??= webcrypto;

const root = process.env.TP_QA_EXTENSION_ROOT || fileURLToPath(new URL('..', import.meta.url));
const src = path => readFileSync(join(root, 'src', path), 'utf8');
const load = path => import(pathToFileURL(join(root, 'src', path)) + '?t=' + Date.now() + Math.random());
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 4000) { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(5); } }
// Wait until no new request was made for ``quiet`` ms (background work settled).
async function settled(quiet = 150) { let last = -1; while (last !== requests.length) { last = requests.length; await sleep(quiet); } }
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
}

// ---- minimal extension storage/alarms/runtime -------------------------------------
const local = {}, session = {}, storageListeners = [], runtimeListeners = [], alarmListeners = [], alarms = new Map();
const area = store => ({
  get: (keys, cb) => queueMicrotask(() => cb(Object.fromEntries((Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || {})).map(k => [k, structuredClone(store[k])])))),
  set: (patch, cb) => queueMicrotask(() => {
    const changes = {};
    for (const [key, value] of Object.entries(patch)) { changes[key] = { oldValue: store[key], newValue: structuredClone(value) }; store[key] = structuredClone(value); }
    cb?.();
    if (store === local) for (const fn of storageListeners) fn(changes, 'local');
  }),
});
const requests = [];
let reply = () => new Response(JSON.stringify({ email: 'customer@example.invalid', enabled: true, thread: { unread: 0, last_seq: 1, last_admin_seq: 0, state: 'waiting_admin' } }));
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: 'qa' }), getURL: path => 'chrome-extension://qa/' + path, sendMessage: () => {}, lastError: null,
    onMessage: { addListener: fn => runtimeListeners.push(fn) }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
  storage: { local: area(local), session: area(session), onChanged: { addListener: fn => storageListeners.push(fn), removeListener: fn => { const i = storageListeners.indexOf(fn); if (i >= 0) storageListeners.splice(i, 1); } } },
  tabs: { get: (id, cb) => cb({ id, url: 'https://publisher.example/' }), query: (_q, cb) => cb([{ id: 5 }]), sendMessage: (_id, msg, _o, cb) => cb?.(msg.type === 'TP_SUPPORT_PING' ? { ready: true, version: 'qa' } : { ok: true }), onRemoved: { addListener() {} } },
  windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener: fn => { globalThis.__focus = fn; } } },
  alarms: {
    create: (name, info) => alarms.set(name, info), clear: (name, cb) => { alarms.delete(name); cb?.(true); },
    onAlarm: { addListener: fn => alarmListeners.push(fn) },
  },
};
globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/meta')) return new Response(JSON.stringify({ ok: true, paid: { configured: true } }));
  requests.push({ url: String(url), options });
  return reply(String(url), options);
};
Object.assign(local, { supportActivated: true, paidSessionToken: 'a'.repeat(64), paidApiBase: 'http://localhost:7860', customApiUrl: 'http://localhost:7860' });
const runtime = (message, sender) => new Promise(resolve => {
  let answered = false;
  for (const fn of runtimeListeners) { const async = fn(message, sender, value => { answered = true; resolve(value); }); if (async === true) answered = true; }
  if (!answered) resolve(undefined);
});

// ---- change tokens ------------------------------------------------------------------
const signals = await load('shared/change-signals.js');
await check('Change tokens: first sight records, a moved token names its topic, a restart names all', async () => {
  const store = {}, read = async keys => Object.fromEntries(keys.map(k => [k, store[k]])), write = async patch => Object.assign(store, patch);
  const header = (b, s, a, p) => `v1;b=${b};support=${s};account=${a};prices=${p}`;
  assert.deepEqual(await signals.noteChanges('https://api', 't1', header('b0b0b0', 'aaaaaa', 'bbbbbb', 'cccccc'), { read, write }), []);
  assert.deepEqual(await signals.noteChanges('https://api', 't1', header('b0b0b0', 'aaaaaa', 'bbbbbb', 'cccccc'), { read, write }), []);
  assert.deepEqual(await signals.noteChanges('https://api', 't1', header('b0b0b0', 'aaaaaa', 'dddddd', 'cccccc'), { read, write }), ['account']);
  assert.deepEqual(await signals.noteChanges('https://api', 't1', header('b1b1b1', 'aaaaaa', 'dddddd', 'cccccc'), { read, write }), ['support', 'account', 'prices']);
  assert.deepEqual(await signals.noteChanges('https://api', 't2', header('b1b1b1', 'eeeeee', 'dddddd', 'cccccc'), { read, write }), [], 'another account starts fresh');
  assert.equal(signals.parseChanges('v1;b=zz'), null);
  assert.equal(signals.parseChanges('v1;b=abcdef;support=<script>'), null, 'only the exact shape is accepted');
});

await check('diagnosticFetch records tokens of /paid/* responses only', async () => {
  const { diagnosticFetch } = await load('shared/diagnostics.js');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { headers: { 'X-TP-Changes': 'v1;b=abcdef;support=111111;account=222222;prices=333333' } });
  try {
    delete local[signals.CHANGE_KEY];
    await diagnosticFetch('http://localhost:7860/paid/me', { headers: { Authorization: 'Bearer ' + 'a'.repeat(64) } });
    // noteChanges hashes with crypto.subtle (real thread-pool I/O): bound by time, not turns.
    for (let i = 0, end = Date.now() + 5000; (i < 20 || Date.now() < end) && !local[signals.CHANGE_KEY]; i++) await tick();
    assert.equal(local[signals.CHANGE_KEY]?.tokens?.account, '222222');
    delete local[signals.CHANGE_KEY];
    await diagnosticFetch('http://localhost:7860/translate', { headers: { Authorization: 'Bearer x' } });
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(local[signals.CHANGE_KEY], undefined);
  } finally { globalThis.fetch = original; }
});

// ---- recovery backoff ---------------------------------------------------------------
await check('Recovery retries back off 5, 15, 30, 60, 60 s; online retries at once; success resets', async () => {
  const { createRecoveryBackoff } = await load('shared/retry-backoff.js');
  const delays = [], timers = new Map(), events = new EventTarget();
  let id = 0, runs = 0, online = true;
  const backoff = createRecoveryBackoff({ run: () => runs++, events, isOnline: () => online,
    setTimeoutFn: (fn, ms) => { delays.push(ms); timers.set(++id, fn); return id; }, clearTimeoutFn: key => timers.delete(key) });
  for (let i = 0; i < 5; i++) { backoff.failed(); const [key, fn] = [...timers][0]; timers.delete(key); fn(); await tick(); }
  assert.deepEqual(delays, [5000, 15000, 30000, 60000, 60000]);
  assert.equal(runs, 5);
  online = false; backoff.failed();
  assert.equal(timers.size, 0, 'offline: no timer, wait for the online event');
  online = true; events.dispatchEvent(new Event('online')); await tick();
  assert.equal(runs, 6, 'back online: one retry at once');
  backoff.failed(); backoff.succeeded();
  assert.equal(timers.size, 0); backoff.failed();
  assert.equal(delays.at(-1), 5000, 'a new outage starts at 5 s again');
  backoff.dispose();
});

// ---- background support -------------------------------------------------------------
alarms.set('tp-support-unread', { periodInMinutes: 1 }); // left behind by an older version
const support = await load('background/support.js');
for (let i = 0; i < 40; i++) await tick();
await check('Support: no periodic unread alarm; the legacy alarm is removed', async () => {
  const again = support;
  assert(!alarms.has('tp-support-unread'));
  assert(![...alarms.values()].some(info => info.periodInMinutes), 'no repeating alarm while idle');
  assert(again.REFRESH_GAP_MS === 5 * 60000 && again.PRESENCE_GAP_MS === 2 * 60000);
  assert.deepEqual([...again.FOLLOW_UP_MINUTES], [1, 2, 5, 15, 30]);
});
await check('Support: popup/focus hints read unread at most once per 5 min', async () => {
  await settled(); // the worker-start hint finished
  session.supportPollState = { polledAt: 0 };
  requests.length = 0;
  assert.equal(await support.refreshSupport('focus'), true);
  assert.equal(await support.refreshSupport('focus'), false);
  assert.equal(await support.refreshSupport('popup'), false);
  assert.equal(requests.filter(r => r.url.endsWith('/paid/support')).length, 1);
});
await check('Support: a moved support token reads the conversation (no timer)', async () => {
  // A move seen within 3 s of our own read came with that read's fresh state; wait past it.
  await settled(); await sleep(3100);
  requests.length = 0;
  const changes = { [signals.CHANGE_KEY]: { oldValue: { scope: 'x', seq: 1, changed: [] }, newValue: { scope: 'x', seq: 2, changed: ['support'] } } };
  for (const fn of storageListeners) fn(changes, 'local');
  await until(() => requests.some(r => r.url.endsWith('/paid/support'))); await settled();
  assert.equal(requests.filter(r => r.url.endsWith('/paid/support')).length, 1);
  requests.length = 0;
  const other = { [signals.CHANGE_KEY]: { oldValue: { scope: 'x', seq: 2 }, newValue: { scope: 'x', seq: 3, changed: ['prices'] } } };
  for (const fn of storageListeners) fn(other, 'local');
  for (let i = 0; i < 40; i++) await tick();
  assert.equal(requests.filter(r => r.url.endsWith('/paid/support')).length, 0, 'other topics do not read the chat');
});
await check('Support: after a sent message the follow-up backs off 1, 2, 5 min and stops once the admin answered', async () => {
  const frame = { tab: { id: 5 }, url: 'chrome-extension://qa/support/chat.html?dock=1' };
  await settled();
  await runtime({ type: 'TP_SUPPORT_SENT' }, frame);
  await until(() => alarms.has('tp-support-followup'));
  const due = () => alarms.get('tp-support-followup')?.when - Date.now();
  assert(Math.abs(due() - 60000) < 2000, 'first follow-up after 1 min');
  const fire = async () => {
    const before = alarms.get('tp-support-followup')?.when;
    for (const fn of alarmListeners) fn({ name: 'tp-support-followup' });
    await until(() => alarms.get('tp-support-followup')?.when !== before); await settled();
  };
  await fire();
  assert(Math.abs(due() - 120000) < 2000, 'then 2 min');
  await fire();
  assert(Math.abs(due() - 300000) < 2000, 'then 5 min');
  reply = () => new Response(JSON.stringify({ email: 'customer@example.invalid', enabled: true, thread: { unread: 1, last_seq: 2, last_admin_seq: 2, state: 'waiting_customer' } }));
  await fire();
  assert(!alarms.has('tp-support-followup'), 'an admin reply ends the follow-up');
  assert.equal(session.supportPollState.followUp, null);
  reply = () => new Response(JSON.stringify({ email: 'customer@example.invalid', enabled: true, thread: { unread: 0, last_seq: 2, state: 'waiting_admin' } }));
});
await check('Support: presence only from the expanded chat frame, at most every 2 min', async () => {
  const frame = { tab: { id: 5 }, url: 'chrome-extension://qa/support/chat.html?dock=1' };
  requests.length = 0;
  await runtime({ type: 'TP_SUPPORT_ACTIVITY' }, { tab: { id: 5 }, url: 'https://publisher.example/' });
  await runtime({ type: 'TP_SUPPORT_ACTIVITY', reason: 'minimized' }, frame);
  for (let i = 0; i < 40; i++) await tick();
  assert.equal(requests.filter(r => r.url.endsWith('/presence')).length, 0);
  await runtime({ type: 'TP_SUPPORT_ACTIVITY', reason: 'expanded' }, frame);
  for (let i = 0; i < 40; i++) await tick();
  await runtime({ type: 'TP_SUPPORT_ACTIVITY', reason: 'typing' }, frame);
  for (let i = 0; i < 40; i++) await tick();
  assert.equal(requests.filter(r => r.url.endsWith('/presence')).length, 1);
});

// ---- chat frame, dock, popup: no idle timers ----------------------------------------
await check('Chat frame: no periodic timers; long-poll only while expanded or awaiting a reply', async () => {
  const chat = src('support/chat.js');
  assert(!/setInterval\(/.test(chat), 'no setInterval in the chat frame');
  assert(/liveWanted\(\)/.test(chat) && /view === 'expanded' \|\| \(view !== 'hidden' && awaitingReply\(\)\)/.test(chat));
  assert(/TP_SUPPORT_ACTIVITY', reason/.test(chat));
  const { createLiveUpdates } = await load('support/live.js');
  let expanded = true, waits = 0;
  const live = createLiveUpdates({ shouldRun: () => expanded, wait: async () => { waits++; await tick(); return { changed: false }; },
    onResult: async () => {}, sleep: async () => { expanded = false; } });
  live.start(); for (let i = 0; i < 20; i++) await tick();
  assert.equal(live.active, false, 'the loop ends when the chat is no longer expanded');
  assert.equal(waits, 1);
});
await check('Dock: layout follows resize/visualViewport/observers, no 1 s or 30 s timers', async () => {
  const dock = src('content/support-dock.js');
  assert(!/setInterval\(/.test(dock));
  assert(/visualViewport/.test(dock) && /MutationObserver/.test(dock) && /ResizeObserver/.test(dock));
  assert(!/TP_SUPPORT_ACTIVITY/.test(dock), 'pages never report presence');
});
await check('Popup: Paid balance/prices and OpenRouter rates have no fixed refresh timers', async () => {
  const paid = src('popup/controllers/paid-service-controller.js'), usage = src('popup/controllers/usage-view-controller.js');
  assert(!/600000/.test(paid) && /changedTopics\(changes\)/.test(paid) && /AI_USAGE_STORAGE_KEY/.test(paid));
  assert(!/60000\);rateRefreshTimer/.test(usage) && !/scheduleRateRefresh/.test(usage));
  const { TRIGGER_MIN_MS, USAGE_MIN_MS, PASSIVE_OPENROUTER_MS } = await load('popup/controllers/usage-view-controller.js');
  assert.equal(TRIGGER_MIN_MS, 60000); assert.equal(USAGE_MIN_MS, 300000); assert.equal(PASSIVE_OPENROUTER_MS, 3600000);
  assert(/maybeRefreshRate\(ledger,selected,'open'\)/.test(usage), 'the rates dialog asks for a fresh price');
  assert(/refreshImpl\(false,\[\],'model'\)/.test(usage), 'a model change asks for a fresh price');
});
await check('Popup API gate: offline retries back off instead of a 5 s interval', async () => {
  const { createApiAvailabilityGate } = await load('popup/controllers/api-availability-gate.js');
  const delays = [];
  const gate = createApiAvailabilityGate({ els: {}, checkApi: () => {}, events: null,
    setTimeoutFn: (_fn, ms) => { delays.push(ms); return delays.length; }, clearTimeoutFn: () => {} });
  gate.failure({ definitive: true });
  assert.deepEqual(delays, [5000]);
  gate.failure({ definitive: true }); // still pending: no second timer
  assert.deepEqual(delays, [5000]);
  gate.dispose();
});

// ---- pending orders -----------------------------------------------------------------
await check('Pending payment polling is bounded and resumes on an account change token', async () => {
  const { createPaymentMonitor, PAYMENT_POLL_MS } = await load('paid/payment.js');
  const delays = [], timers = new Map(), listeners = [];
  let seq = 0, calls = 0;
  const monitor = createPaymentMonitor({ request: async () => { calls++; return { id: 'ord_' + 'a'.repeat(32), status: 'waiting' }; },
    schedule: (fn, ms) => { delays.push(ms); timers.set(++seq, fn); return seq; }, unschedule: key => timers.delete(key),
    storageEvents: { addListener: fn => listeners.push(fn), removeListener() {} } });
  monitor.watch({ id: 'ord_' + 'a'.repeat(32), status: 'waiting' });
  while (timers.size) { const [key, fn] = [...timers][0]; timers.delete(key); fn(); for (let i = 0; i < 10; i++) await tick(); }
  assert.deepEqual(delays, [...PAYMENT_POLL_MS]);
  assert.equal(timers.size, 0, 'stops after the last step');
  const before = calls;
  listeners[0]({ [signals.CHANGE_KEY]: { newValue: { scope: 's', seq: 9, changed: ['account'] }, oldValue: { scope: 's', seq: 8 } } }, 'local');
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(calls, before + 1, 'an account change re-reads the order once');
  monitor.dispose();
});
await check('Pending add-on order polling is bounded', async () => {
  const { createAddonActions, ADDON_POLL_MS } = await load('paid/addons.js');
  const delays = [], timers = new Map();
  let seq = 0;
  const data = { addons: { orders: [{ id: 'ado_' + 'b'.repeat(32), status: 'waiting' }] } };
  let actions;
  actions = createAddonActions({ client: { request: async () => ({ status: 'waiting' }), identity: async () => ({ base: 'b', token: 't' }) },
    read: async () => ({}), write: async () => {}, load: async () => actions.sync(data), live: () => true, open: async () => {},
    setTimeoutFn: (fn, ms) => { delays.push(ms); timers.set(++seq, fn); return seq; }, clearTimeoutFn: key => timers.delete(key) });
  actions.sync(data);
  while (timers.size) { const [key, fn] = [...timers][0]; timers.delete(key); fn(); for (let i = 0; i < 10; i++) await tick(); }
  assert.deepEqual(delays, [...ADDON_POLL_MS]);
  actions.dispose();
});

// ---- Login alarms -------------------------------------------------------------------
await check('Login alarms exist only while a sign-in flow is pending', async () => {
  const { createFlowAlarm } = await load('background/login/flow-alarm.js');
  const created = [], cleared = [];
  const alarm = createFlowAlarm('qa', { alarms: { create: (n, i) => created.push([n, i]), clear: (n, cb) => { cleared.push(n); cb(); } } });
  await alarm.disarm(); await alarm.disarm();
  alarm.arm(); alarm.arm();
  await alarm.disarm();
  assert.deepEqual(created, [['qa', { periodInMinutes: 0.5 }]]);
  assert.deepEqual(cleared, ['qa', 'qa']);
  for (const path of ['background/login-auth.js', 'background/login/webchat/login_webchat_background.js', 'background/login/endpoint/login_endpoint_background.js']) {
    const text = src(path);
    assert(!/^chrome\.alarms\.create\(/m.test(text), path + ' creates no alarm at load');
    assert(/arm\(\)/.test(text) && /disarm\(\)/.test(text), path + ' arms/disarms with the flow');
  }
  const { createLoginAuthWorker } = await (async () => {
    // login-auth.js registers chrome listeners at import; give it inert ones.
    chrome.tabs.onUpdated = { addListener() {} }; chrome.webNavigation = { onBeforeNavigate: { addListener() {} } };
    return load('background/login-auth.js');
  })();
  const states = [];
  const worker = createLoginAuthWorker({ read: async () => ({}), onActive: active => states.push(active), currentBase: async () => '' });
  await worker.wake();
  assert.deepEqual(states, [false], 'no pending flow: the alarm is removed');
  worker.dispose();
});

const failed = results.filter(r => !r.passed);
console.log(JSON.stringify({ checks: results.length, passed: results.length - failed.length, failures: failed }, null, 2));
process.exitCode = failed.length ? 1 : 0;
