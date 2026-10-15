// 10488: AI think states in the extension. The shared fixture is also checked by
// scripts/test-thinking-states-10488.py against the API classification, so the
// two implementations must agree vector for vector.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'scripts/fixtures/thinking-states-10488.json'), 'utf8'));
const { THINKING_STATES, classifyThinkingState, thinkingControlOptions, sendsProviderDefault } =
  await import('../src/shared/thinking-state.js');
const { concreteReasoningPreferences, reasoningOptionsForCapability } = await import('../src/shared/reasoning-preference.js');
const { ollamaReasoningCapability } = await import('../src/shared/ai/providers/local-ollama.js');
const { createPopupUiController, thinkingRecordForSelection } = await import('../src/popup/controllers/popup-ui-controller.js');
const { renderThinkingControl, setThinkingPreference, THINKING_STATE_LABELS } =
  await import('../src/popup/controllers/reasoning-select.js');
const { createProviderMetaController } = await import('../src/popup/controllers/provider-meta-controller.js');
const { UI_TEXT } = await import('../src/shared/ui-text.js');

let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (value, message) => { assert.ok(value, message); checks++; };

// ------------------------------------------------------------ shared vectors
eq([...THINKING_STATES], FIXTURE.states, 'four states, same order as Python');
for (const vector of FIXTURE.vectors) {
  eq(classifyThinkingState(vector.record, { fresh: vector.fresh }), vector.state, `${vector.id}: state`);
  eq(thinkingControlOptions(vector.record), vector.options, `${vector.id}: options`);
  // The popup's selectable options are the classifier's options (plus Lowest).
  eq(concreteReasoningPreferences(vector.record), vector.options, `${vector.id}: popup options`);
  if (vector.state === 'controllable' && vector.fresh)
    eq(reasoningOptionsForCapability(vector.record).map(option => option.value),
      ['minimum', ...vector.options], `${vector.id}: Lowest + proven options`);
  eq(sendsProviderDefault(vector.state), ['none', 'default'].includes(vector.state), vector.id);
  if (vector.js_source?.kind === 'ollama_show')
    eq(classifyThinkingState(ollamaReasoningCapability(vector.js_source.show), { fresh: true }), vector.state,
      `${vector.id}: extension Ollama normalizer`);
}
eq(classifyThinkingState({ supported: true, control: 'levels', supported_efforts: ['low'] }), 'loading',
  'freshness defaults to false: never default without a record');

// ------------------------------------------------------------- popup control
for (const label of Object.values(THINKING_STATE_LABELS)) ok(UI_TEXT.has(label), `registered label: ${label}`);
const LEVELS = { supported: true, mandatory: false, control: 'levels', supported_efforts: ['none', 'low', 'high'] };
const select = () => ({ value: 'high', options: [], disabled: false, dataset: {} });
const harness = (overrides = {}) => {
  const els = {
    aiProvider: { value: 'openrouter' }, aiBaseUrl: { value: 'https://openrouter.ai/api/v1' },
    aiModel: { value: 'vendor/a' }, aiKey: { value: 'key-1' }, mode: { value: 'lens_text' },
    sources: { value: 'ai' }, aiThinking: select(), aiThinkingHint: { textContent: '' },
    aiThinkingWrap: { style: {} }, ...overrides.els,
  };
  const state = { lastAiResolve: null, lastResolvedKey: 'key-1', ...overrides.state };
  const ui = createPopupUiController({ els, state, isLocalProvider: p => ['ollama', 'lmstudio', 'jan'].includes(p),
    toggleDom: () => {}, updatePromptWarning: () => {}, validateAiKey: () => {}, validateLangSource: () => {} });
  return { els, state, ui };
};
const resolved = (model, reasoning, extra = {}) => ({ provider: 'openrouter', model, models: [model],
  models_verified: true, model_status: 'available', backend_supported: true,
  model_capabilities: reasoning === undefined ? {} : { reasoning }, ...extra });
const view = els => ({ state: els.aiThinking.dataset.thinkingState, disabled: els.aiThinking.disabled,
  value: els.aiThinking.value, labels: els.aiThinking.options.map(option => option.textContent),
  values: els.aiThinking.options.map(option => option.value), hint: els.aiThinkingHint.textContent });

