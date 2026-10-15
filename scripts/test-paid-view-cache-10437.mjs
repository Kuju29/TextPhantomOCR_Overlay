import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { accountViewScope, createPaidViewCache, PAID_VIEW_CACHE_KEY, PAID_VIEW_CACHE_TTL_MS } from '../src/paid/view-cache.js';
import { createAccountClient } from '../src/paid/client.js';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const checks = [];
const check = async (name, work) => { await work(); checks.push(name); };
const base = 'http://localhost:7860', token = 'customer-fixture-token';
const scope = await accountViewScope(base, token);
let time = 1000000, storage = {};
const read = async () => structuredClone(storage), write = async patch => Object.assign(storage, structuredClone(patch));
const cache = createPaidViewCache({ read, write, now: () => time });
const summary = { email: 'customer@example.com', credits: { available: '12000', held: '0', bank_account: 'FORBIDDEN_BANK' },
  models: [{ id: 'demo/model', name: 'Demo model', eligible_tp: '12000', api_key: 'FORBIDDEN_MODEL_SECRET',
    model_capabilities: { reasoning: { supported: true } } }], token: 'FORBIDDEN_TOKEN', otp: 'FORBIDDEN_OTP' };
const account = { ...summary, packages: [{ id: 'pkg_new', name: 'New package', version: 3, credits: '10000', price_satang: 10000, months: 6,
    stripe_secret: 'FORBIDDEN_PACKAGE_SECRET' }], purchase: { ready: true, bank_account: 'FORBIDDEN_BANK' },
  addons: { products: [{ code: 'ai_login', name: 'Login', version: 4, terms: 'Public terms', price_satang: 9000, ready: true }],
    entitlements: [{ code: 'ai_login', status: 'active', provider_session: 'FORBIDDEN_PROVIDER_SESSION' }],
    orders: [{ checkout_url: 'https://FORBIDDEN_CHECKOUT' }] },
  history: { orders: { items: [{ id: 'FORBIDDEN_ORDER', qr: 'FORBIDDEN_QR' }], total: 1 } } };
await check('Safe prior account paints from a bounded cache without secrets, payment links or provider authority', async () => {
  await cache.remember(scope, 'account', account);
  const saved = JSON.stringify(storage);
  assert(!saved.includes('FORBIDDEN'));
  const restored = await cache.restore(scope, 'account');
  assert.equal(restored.credits.available, '12000');
  assert.equal(restored.packages[0].version, 3);
  assert.equal(restored.addons.products[0].terms, 'Public terms');
  assert.equal(restored.addons.entitlements[0].status, 'active');
  assert.equal(restored.models[0].model_capabilities, undefined);
  assert.deepEqual(restored.history.orders.items, []);
});
await check('Cache is isolated by both API and session without saving either token or an origin', async () => {
  const otherAccount = await accountViewScope(base, 'replacement-session'), otherServer = await accountViewScope('https://other.example', token);
  assert.equal(await cache.restore(otherAccount, 'account'), null);
  assert.equal(await cache.restore(otherServer, 'account'), null);
  assert(!JSON.stringify(storage).includes(token));
  assert(!JSON.stringify(storage).includes(base));
});
await check('Fresh summary cannot extend an explicitly requested older catalog freshness check', async () => {
  time += PAID_VIEW_CACHE_TTL_MS - 10;
  await cache.remember(scope, 'me', summary);
  assert((await cache.restore(scope, 'account'))?.packages.length);
  time += 10;
  assert.equal(await cache.restore(scope, 'account', {allowStale:false}), null);
  assert((await cache.restore(scope, 'account'))?.packages.length,'Last presentation stays until a current response replaces it.');
  assert.equal((await cache.restore(scope, 'me')).credits.available, '12000');
});
await check('Malformed and future cache records are discarded', async () => {
  const saved = structuredClone(storage);
  storage[PAID_VIEW_CACHE_KEY].meUpdatedAt = time + 1;
  assert.equal(await cache.restore(scope, 'me'), null);
  storage = saved;
  storage[PAID_VIEW_CACHE_KEY].scope = 'untrusted';
  assert.equal(await cache.restore(scope, 'me'), null);
  storage = saved;
});
await check('A late invalidation cannot remove a newly cached account with another scope', async () => {
  const replacement = await accountViewScope(base, 'replacement-session');
  await cache.remember(replacement, 'me', { ...summary, credits: { available: '2000' } });
  await cache.clear(scope);
  assert.equal((await cache.restore(replacement, 'me')).credits.available, '2000');
  await cache.clear(replacement);
  assert.equal(await cache.restore(replacement, 'me'), null);
});
await check('Concurrent account view reads coalesce; the next refresh still checks the server', async () => {
  let release, calls = 0;
  const identity = { customApiUrl: base, paidApiBase: base, paidSessionToken: token };
  const client = createAccountClient({ read: async () => identity, fetchFn: async () => {
    calls++; return new Promise(resolve => { release = () => resolve(new Response(JSON.stringify(account))); });
  } });
  const first = client.request('/paid/account'), second = client.request('/paid/account');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); release(); await Promise.all([first, second]);
  const third = client.request('/paid/account'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); release(); await third;
});
await check('Explicit orders are never coalesced or replayed', async () => {
  let calls = 0;
  const identity = { customApiUrl: base, paidApiBase: base, paidSessionToken: token };
  const client = createAccountClient({ read: async () => identity, fetchFn: async () => {
    calls++; return new Response(JSON.stringify({ ok: true }));
  } });
  await Promise.all([client.request('/paid/orders', { body: { request_key: 'first-order-key' } }),
    client.request('/paid/orders', { body: { request_key: 'second-order-key' } })]);
  assert.equal(calls, 2);
});
await check('Invalidation during the initial asynchronous storage read prevents dispatch', async () => {
  let release, calls = 0;
  const client = createAccountClient({ read: async () => new Promise(resolve => { release = () => resolve({
    customApiUrl: base, paidApiBase: base, paidSessionToken: token,
  }); }), fetchFn: async () => { calls++; return new Response('{}'); } });
  const old = client.request('/paid/account'); client.invalidate(); release();
  await assert.rejects(old, { code: 'STALE_ACCOUNT_RESPONSE' });
  assert.equal(calls, 0);
});
await check('A delayed storage event cannot cache the replacement account under the former account scope', async () => {
  let calls = 0;
  const identity = {customApiUrl:base,paidApiBase:base,paidSessionToken:'replacement-session'};
  const client = createAccountClient({read:async()=>identity,fetchFn:async()=>{
    calls++; return new Response(JSON.stringify(account));
  }});
  await assert.rejects(client.request('/paid/account',{expectedScope:scope}),{code:'STALE_ACCOUNT_RESPONSE'});
  assert.equal(calls,0,'The account attached to this view must match before dispatch.');
  assert.equal(await client.request('/paid/account',{expectedScope:await accountViewScope(base,identity.paidSessionToken)}).then(x=>x.email),account.email);
});
console.log(JSON.stringify({ passed: true, checks, count: checks.length,
  scope: 'Production safe view cache and account client; fake clock, offline fixtures, no real purchases.' }, null, 2));
