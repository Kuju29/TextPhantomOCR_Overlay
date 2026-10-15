// .78 "show on every page": dock injection into already-open tabs on install/update/startup,
// Contact admin from the popup: injects into open pages; pages that cannot host the dock
// get the popup message (.79: no standalone window). Simulated chrome.* boundary; not an installed-extension test.
// Run: node scripts/test-support-open-anywhere-10478.mjs
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;

const VERSION = '2026.10.4.78';
const tabs = new Map(), calls = [], installed = [], started = [], runtimeListeners = [], removedWindow = [];
let injecting = 0, maxInjecting = 0, windowsApi = true, nextWindow = 100, windows = new Map(), creates = 0;
const session = {}, local = {};
const pick = (store, keys) => Object.fromEntries([].concat(keys).map(key => [key, store[key]]));
const area = store => ({ get: (keys, cb) => queueMicrotask(() => cb(pick(store, keys))), set: (patch, cb) => queueMicrotask(() => { Object.assign(store, patch); cb?.(); }) });
const fail = (cb, message) => { chrome.runtime.lastError = { message }; cb(); chrome.runtime.lastError = null; };
globalThis.chrome = {
  runtime: { lastError: null, id: 'qa', getManifest: () => ({ version: VERSION }), getURL: path => 'chrome-extension://qa/' + path, sendMessage() {},
    onMessage: { addListener: fn => runtimeListeners.push(fn) }, onInstalled: { addListener: fn => installed.push(fn) }, onStartup: { addListener: fn => started.push(fn) } },
  storage: { local: area(local), session: area(session), onChanged: { addListener() {} } },
  tabs: {
    query(options, cb) { calls.push({ query: options }); cb(options.active ? [...tabs.values()].filter(tab => tab.active) : [...tabs.values()]); },
    get(id, cb) { const tab = tabs.get(id); tab ? cb(tab) : fail(cb, 'No tab'); },
    sendMessage(id, body, options, cb) {
      calls.push({ message: body.type, id, options }); const tab = tabs.get(id);
      if (body.type === 'TP_SUPPORT_PING') { tab?.receiver ? cb({ ready: true, version: tab.receiver }) : fail(cb, 'Receiving end does not exist'); return; }
      tab?.receiver ? cb({ ok: !tab.admin }) : fail(cb, 'Receiving end does not exist');
    },
    onRemoved: { addListener() {} },
  },
  scripting: { executeScript(options, cb) {
    const tab = tabs.get(options.target.tabId); calls.push({ inject: options });
    maxInjecting = Math.max(maxInjecting, ++injecting);
    setTimeout(() => { injecting--; if (tab.denied) { fail(cb, 'Cannot access contents of the page'); return; }
      tab.receiver = tab.pdf ? null : VERSION; cb([{ frameId: 0, documentId: 'doc-' + tab.id }]); }, 5);
  } },
  alarms: { create() {}, onAlarm: { addListener() {} } },
};
Object.defineProperty(chrome, 'windows', { configurable: true, get: () => windowsApi ? {
  create(options, cb) { creates++; const id = nextWindow++; windows.set(id, { id, state: 'normal', tabs: [{ url: options.url }], options }); setTimeout(() => cb({ id }), 5); },
  get(id, options, cb) { const found = windows.get(id); found ? cb(found) : fail(cb, 'No window with id: ' + id); },
  update(id, info, cb) { calls.push({ focus: id, info }); const found = windows.get(id); found ? cb(found) : fail(cb, 'No window'); },
  onRemoved: { addListener: fn => removedWindow.push(fn) },
} : undefined });
globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, paid: { configured: false } }));

const { injectSupportDocks } = await import('../src/background/support-dock.js');
await import('../src/background/support.js');
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log('PASS', name); }
  catch (error) { results.push({ name, passed: false, error: String(error?.stack || error) }); console.log('FAIL', name, error); }
}
const tab = (id, url, extra = {}) => tabs.set(id, { id, url, ...extra });
const injected = () => calls.filter(call => call.inject).map(call => call.inject.target.tabId).sort((a, b) => a - b);
const popupSender = { url: 'chrome-extension://qa/popup/popup.html' };
const show = () => new Promise(resolve => { for (const fn of runtimeListeners) fn({ type: 'TP_SUPPORT_SHOW' }, popupSender, resolve); });