{
  const { els, state, ui } = harness();
  ui.toggle();
  let v = view(els);
  eq([v.state, v.disabled, v.value, v.labels], ['loading', true, 'high', ['Checking model…']],
    'Manual: no record yet → disabled "Checking model…", saved value kept');
  ok(UI_TEXT.has(v.hint), 'loading hint registered');
  state.lastAiResolve = resolved('vendor/a', undefined);
  ui.toggle();
  v = view(els);
  eq([v.state, v.disabled, v.value, v.labels], ['default', true, 'high', [THINKING_STATE_LABELS.default]],
    'Manual: silent catalogue → disabled provider default; saved High kept');
  ok(UI_TEXT.has(v.hint) && /provider default/i.test(v.hint), 'default hint');
  state.lastAiResolve = resolved('vendor/a', { supported: false });
  ui.toggle();
  v = view(els);
  eq([v.state, v.disabled, v.value, v.labels], ['none', true, 'high', [THINKING_STATE_LABELS.none]],
    'Manual: no-reasoning model → disabled "Provider default (this model has no AI think)"');
  ok(UI_TEXT.has(v.hint) && /no AI think/i.test(v.hint), 'none hint');
  state.lastAiResolve = resolved('vendor/a', { supported: true, control: 'provider' });
  ui.toggle();
  eq(view(els).state, 'default', 'reasoning present but control "provider" → default');
  state.lastAiResolve = resolved('vendor/a', LEVELS);
  ui.toggle();
  v = view(els);
  eq([v.state, v.disabled, v.value, v.values], ['controllable', false, 'high', ['minimum', 'off', 'low', 'high']],
    'switching back to a controllable model restores the saved High');
  eq(v.hint, '', 'an executable saved choice needs no hint');
  // A different selected model: the A record never applies to B.
  els.aiModel.value = 'vendor/b';
  ui.toggle();
  eq(view(els).state, 'loading', 'model change → loading until B is checked');
  eq(els.aiThinking.value, 'high', 'saved value survives the loading state');
  // Unverified/failed catalogue is loading, not default.
  state.lastAiResolve = resolved('vendor/b', undefined, { models_verified: false, models: [] });
  ui.toggle();
  eq(view(els).state, 'loading', 'unverified live list (fetch failed) → loading, never provider default');
  state.lastAiResolve = resolved('vendor/b', LEVELS, { model_status: 'unavailable' });
  ui.toggle();
  eq(view(els).state, 'loading', 'unavailable model → no record');
  // Another credential's resolve cannot describe this one.
  state.lastAiResolve = resolved('vendor/b', LEVELS);
  state.lastResolvedKey = 'key-2';
  ui.toggle();
  eq(view(els).state, 'loading', 'record for another credential → loading');
  state.lastResolvedKey = 'key-1';
  ui.toggle();
  eq(view(els).state, 'controllable', 'record arrives → re-render with the model options');
  // A profile render only supplies the value; it keeps the current state.
  setThinkingPreference(els.aiThinking, 'low');
  eq([view(els).state, view(els).value, view(els).disabled], ['controllable', 'low', false], 'profile value, same state');
  state.lastAiResolve = resolved('vendor/b', { supported: false });
  ui.toggle();
  setThinkingPreference(els.aiThinking, 'on');
  eq([view(els).state, view(els).value, view(els).disabled, view(els).labels],
    ['none', 'on', true, [THINKING_STATE_LABELS.none]],
    'a later profile render cannot bring back older selectable options');
}

{
  // Mandatory reasoning: Off is not offered; saved Off is visible as (saved).
  const { els, state, ui } = harness();
  els.aiThinking.value = 'off';
  state.lastAiResolve = resolved('vendor/a', { supported: true, mandatory: true, control: 'levels', supported_efforts: ['low', 'high'] });
  ui.toggle();
  const v = view(els);
  eq(v.values, ['minimum', 'low', 'high', 'off'], 'mandatory: no executable Off, saved Off kept as (saved)');
  ok(/cannot verify that exact mode/.test(v.hint), 'mandatory saved Off keeps the configuration hint');
}

