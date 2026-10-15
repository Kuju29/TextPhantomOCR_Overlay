import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createAccountClient } from '../src/paid/client.js';
import { requestUnusedRefund } from '../src/paid/refunds.js';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
let accepts = true;
globalThis.confirm = () => accepts;
const identity = {
  customApiUrl: 'http://localhost:8811',
  paidApiBase: 'http://localhost:8811',
  paidSessionToken: 'qa-customer-session',
};
const calls = [];
let unknown = false;
const client = createAccountClient({
  read: async () => ({ ...identity }),
  fetchFn: async (url, options) => {
    calls.push({ url, options });
    if (unknown) throw new TypeError('Synthetic lost response');
    return new Response(JSON.stringify({ id: 'rfd_qa', status: 'queued' }), { status: 200 });
  },
});
const checks = [];
const test = async (name, fn) => {
  await fn();
  checks.push(name);
};
const payment = { id: 'pay_qa', refund: {} };
const lastBody = () => JSON.parse(calls.at(-1).options.body);

await test('Cancelled confirmation sends no refund and changes no request identity', async () => {
  accepts = false;
  assert.equal(await requestUnusedRefund(client, payment, 'scope-A'), false);
  assert.equal(calls.length, 0);
  accepts = true;
});
let firstKey;
await test('Confirmed refund uses the bounded customer route and Authorization', async () => {
  assert.equal(await requestUnusedRefund(client, payment, 'scope-A'), true);
  assert.equal(calls.at(-1).url, 'http://localhost:8811/paid/refunds');
  assert.equal(calls.at(-1).options.method, 'POST');
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer qa-customer-session');
  assert.equal(lastBody().payment_id, payment.id);
  firstKey = lastBody().request_key;
  assert.match(firstKey, /^[a-f0-9]{32}$/);
  assert(!calls.at(-1).options.body.includes(identity.paidSessionToken));
});
await test('Lost response and repeated request retain the same durable request key', async () => {
  unknown = true;
  await assert.rejects(() => requestUnusedRefund(client, payment, 'scope-A'));
  assert.equal(lastBody().request_key, firstKey);
  unknown = false;
  await requestUnusedRefund(client, payment, 'scope-A');
  assert.equal(lastBody().request_key, firstKey);
});
await test('Account scopes do not share refund request identities', async () => {
  await requestUnusedRefund(client, payment, 'scope-B');
  assert.notEqual(lastBody().request_key, firstKey);
});
await test('Only a confirmed failed refund allows a new request identity', async () => {
  await requestUnusedRefund(
    client,
    { ...payment, refund: { latest_request: { status: 'pending' } } },
    'scope-A',
  );
  assert.equal(lastBody().request_key, firstKey);
  await requestUnusedRefund(
    client,
    { ...payment, refund: { latest_request: { status: 'failed' } } },
    'scope-A',
  );
  assert.notEqual(lastBody().request_key, firstKey);
});
await test('Refund history pagination is accepted through the actual account client', async () => {
  await client.request('/paid/history?kind=refunds&offset=25&limit=25');
  assert.equal(calls.at(-1).options.method, 'GET');
  assert(calls.at(-1).url.endsWith('/paid/history?kind=refunds&offset=25&limit=25'));
});
await test('Refund path support does not expose admin, foreign-account or arbitrary routes', async () => {
  const before = calls.length;
  for (const path of [
    '/paid/refunds/other',
    '/paid/refunds?user_id=other',
    '/paid/refunds/../account',
    '/paid/refunds/../../api/admin/refunds',
    '//evil.example/paid/refunds',
    '/paid/history?kind=refunds&offset=0&limit=25&user_id=other',
    '/paid/history?kind=refunds&offset=0&limit=25&ledger_filter=admin',
  ])
    await assert.rejects(() => client.request(path, { body: {} }), {
      code: 'INVALID_ACCOUNT_PATH',
    });
  assert.equal(calls.length, before);
});
console.log(
  JSON.stringify(
    { scope: 'Actual refund/controller client with synthetic storage/fetch', checks, passed: true },
    null,
    2,
  ),
);