await test('Install/update injects only ordinary open pages that lack the current dock', async () => {
  tabs.clear(); calls.length = 0; maxInjecting = 0;
  tab(1, 'https://reader.example/ch1', { receiver: VERSION });     // already current
  tab(2, 'https://reader.example/ch2');                            // opened before install
  tab(3, 'http://plain.example/');
  tab(4, 'file:///home/qa/page.html');
  tab(5, 'https://news.example/', { receiver: '2026.10.4.77' });   // orphaned previous version
  tab(6, 'brave://extensions/'); tab(7, 'chrome://settings/'); tab(8, 'edge://extensions/'); tab(9, 'about:blank');
  tab(10, 'chrome-extension://other/page.html'); tab(11, undefined); // no host access: URL hidden
  tab(12, 'https://lazy.example/', { discarded: true });
  tab(13, 'https://chromewebstore.google.com/detail/x', { denied: true });
  for (let id = 20; id < 30; id++) tab(id, 'https://many.example/' + id);
  const counts = await injectSupportDocks();
  assert.deepEqual(injected(), [2, 3, 4, 5, 13, ...Array.from({ length: 10 }, (_, i) => 20 + i)]);
  for (const call of calls.filter(call => call.inject)) assert.deepEqual({ ...call.inject, target: { ...call.inject.target, tabId: 0 } },
    { target: { tabId: 0, frameIds: [0] }, files: ['content/support-dock.js'] });
  assert.equal(counts.injected, 14); assert.equal(counts.failed, 1);
  assert(maxInjecting <= 4, 'bounded parallel injection: ' + maxInjecting);
});
await test('A second run (e.g. browser start) does not inject twice', async () => {
  calls.length = 0;
  const counts = await injectSupportDocks();
  assert.deepEqual(injected(), [13], 'only the page that refused before is retried');
  assert.equal(counts.injected, 0);
});
await test('onInstalled and onStartup listeners trigger the injection', async () => {
  assert(installed.length >= 1 && started.length >= 1, 'support.js registers install/startup listeners');
  tabs.clear(); calls.length = 0; tab(40, 'https://fresh.example/');
  for (const fn of installed) fn({ reason: 'update' });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(injected(), [40]);
});
await test('Contact admin on an ordinary page injects first, then opens the dock (no window)', async () => {
  tabs.clear(); calls.length = 0; creates = 0;
  tab(50, 'https://reader.example/new', { active: true });
  const result = await show();
  assert.equal(result.ok, true); assert.equal(creates, 0);
  const order = calls.filter(call => call.inject || call.message === 'TP_SUPPORT_OPEN').map(call => call.inject ? 'inject' : 'open');
  assert.deepEqual(order, ['inject', 'open']);
});
await test('.79 owner rule: brave://extensions and other unscriptable pages open no chat window', async () => {
  for (const [id, url, extra] of [[60, 'brave://extensions/', {}], [70, 'https://example.test/70', { denied: true }], [71, 'https://example.test/71', { pdf: true }]]) {
    tabs.clear(); calls.length = 0; windows.clear(); creates = 0;
    tab(id, url, { active: true, ...extra });
    const result = await show();
    assert.equal(result.ok, false, url); assert.equal(creates, 0, 'no window for ' + url);
    assert.ok(['SUPPORT_PAGE_UNAVAILABLE', 'SUPPORT_DOCK_UNAVAILABLE'].includes(result.code), result.code);
  }
});
await test('Refusals that are not page limits (Control Center admin page) do not open a window', async () => {
  tabs.clear(); creates = 0;
  tab(80, 'https://center.example/', { active: true, receiver: VERSION, admin: true });
  const result = await show();
  assert.equal(result.ok, false); assert.equal(creates, 0);
});
await test('Only the extension popup may request Contact admin', async () => {
  const result = await new Promise(resolve => { for (const fn of runtimeListeners) fn({ type: 'TP_SUPPORT_SHOW' }, { url: 'https://evil.example/' }, resolve); });
  assert.equal(result.ok, false);
});
const passed = results.filter(result => result.passed).length;
console.log(JSON.stringify({ checks: results.length, passed, scope: 'Simulated Chrome API; not installed-extension evidence', failures: results.filter(r => !r.passed) }, null, 2));
if (passed !== results.length) process.exit(1);