{
  // Local: a saved snapshot is stale until live metadata arrives.
  const capability = (reasoning, extra = {}) => ({ provider: 'ollama', baseUrl: 'http://localhost:11434',
    models: { qwen3: reasoning === undefined ? {} : { reasoning } }, ...extra });
  const { els, state, ui } = harness({ els: { aiProvider: { value: 'ollama' }, aiBaseUrl: { value: 'http://localhost:11434' },
    aiModel: { value: 'qwen3' }, aiKey: { value: '' } } });
  state.localAiCapability = capability(LEVELS, { snapshotSource: 'saved' });
  ui.toggle();
  eq(view(els).state, 'loading', 'Local saved snapshot → loading');
  state.localAiCapability = capability(ollamaReasoningCapability({ capabilities: ['completion'] }));
  ui.toggle();
  eq([view(els).state, view(els).disabled], ['default', true], 'Ollama without thinking.values → provider default');
  state.localAiCapability = capability(ollamaReasoningCapability({ thinking: { values: [false] } }));
  ui.toggle();
  eq(view(els).state, 'none', 'Ollama [false] → none');
  state.localAiCapability = capability(ollamaReasoningCapability({ thinking: { values: [false, true] } }));
  ui.toggle();
  eq([view(els).state, view(els).disabled], ['controllable', false], 'Ollama boolean → controllable');
  state.localAiCapability = { ...capability(LEVELS), baseUrl: 'http://other:11434' };
  ui.toggle();
  eq(view(els).state, 'loading', 'another endpoint record → loading');
  const jan = harness({ els: { aiProvider: { value: 'jan' }, aiBaseUrl: { value: 'http://localhost:1337/v1' },
    aiModel: { value: 'm' }, aiKey: { value: '' } } });
  jan.state.localAiCapability = { provider: 'jan', baseUrl: 'http://localhost:1337/v1', models: { m: {} } };
  jan.ui.toggle();
  eq([view(jan.els).state, view(jan.els).disabled], ['default', true], 'OpenAI-compatible runtime → provider default');
}

{
  // Paid and Login pickers.
  const paid = harness({ state: { paidActive: true, paidTranslationSource: 'tp' } });
  paid.state.paidModelCapabilities = {};
  paid.state.paidModelCapabilitiesFresh = false;
  paid.ui.toggle();
  eq(view(paid.els).state, 'loading', 'Paid catalogue not ready → loading');
  paid.state.paidModelCapabilitiesFresh = true;
  paid.ui.toggle();
  eq(view(paid.els).state, 'default', 'Paid row without reasoning → provider default');
  paid.state.paidModelCapabilities = { reasoning: { supported: false } };
  paid.ui.toggle();
  eq(view(paid.els).state, 'none', 'Paid no-reasoning row → none');
  paid.state.paidModelCapabilities = { reasoning: LEVELS };
  paid.ui.toggle();
  eq([view(paid.els).state, view(paid.els).value], ['controllable', 'high'], 'Paid levels → controllable');
  const login = harness({ state: { paidActive: true, paidTranslationSource: 'login' } });
  login.state.loginModelCapabilities = { reasoning: { supported: true, control: 'provider', app_controlled: false } };
  login.state.loginModelCapabilitiesFresh = true;
  login.ui.toggle();
  eq([view(login.els).disabled, login.els.aiThinkingHint.textContent],
    [true, 'This website chooses its own thinking for this model. TextPhantom cannot change it.'],
    'Login website-controlled thinking stays disabled with its own hint');
  login.state.loginModelCapabilities = { reasoning: LEVELS };
  login.state.loginModelCapabilitiesFresh = false;
  login.ui.toggle();
  eq(view(login.els).state, 'loading', 'Login session models not loaded → loading');
  login.state.loginModelCapabilitiesFresh = true;
  login.ui.toggle();
  eq(view(login.els).state, 'controllable', 'Login native levels → controllable');
}

