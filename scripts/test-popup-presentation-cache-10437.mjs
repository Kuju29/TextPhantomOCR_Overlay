import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { accountScope } from '../src/paid/inline.js';
import { createPaidServiceController } from '../src/popup/controllers/paid-service-controller.js';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const element = (value = '') => ({ value, textContent: '', style: {}, disabled: false,
  handlers: {}, attrs: {}, addEventListener(name, fn) { this.handlers[name] = fn; },
  removeEventListener() {}, setAttribute(name, value) { this.attrs[name] = value; },
  replaceChildren(...children) { this.children = children; }, focus() {} });
globalThis.document = { createElement: () => element(), visibilityState: 'visible' };
const base = 'http://localhost:7860', token = 'test-customer-session', time = Date.now();
const account = { email: 'customer@example.com', credits: { available: '10000', held: '20' },
  models: [{ id: 'demo/model', name: 'Demo model', eligible_tp: '10000' }], paid_paused: false };
const storage = { tpDataConsentV1: {version: 1, granted: true, at: 1}, aiServiceMode: 'paid', paidSessionToken: token, paidApiBase: base, paidModel: 'demo/model',
  paidAccountViewCacheV1: { version: 1, scope: await accountScope(base, token), updatedAt: time, me: account } };
const names = ['mode', 'sources', 'apiUrl', 'aiService', 'aiPaidCredits', 'aiPaidHeld', 'aiPaidAccountState',
  'aiPaidModel', 'aiPaidLogin', 'aiPaidAccount', 'aiPaidRefresh', 'aiPaidLogout', 'aiPaidStatus'];
const els = Object.fromEntries(names.map(name => [name, element()]));
els.mode.value = 'lens_text'; els.sources.value = 'ai'; els.apiUrl.value = base;
const state = { lastSavedApiUrl: base };
let controller, release, calls = 0;
globalThis.fetch = async () => { calls++; return new Promise(resolve => { release = () => resolve({
  ok: true, json: async () => ({ ...account, credits: { available: '9000', held: '0' } }),
}); }); };
controller = createPaidServiceController({ els, state, now: () => time,
  getStorage: async () => structuredClone(storage), setStorage: async patch => Object.assign(storage, structuredClone(patch)),
  toggleUi: () => controller.applyVisibility() });
await controller.initialize();
assert.equal(els.aiPaidCredits.textContent, '10,000 TP', 'Popup reopening should paint the previous balance before waiting for the server.');
assert.equal(state.paidReady, false, 'A cached balance must never authorize translation.');
assert.equal(els.aiPaidModel.disabled, false, '.72 owner rule: the remembered model list is selectable at reopen');
controller.setAvailability(true, base);
for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
assert.equal(calls, 1);
assert.equal(els.aiPaidCredits.textContent, '10,000 TP');
release();
for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
assert.equal(els.aiPaidCredits.textContent, '9,000 TP');
assert.equal(state.paidReady, true);
controller.dispose();
console.log('PASS popup paints saved balance immediately, verifies fresh balance before translation.');
