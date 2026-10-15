// 10490 E2E finding (idle check): with a custom API URL saved, every API call
// (each support long-poll cycle, every translation request) went through
// resolveApiBase -> ensureApiDefaults, which fetched defaults_api.json from
// raw.githubusercontent.com whenever it was not cached. A failed fetch is not
// cached, so where GitHub is unreachable each call re-fetched it (up to 8 s each).
// A custom URL is the answer; the remote default cannot change it.
import assert from 'node:assert/strict';

const stored = {};
globalThis.chrome = {runtime:{}, storage:{local:{
  get(keys, callback) {
    const out = {};
    for (const [k, v] of Object.entries(typeof keys === 'object' && !Array.isArray(keys) ? keys : {})) out[k] = k in stored ? stored[k] : v;
    if (Array.isArray(keys)) for (const k of keys) out[k] = stored[k];
    callback(out);
  },
  set(values, callback) { Object.assign(stored, values); callback?.(); },
}}};
const fetched = [];
globalThis.fetch = async (url) => { fetched.push(String(url)); throw new TypeError('Failed to fetch'); };
const {resolveApiBase} = await import('../src/shared/api-defaults.js');

stored.customApiUrl = 'https://my-api.example';
for (let i = 0; i < 5; i++) assert.equal(await resolveApiBase(), 'https://my-api.example');
assert.deepEqual(fetched, [], 'a custom API URL needs no remote defaults read');
console.log('PASS custom API URL: no GitHub defaults fetch per API call');

// Without a custom URL the remote default is still read (and a cached one used).
delete stored.customApiUrl;
stored.apiUrlDefault = 'https://default.example';
assert.equal(await resolveApiBase(), 'https://default.example');
assert.equal(fetched.length, 1, 'no custom URL: the remote defaults are consulted');
stored.apiDefaultsFetchedAt = Date.now();
assert.equal(await resolveApiBase(), 'https://default.example');
assert.equal(fetched.length, 1, 'fresh cached defaults: no fetch');
// preferRemote keeps its meaning.
stored.customApiUrl = 'https://my-api.example';
assert.equal(await resolveApiBase({preferRemote:true}), 'https://default.example');
console.log('PASS default URL users and preferRemote unchanged');