eq(thinkingRecordForSelection({ local: false, provider: 'openrouter', model: 'a', credential: 'k',
  resolved: resolved('b', LEVELS), resolvedCredential: 'k' }), { fresh: false, reasoning: null },
  'a record for another model is not this selection\'s record');

// renderThinkingControl falls back to loading for an unknown state.
{
  const s = select();
  renderThinkingControl(s, { state: 'bogus' });
  eq([s.dataset.thinkingState, s.disabled, s.value], ['loading', true, 'high'], 'unknown state → loading');
}

// ------------------------------- Manual model picker race (older response late)
{
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const pending = new Map();
  const els = { mode: { value: 'lens_text' }, sources: { value: 'ai' }, lang: { value: 'th' },
    apiUrl: { value: 'http://localhost:7860' }, aiProvider: { value: 'openrouter' },
    aiBaseUrl: { value: 'https://openrouter.ai/api/v1' }, aiKey: { value: 'key-1' }, aiModel: { value: 'vendor/a', options: [] },
    aiThinking: select(), aiThinkingHint: { textContent: '' }, aiThinkingWrap: { style: {} },
    aiModelWrap: {}, aiProviderWrap: {} };
  const state = { aiMetaSeq: 0, aiProbeSeq: 0, lastAiResolve: null, lastAiProbe: null, desiredAiModel: 'vendor/a' };
  const ui = createPopupUiController({ els, state, isLocalProvider: () => false, toggleDom: () => {},
    updatePromptWarning: () => {}, validateAiKey: () => {}, validateLangSource: () => {} });
  const meta = createProviderMetaController({ els, state,
    api: { fetchJson: (url, body) => {
      if (url.endsWith('/probe')) return Promise.resolve({ status: 'passed', model_capabilities: {} });
      const d = deferred(); pending.set(body.model, d); return d.promise;
    } },
    constants: { paths: { AI_RESOLVE: '/resolve', AI_PROBE: '/probe' }, metaTimeout: 1000, probeTimeout: 1000 },
    provider: { isLocal: () => false, label: x => x, protocolLabel: () => '' },
    profile: { saveModelCapabilities: async () => {}, activateResolvedModel: async () => {} },
    normalizeUrl: x => x,
    setModelOptions: (models, { keepValue = '' } = {}) => {
      const ids = models.map(row => String(row?.id ?? row));
      els.aiModel.options = ids;
      if (ids.includes(keepValue)) els.aiModel.value = keepValue;
    },
    setFieldMessage: () => {}, setStatus: () => {}, toggleUi: () => ui.toggle(),
    viewCache: { restore: async () => null, clear: async () => {}, remember: async () => {} } });
  const answer = (model, reasoning) => ({ provider: 'openrouter', model, requested_model: model, models: ['vendor/a', 'vendor/b'],
    models_verified: true, models_source: 'live', model_status: 'available', backend_supported: true, key_status: 'valid',
    model_capabilities: { reasoning },
    model_candidates: [{ id: 'vendor/a', eligibility: 'usable' }, { id: 'vendor/b', eligibility: 'usable' }] });
  const first = meta.refresh();
  while (!pending.has('vendor/a')) await new Promise(r => setImmediate(r));
  // The user picks B while A's catalogue is still loading.
  els.aiModel.value = 'vendor/b';
  state.desiredAiModel = 'vendor/b';
  state.modelDirty = true;
  const second = meta.refresh();
  while (!pending.has('vendor/b')) await new Promise(r => setImmediate(r));
  ui.toggle();
  eq(view(els).state, 'loading', 'B is loading while both catalogue responses are pending');
  pending.get('vendor/b').resolve(answer('vendor/b', { supported: false }));
  await second;
  eq([els.aiModel.value, view(els).state], ['vendor/b', 'none'], 'B record arrives → none');
  pending.get('vendor/a').resolve(answer('vendor/a', LEVELS));
  await first;
  ui.toggle();
  eq([els.aiModel.value, view(els).state, view(els).value], ['vendor/b', 'none', 'high'],
    'the older A response cannot overwrite the newer B selection or its state');
}

console.log(`PASS 10488 thinking states (extension): ${FIXTURE.vectors.length} shared vectors, ${checks} checks`);
