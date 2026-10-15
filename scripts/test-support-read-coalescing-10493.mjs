import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

// 10493: owner logs (Center .91, extension .92) showed 3-5 identical
// GET /paid/support reads in the same second on every popup open, and per page
// load from each tab's dock. Each surface now shares one in-flight read; an
// account/API change still starts a fresh one. Nothing is cached after a read
// settles (the next popup open or page load asks again).
globalThis.crypto ??= webcrypto;
const saved = { supportActivated: true, paidSessionToken: 'a'.repeat(64), paidApiBase: 'http://localhost:7860', customApiUrl: 'http://localhost:7860' };
const storageListeners = [], runtimeListeners = [], reads = [];
let release = null;
const pick = keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(saved[key])]));
const area = { get: (keys, cb) => queueMicrotask(() => cb(pick(keys))), set: (patch, cb) => queueMicrotask(() => { Object.assign(saved, patch); cb?.(); }) };
globalThis.chrome = {
  runtime: { id: 'qa', getManifest: () => ({ version: 'qa' }), getURL: path => 'chrome-extension://qa/' + path, lastError: null,
    onMessage: { addListener: fn => runtimeListeners.push(fn) }, sendMessage: (message, cb) => dispatch(message, {}).then(cb) },
  storage: { local: area, session: area, onChanged: { addListener: fn => storageListeners.push(fn) } },
  tabs: { query: (_o, cb) => cb([]), onRemoved: { addListener() {} } },
};
// A held Center answer: every read started before release() is in flight together.
globalThis.fetch = async url => {
  if (String(url).endsWith('/meta')) return new Response(JSON.stringify({ ok: true, paid: { configured: true } }));
  reads.push(String(url));
  await new Promise(resolve => { const previous = release; release = () => { previous?.(); resolve(); }; });
  return new Response(JSON.stringify({ email: 'customer@example.invalid', enabled: true, thread: { unread: 0, last_seq: 1 } }));
};
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };
const supportReads = () => reads.filter(url => url.endsWith('/paid/support')).length;
function dispatch(message, sender) {
  return new Promise(resolve => {
    let handled = false;
    for (const fn of runtimeListeners) if (fn(message, sender, value => { handled = true; resolve(value); }) === true) handled = true;
    if (!handled) resolve(undefined);
  });
}
const results = [];

// --- background: TP_SUPPORT_AUTH from several tabs at once ---------------------
await import('../src/background/support.js');
await settle(); release?.(); await settle(); reads.length = 0; release = null; // worker-start hint
const asks = Array.from({ length: 4 }, (_, tab) => dispatch({ type: 'TP_SUPPORT_AUTH' }, { tab: { id: tab } }));
await settle();
assert.equal(supportReads(), 1, 'four tabs asking together share one read');
release(); release = null;
assert.deepEqual((await Promise.all(asks)).map(answer => answer.authenticated), [true, true, true, true]);
const later = dispatch({ type: 'TP_SUPPORT_AUTH' }, { tab: { id: 9 } });
await settle(); release(); release = null; await later;
assert.equal(supportReads(), 2, 'a settled read is not reused');
results.push('background TP_SUPPORT_AUTH: concurrent tabs share one read, no reuse after settle');

// --- content dock: script start + DOMContentLoaded + activity() on page load ---
{
  const docListeners = {}, winListeners = {};
  const document = { contentType: 'text/html', hidden: false, hasFocus: () => true, documentElement: {},
    getElementById: () => null, querySelector: () => null,
    addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); } };
  const window = { addEventListener: (type, fn) => { (winListeners[type] ||= []).push(fn); }, dispatchEvent() {} };
  window.top = window;
  let auths = 0;
  const chromeStub = { runtime: { id: 'qa', getManifest: () => ({ version: 'qa' }), getURL: path => 'chrome-extension://qa/' + path, lastError: null,
    sendMessage: (message, cb) => { if (message.type === 'TP_SUPPORT_AUTH') auths++; setTimeout(() => cb(message.type === 'TP_SUPPORT_AUTH' ? { authenticated: false } : {}), 5); },
    onMessage: { addListener() {}, removeListener() {} } },
    storage: { local: { get: (_k, cb) => cb({ supportActivated: true, supportDockHidden: false }) }, onChanged: { addListener: fn => (docListeners.storage ||= []).push(fn), removeListener() {} } } };
  const source = readFileSync(new URL('../src/content/support-dock.js', import.meta.url), 'utf8');
  new Function('window', 'document', 'chrome', 'globalThis', 'Event', 'innerWidth', 'innerHeight', source)(
    window, document, chromeStub, { chrome: chromeStub }, class { constructor(type) { this.type = type; } }, 1200, 800);
  docListeners.DOMContentLoaded.forEach(fn => fn());
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(auths, 1, 'one sign-in read per page load');
  docListeners.storage.forEach(fn => fn({ paidSessionToken: { newValue: 'b'.repeat(64) } }, 'local'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(auths, 2, 'an account change asks again');
  results.push('content dock: start + DOMContentLoaded + activity share one read; account change re-asks');
}

// --- popup entry: initial check + focus + visibilitychange on open -------------
{
  reads.length = 0; release = null;
  const winListeners = {}, docListeners = {};
  const element = () => ({ hidden: false, disabled: false, textContent: '', addEventListener() {} });
  const nodes = { 'contact-admin': element(), 'contact-admin-status': element(), 'contact-admin-badge': element(), 'contact-admin-unread': element() };
  globalThis.document = { getElementById: id => nodes[id] || null, visibilityState: 'visible',
    addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); } };
  globalThis.window = { addEventListener: (type, fn) => { (winListeners[type] ||= []).push(fn); }, close() {} };
  await import('../src/support/popup-entry.js');
  winListeners.focus.forEach(fn => fn());
  docListeners.visibilitychange.forEach(fn => fn());
  await settle();
  assert.equal(supportReads(), 1, 'popup open: one read for the initial check, focus and visibility');
  release(); release = null; await settle();
  assert.equal(nodes['contact-admin'].hidden, false, 'the shared answer still shows Contact admin');
  winListeners.focus.forEach(fn => fn());
  await settle(); release?.(); release = null; await settle();
  assert.equal(supportReads(), 2, 'returning to the popup later asks again');
  storageListeners.forEach(fn => fn({ paidSessionToken: { newValue: 'c'.repeat(64) } }, 'local'));
  await settle(); release?.(); release = null; await settle();
  assert.ok(supportReads() >= 3, 'an account change re-asks even right after a check');
  results.push('popup entry: open (initial + focus + visibility) shares one read; later return and account change re-ask');
}
console.log(JSON.stringify({ suite: 'support-read-coalescing-10493', passed: results.length, results }, null, 2));
