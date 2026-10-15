// .78 live chat client: long-poll loop (src/support/live.js) and the support client's wait
// path, cancellation and status reporting (src/support/client.js). Offline, simulated time.
// Run: node scripts/test-support-live-10478.mjs
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
const { createLiveUpdates, waitPath, unsupportedWait } = await import('../src/support/live.js');
const { createSupportClient } = await import('../src/support/client.js');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log('PASS', name); }
  catch (error) { results.push({ name, passed: false, error: String(error?.stack || error) }); console.log('FAIL', name, error); }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function harness({ responses, run = () => true }) {
  const clock = { now: 0 }, events = [], warnings = [], infos = [];
  const live = createLiveUpdates({
    shouldRun: run,
    sleep: async ms => { clock.now += ms; events.push(['sleep', ms]); await settle(); },
    now: () => clock.now,
    log: { warn: message => warnings.push(message), info: message => infos.push(message) },
    wait: async signal => {
      const next = responses.shift();
      events.push(['wait']);
      if (!next) { live.stop(); throw Object.assign(new Error('stopped'), { name: 'AbortError' }); }
      if (next.hang) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      clock.now += next.after || 0;
      if (next.error) throw next.error;
      return next.result;
    },
    onResult: async result => events.push(['result', result.changed]),
    onFallbackTick: async () => events.push(['tick']),
    onAuthError: async error => events.push(['auth', error.status]),
  });
  return { live, clock, events, warnings, infos };
}
const until = async predicate => { for (let i = 0; i < 400 && !predicate(); i++) await settle(); assert(predicate(), 'condition not reached'); };

await test('waitPath is bounded and matches the client allowlist', async () => {
  assert.equal(waitPath({ after: 12, version: 1700000000000 }), '/paid/support/wait?after=12&version=1700000000000&timeout=25');
  assert.equal(waitPath({ after: -3, version: 'x', timeout: 99 }), '/paid/support/wait?after=0&version=0&timeout=25');
  assert.equal(unsupportedWait({ status: 404 }), true); assert.equal(unsupportedWait({ status: 429 }), false);
});
await test('Changes are applied as they arrive; quiet answers are spaced (no request loop)', async () => {
  const h = harness({ responses: [{ after: 25000, result: { changed: false, timeout: true } }, { after: 300, result: { changed: true } }, { after: 0, result: { changed: false } }] });
  h.live.start();
  await until(() => !h.live.active);
  const waits = h.events.filter(e => e[0] === 'wait').length;
  assert.equal(waits, 4);
  assert.deepEqual(h.events.filter(e => e[0] === 'result').map(e => e[1]), [false, true, false]);
  assert(h.events.some(e => e[0] === 'sleep' && e[1] === 1000), 'an immediate unchanged answer waits ≥1 s before the next request');
  assert.deepEqual(h.warnings, []);
});
await test('Older API/Center without the wait endpoint: explicit one-time warning, 15 s refresh, later re-probe', async () => {
  const notFound = Object.assign(new Error('Not Found'), { status: 404, code: 'SUPPORT_FAILED' });
  const responses = [{ error: notFound }, { error: notFound }, { result: { changed: true } }];
  const h = harness({ responses });
  h.live.start();
  await until(() => h.events.filter(e => e[0] === 'wait').length >= 3 || !h.live.active);
  h.live.stop();
  assert.equal(h.warnings.length, 1, 'logged once, not per attempt');
  assert.match(h.warnings[0], /unavailable.*HTTP 404.*polling every 15 s/);
  const ticks = h.events.filter(e => e[0] === 'tick').length;
  assert(ticks >= 40, 'refreshes every 15 s for ~10 minutes before probing again: ' + ticks);
  assert(h.events.filter(e => e[0] === 'sleep').every(e => e[1] === 15000 || e[1] === 250 || e[1] === 1000));
  assert.equal(h.infos.length, 1, 'restoring live mode is logged');
});
await test('Sign-out/expired session stops the loop and reports once', async () => {
  const h = harness({ responses: [{ error: Object.assign(new Error('Sign in'), { status: 401, code: 'SIGN_IN_REQUIRED' }) }, { result: { changed: true } }] });
  h.live.start();
  await until(() => !h.live.active);
  assert.deepEqual(h.events.filter(e => e[0] === 'auth'), [['auth', 401]]);
  assert.equal(h.events.filter(e => e[0] === 'wait').length, 1);
});
await test('Busy (429) and network errors back off exponentially and keep refreshing', async () => {
  const busy = Object.assign(new Error('busy'), { status: 429 }), offline = new TypeError('Failed to fetch');
  const h = harness({ responses: [{ error: busy }, { error: offline }, { error: offline }, { result: { changed: true } }] });
  h.live.start();
  await until(() => !h.live.active);
  assert.deepEqual(h.events.filter(e => e[0] === 'sleep').slice(0, 3).map(e => e[1]), [2000, 4000, 8000]);
  assert.equal(h.events.filter(e => e[0] === 'tick').length, 3);
  assert.deepEqual(h.warnings, []);
});
await test('stop() aborts the in-flight wait; start() after stop runs one loop', async () => {
  const h = harness({ responses: [{ hang: true }, { hang: true }] });
  h.live.start(); h.live.start();
  await settle();
  assert.equal(h.events.filter(e => e[0] === 'wait').length, 1, 'a second start while running does nothing');
  h.live.stop(); await settle(); await settle();
  assert.equal(h.live.active, false);
  h.live.start(); await settle();
  assert.equal(h.events.filter(e => e[0] === 'wait').length, 2);
  h.live.stop();
});
await test('Hidden chat (shouldRun false) never starts a wait', async () => {
  const h = harness({ responses: [{ result: { changed: true } }], run: () => false });
  h.live.start(); await settle();
  assert.equal(h.events.length, 0); assert.equal(h.live.active, false);
});

// ---- client.js ----
const store = { customApiUrl: 'https://api.example', paidApiBase: 'https://api.example', paidSessionToken: 'a'.repeat(64) };
const read = async keys => Object.fromEntries(keys.map(key => [key, store[key]]));
await test('Client allows the wait path, sends the bearer and honours the caller signal and timeout', async () => {
  const seen = [];
  const fetchFn = (url, options) => new Promise((resolve, reject) => {
    seen.push({ url, options });
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const client = createSupportClient({ read, write: async () => {}, fetchFn });
  const controller = new AbortController();
  const pending = client.request(waitPath({ after: 3, version: 9 }), { signal: controller.signal, timeoutMs: 40000 });
  await settle(); await settle();
  assert.equal(seen[0].url, 'https://api.example/paid/support/wait?after=3&version=9&timeout=25');
  assert.equal(seen[0].options.headers.Authorization, 'Bearer ' + 'a'.repeat(64));
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  await assert.rejects(client.request('/paid/support/wait?after=1&version=2&timeout=25&x=1'), error => error.code === 'INVALID_SUPPORT_PATH');
});
await test('A non-JSON error page still reports its HTTP status (fallback detection)', async () => {
  const fetchFn = async () => new Response('<html>Not Found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } });
  const client = createSupportClient({ read, write: async () => {}, fetchFn });
  await assert.rejects(client.request(waitPath({})), error => error.status === 404 && unsupportedWait(error));
});

const passed = results.filter(r => r.passed).length;
console.log(JSON.stringify({ checks: results.length, passed, failures: results.filter(r => !r.passed) }, null, 2));
if (passed !== results.length) process.exit(1);
