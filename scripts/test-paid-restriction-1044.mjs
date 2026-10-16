/** Real controllers/resolver, synthetic storage and read-only Center replies. */
import assert from 'node:assert/strict';
import { createPaidServiceController } from '../src/popup/controllers/paid-service-controller.js';
import { resolveJobAiProfile } from '../src/background/ai-profile-resolver.js';
import { isPaidAdmissionBlocked } from '../src/shared/diagnostic-policy.js';
import { userMessageForCode } from '../src/shared/error-contract.js';
const element = (value = '') => ({ value, textContent: '', style: { display: '' }, disabled: false,
  listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
  setAttribute() {}, replaceChildren(...children) { this.children = children; } });
globalThis.document = { createElement: () => element() };
const els = Object.fromEntries(['mode', 'sources', 'apiUrl', 'aiService', 'aiServiceWrap', 'aiPaidPanel',
  'aiProviderWrap', 'aiKeyWrap', 'aiModelWrap', 'aiEndpointWrap', 'aiPaidLogin', 'aiPaidAccount',
  'aiThinkingWrap', 'aiPromptWrap', 'aiCharactersWrap', 'aiPageImageWrap', 'aiRateWrap', 'aiTranslationModeWrap',
  'aiPaidStatus', 'aiPaidUnavailable', 'aiPaidModel', 'aiPaidAccountState'].map(k => [k, element()]));
const base = 'http://localhost:7860';
els.mode.value = 'lens_text'; els.sources.value = 'ai'; els.apiUrl.value = base;
let store = { tpDataConsentV1: { version: 1, granted: true, at: 1 }, aiServiceMode: 'paid', paidApiBase: base, paidSessionToken: 'qa-customer-session',
  paidModel: 'qa/test', customApiUrl: base, apiDefaultsFetchedAt: Date.now() };
globalThis.chrome = { storage: { local: {
  get(keys, cb) { const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || store);
    const out = Object.fromEntries(list.map(k => [k, store[k]])); cb?.(out); return Promise.resolve(out); },
  set(patch, cb) { Object.assign(store, structuredClone(patch)); cb?.(); return Promise.resolve(); },
} } };
let blocked = true; const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  return { ok: true, json: async () => String(url).endsWith('/paid/me') ? {
    email: 'fixture@gmail.com', credits: { available: '10000', held: '0' }, paid_paused: false,
    paid_restriction: { blocked, code: blocked ? 'PAID_ACCOUNT_RESTRICTED' : null },
    models: [{ id: 'qa/test', eligible_tp: '10000', model_capabilities: { reasoning: { supported: false } } }],
  } : { paid: { available: true } } };
};
const state = { lastSavedApiUrl: base };
const controller = createPaidServiceController({ els, state,
  getStorage: async keys => Object.fromEntries(keys.map(k => [k, store[k]])),
  setStorage: async patch => Object.assign(store, structuredClone(patch)), toggleUi: () => controller.applyVisibility() });
await controller.initialize(); controller.setAvailability(true, base);
for (let n = 0; n < 12; n++) await new Promise(r => setImmediate(r));
assert.equal(state.paidReady, false);
assert.equal(store.paidSessionToken, 'qa-customer-session');
assert.match(els.aiPaidAccountState.textContent, /Paid restricted/);
assert.match(els.aiPaidStatus.textContent, /refund\/dispute/);
assert.equal(els.aiPaidAccount.style.display, '');
await assert.rejects(() => resolveJobAiProfile(store), e => e.code === 'PAID_ACCOUNT_RESTRICTED');
assert(calls.every(c => !c.options.method || c.options.method === 'GET'));
assert(isPaidAdmissionBlocked({ code: 'paid_account_restricted' }));
assert.match(userMessageForCode('paid_account_restricted'), /refund\/dispute/);
blocked = false;
await controller.reconnect();
assert.equal(state.paidReady, true);
els.aiService.value = 'manual'; await els.aiService.listeners.change();
assert.equal(store.aiServiceMode, 'manual');
assert.equal(state.paidActive, false);
controller.dispose();
console.log('Paid restriction: controller, preflight, account access, recovery and Manual switch passed.');
