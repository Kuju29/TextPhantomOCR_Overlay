// .91 owner question: Login Gemini (gemini.google.com web endpoint) has no
// evidenced thinking control, so the popup shows the disabled provider-default
// state, never a saved "Thinking on". DeepSeek's verified web switch stays
// selectable. A stale Login catalogue stays "loading", never "default".
// Python counterpart: scripts/test-login-gemini-thinking-10491.py.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { createPopupUiController } = await import('../src/popup/controllers/popup-ui-controller.js');
const { THINKING_STATE_LABELS } = await import('../src/popup/controllers/reasoning-select.js');
const { UI_TEXT } = await import('../src/shared/ui-text.js');

let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (value, message) => { assert.ok(value, message); checks++; };

// Rows exactly as the API publishes them (login_endpoint_http.model and
// login_provider_deepseek.deepseek_model).
const GEMINI_WEB = { reasoning: { supported: null, control: 'provider', app_controlled: false } };
const DEEPSEEK_WEB = { reasoning: { supported: true, control: 'toggle', mandatory: false, can_disable: true,
  supported_efforts: ['none', 'on'], app_controlled: true } };

const harness = (capabilities, fresh, saved = 'on') => {
  const els = {
    aiProvider: { value: 'openrouter' }, aiBaseUrl: { value: '' }, aiModel: { value: 'web-default' },
    aiKey: { value: '' }, mode: { value: 'lens_text' }, sources: { value: 'ai' },
    aiThinking: { value: saved, options: [], disabled: false, dataset: {} },
    aiThinkingHint: { textContent: '' }, aiThinkingTip: { textContent: '' }, aiThinkingWrap: { style: {} },
  };
  const state = { paidActive: true, paidTranslationSource: 'login', paidAccountOpen: false,
    loginModelCapabilities: capabilities, loginModelCapabilitiesFresh: fresh };
  const ui = createPopupUiController({ els, state, isLocalProvider: () => false, toggleDom: () => {},
    updatePromptWarning: () => {}, validateAiKey: () => {}, validateLangSource: () => {} });
  ui.toggle();
  const s = els.aiThinking;
  return { state: s.dataset.thinkingState, disabled: s.disabled, value: s.value,
    labels: s.options.map(o => o.textContent), values: s.options.map(o => o.value), hint: els.aiThinkingHint.textContent,
    // 10496: the website reason is the highlighted line of the "AI thinking" explanation.
    reason: els.aiThinkingTip.tipReason || '' };
};

for (const saved of ['on', 'high', 'off', 'minimum']) {
  const v = harness(GEMINI_WEB, true, saved);
  eq([v.state, v.disabled, v.labels], ['default', true, [THINKING_STATE_LABELS.default]],
    `Gemini web, saved ${saved}: disabled provider default, no "Thinking ${saved}" option`);
  eq(v.value, saved, 'saved preference is kept, not rewritten');
  ok(/website chooses its own thinking/i.test(v.reason) && UI_TEXT.has(v.reason) && v.hint === '', 'website reason in the explanation, translated');
}

{
  const v = harness(GEMINI_WEB, false);
  eq([v.state, v.disabled, v.labels], ['loading', true, ['Checking model…']],
    'stale Login catalogue → loading, never default');
}

{
  const v = harness(DEEPSEEK_WEB, true);
  eq([v.state, v.disabled], ['controllable', false], 'DeepSeek web switch stays selectable');
  ok(v.values.includes('off') && v.values.includes('on'), 'DeepSeek offers Off and On');
}

console.log(`PASS ${checks} Login Gemini thinking popup checks`);
