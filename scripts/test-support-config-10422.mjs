import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = process.env.TP_QA_EXTENSION_ROOT
  ? resolve(process.env.TP_QA_EXTENSION_ROOT)
  : fileURLToPath(new URL('..', import.meta.url));
const { createSupportConfiguration } = await import(pathToFileURL(join(projectRoot, 'src/support/config.js')));
const results = [];
const A = 'https://api-one-qa.example', B = 'https://api-two-qa.example';
const tick = () => new Promise(resolve => setImmediate(resolve));
const ok = data => ({ ok: true, json: async () => data });
function harness(extra = {}) {
  const saved = { customApiUrl: A, ...extra }, requests = [], writes = [];
  let response = async () => ok({ ok: true, paid: { configured: true } });
  const config = createSupportConfiguration({
    read: async () => structuredClone(saved),
    write: async value => { writes.push(structuredClone(value)); Object.assign(saved, value); },
    fetchFn: async (url, options) => { requests.push({ url, options }); return response(url, options); },
  });
  return { saved, requests, writes, config, respond: value => response = value };
}
async function check(name, test) {
  try { await test(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.code || error.name }); }
}
await check('No selected API is hidden without a fetch', async () => {
  const h = harness({ customApiUrl: '', apiUrlDefault: '' });
  assert.deepEqual(await h.config.check(), { configured: false }); assert.equal(h.requests.length, 0);
});
await check('Invalid explicit custom API never falls back to managed default', async () => {
  const h = harness({ customApiUrl: 'https://invalid-qa.example/?private=x', apiUrlDefault: A });
  assert.deepEqual(await h.config.check(), { configured: false }); assert.equal(h.requests.length, 0);
});
await check('All modes login states and disabled policy preserve configured-only gate', async () => {
  for (const mode of ['manual', 'paid', 'local']) for (const signedIn of [true, false]) {
    const h = harness({ aiServiceMode: mode, paidSessionToken: signedIn ? 'a'.repeat(64) : '', supportEnabled: false });
    h.respond(async () => ok({ ok: true, paid: { configured: true, available: false }, enabled: false }));
    assert.deepEqual(await h.config.check(), { configured: true });
    assert.deepEqual(Object.keys(await h.config.check()), ['configured']);
    assert.equal(h.saved.aiServiceMode, mode);
    assert.equal(h.saved.paidSessionToken, signedIn ? 'a'.repeat(64) : '');
    assert(h.writes.length > 0);
    for (const patch of h.writes) assert.deepEqual(Object.keys(patch), ['supportConfiguration']);
  }
});
await check('Available without explicit configured true never enables gate', async () => {
  for (const paid of [{ available: true }, { configured: false, available: true }, { configured: 'true' }, null]) {
    const h = harness(); h.respond(async () => ok({ ok: true, paid }));
    assert.deepEqual(await h.config.check(), { configured: false });
  }
});
await check('Same API retains last verified true during offline failure', async () => {
  const h = harness({ supportConfiguration: { base: A, configured: true } });
  h.respond(async () => { throw new TypeError('offline'); });
  assert.deepEqual(await h.config.check(), { configured: true }); assert.equal(h.writes.length, 0);
});
await check('Different API does not inherit old API verified state when offline', async () => {
  const h = harness({ customApiUrl: B, supportConfiguration: { base: A, configured: true } });
  h.respond(async () => { throw new TypeError('offline'); });
  assert.deepEqual(await h.config.check(), { configured: false });
});
await check('Offline with no successful configuration evidence stays hidden', async () => {
  const h = harness(); h.respond(async () => { throw new TypeError('offline'); });
  assert.deepEqual(await h.config.check(), { configured: false });
});
await check('Invalid metadata envelopes do not erase same API successful state', async () => {
  for (const data of [null, [], { ok: false, paid: null }]) {
    const h = harness({ supportConfiguration: { base: A, configured: true } }); h.respond(async () => ok(data));
    assert.deepEqual(await h.config.check(), { configured: true }); assert.equal(h.writes.length, 0);
  }
});
await check('Old API failure cannot return true after selected API changed', async () => {
  const h = harness({ supportConfiguration: { base: A, configured: true } }); let fail;
  h.respond(() => new Promise((_, reject) => fail = reject));
  const pending = h.config.check(); await tick(); h.saved.customApiUrl = B; h.config.invalidate(); fail(new TypeError('offline'));
  assert.deepEqual(await pending, { configured: false }); assert.equal(h.writes.length, 0);
});
await check('Old API success cannot write or return true after API changed', async () => {
  const h = harness(); let release;
  h.respond(() => new Promise(resolve => release = resolve));
  const pending = h.config.check(); await tick(); h.saved.customApiUrl = B; h.config.invalidate(); release(ok({ ok: true, paid: { configured: true } }));
  assert.deepEqual(await pending, { configured: false }); assert.equal(h.writes.length, 0);
});
await check('Same API simultaneous requests share one metadata fetch', async () => {
  const h = harness(); let release;
  h.respond(() => new Promise(resolve => release = resolve));
  const pending = [h.config.check(), h.config.check(), h.config.check({ force: true })]; await tick();
  assert.equal(h.requests.length, 1); release(ok({ ok: true, paid: { configured: true } }));
  assert.deepEqual(await Promise.all(pending), [{ configured: true }, { configured: true }, { configured: true }]);
});
await check('Fresh same API cache avoids extra metadata work', async () => {
  const h = harness(); await h.config.check(); await h.config.check(); await h.config.check();
  assert.equal(h.requests.length, 1);
});
await check('Metadata transport uses no identity cookies redirects or Center URL', async () => {
  const h = harness({ paidSessionToken: 'a'.repeat(64), paidApiBase: A });
  assert.deepEqual(await h.config.check({ url: 'https://publisher-qa.example' }), { configured: true });
  const request = h.requests[0]; assert.equal(request.url, A + '/meta');
  assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.headers?.Authorization, undefined);
});
await check('Successful explicit unconfigured response clears old positive evidence', async () => {
  const h = harness({ supportConfiguration: { base: A, configured: true } });
  h.respond(async () => ok({ ok: true, paid: null }));
  assert.deepEqual(await h.config.check(), { configured: false });
  assert.deepEqual(h.saved.supportConfiguration, { base: A, configured: false });
});
await check('Malformed JSON during outage preserves old positive evidence', async () => {
  const h = harness({ supportConfiguration: { base: A, configured: true } });
  h.respond(async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid'); } }));
  assert.deepEqual(await h.config.check(), { configured: true }); assert.equal(h.writes.length, 0);
});
await check('Non-success metadata response preserves old positive evidence', async () => {
  const h = harness({ supportConfiguration: { base: A, configured: true } });
  h.respond(async () => ({ ok: false, json: async () => ({ ok: false }) }));
  assert.deepEqual(await h.config.check(), { configured: true }); assert.equal(h.writes.length, 0);
});
await check('Cache persistence failure cannot erase newly confirmed configured state', async () => {
  let online = true;
  const config = createSupportConfiguration({
    read: async () => ({ customApiUrl: A, supportConfiguration: { base: A, configured: false } }),
    write: async () => { throw new Error('storage unavailable'); },
    fetchFn: async () => { if (!online) throw new TypeError('offline'); return ok({ ok: true, paid: { configured: true } }); },
  });
  assert.deepEqual(await config.check(), { configured: true });
  assert.deepEqual(await config.check(), { configured: true });
  online = false; assert.deepEqual(await config.check({ force: true }), { configured: true });
});
await check('Cache persistence failure cannot preserve confirmed removed configuration', async () => {
  let online = true;
  const config = createSupportConfiguration({
    read: async () => ({ customApiUrl: A, supportConfiguration: { base: A, configured: true } }),
    write: async () => { throw new Error('storage unavailable'); },
    fetchFn: async () => { if (!online) throw new TypeError('offline'); return ok({ ok: true, paid: null }); },
  });
  assert.deepEqual(await config.check(), { configured: false });
  assert.deepEqual(await config.check(), { configured: false });
  online = false; assert.deepEqual(await config.check({ force: true }), { configured: false });
});
await check('API switch during asynchronous cache persistence cannot return old scope true', async () => {
  const saved = { customApiUrl: A }; let finishWrite;
  const config = createSupportConfiguration({
    read: async () => structuredClone(saved),
    write: async () => await new Promise(resolve => finishWrite = resolve),
    fetchFn: async () => ok({ ok: true, paid: { configured: true } }),
  });
  const pending = config.check(); await tick(); assert.equal(typeof finishWrite, 'function');
  saved.customApiUrl = B; config.invalidate(); finishWrite();
  assert.deepEqual(await pending, { configured: false });
});
const report = { scope: '10422-trusted-configuration-gate', checks: results.length, cases: results.length, passed: results.filter(result => result.passed).length, results, external_io: false };
const output = process.env.TP_QA_SUPPORT_CONFIG_OUTPUT ||
  (process.env.TP_QA_OUTPUT ? join(process.env.TP_QA_OUTPUT, 'config-report-10422.json') : '');
if (output) {
  const target = resolve(output);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = results.some(result => !result.passed) ? 1 : 0;
