import assert from "node:assert/strict";

import { createApiHealthController } from "../src/popup/controllers/api-health-controller.js";
import { createProviderMetaController } from "../src/popup/controllers/provider-meta-controller.js";
import { createSettingsPersistenceController } from "../src/popup/controllers/settings-persistence-controller.js";

const option = (value) => ({ value });
const makeEls = (provider = "openrouter", model = "saved-model") => ({
  mode: option("lens_text"), sources: option("ai"), lang: option("th"),
  apiUrl: option("https://api.example"), aiProvider: option(provider),
  aiBaseUrl: option(provider === "ollama" ? "http://127.0.0.1:11434" : ""),
  aiKey: option("key"), aiModel: option(model), aiModelWrap: {},
  aiProviderWrap: {}, aiKeyWrap: { style: { display: "" } },
});

function metaController({ provider = "openrouter", model = "saved-model", fetch }) {
  const els = makeEls(provider, model);
  const state = {
    aiMetaSeq: 0, aiProbeSeq: 0, localConnectSeq: 0, localConnectInFlight: null,
    desiredAiModel: model, lastAiResolve: null, lastAiProbe: null,
  };
  let profileWrites = 0;
  let storageWrites = 0;
  let fallbackCalls = 0;
  const controller = createProviderMetaController({
    els, state,
    api: {
      fetchJson: fetch,
      getStorage: async () => ({}),
      sendMessage: async () => { throw new Error("unexpected local discovery"); },
      localPreset: () => ({}), normalizeLocalAdapter: (x) => x,
    },
    constants: { paths: { AI_RESOLVE: "/resolve", AI_PROBE: "/probe" }, metaTimeout: 100, probeTimeout: 100 },
    provider: { isLocal: (id) => id === "ollama", label: (id) => id, protocolLabel: () => "test" },
    profile: { selectModel: () => profileWrites++, persist: async () => profileWrites++, saveCredential: async () => profileWrites++ },
    prompt: { render: async () => {}, scheduleSave: () => {} },
    local: { savedModel: () => model, showFallback: () => fallbackCalls++, renderCapacity: () => {}, persistCapacity: async () => {} },
    usage: {}, persist: async () => storageWrites++, normalizeUrl: (x) => x,
    setModelOptions: (models, { keepValue } = {}) => {
      const values = models.map(String);
      els.aiModel.value = values.includes(keepValue) ? keepValue : (values[0] || "");
    },
    setFieldMessage: () => {}, setStatus: () => {}, toggleUi: () => {},
  });
  return { controller, els, state, writes: () => ({ profileWrites, storageWrites, fallbackCalls }) };
}

// Local startup refresh is display-only and must never contact the runtime.
{
  let calls = 0;
  const t = metaController({ provider: "ollama", model: "qwen", fetch: async () => { calls++; } });
  await t.controller.refresh();
  assert.equal(calls, 0);
  assert.equal(t.els.aiModel.value, "qwen");
  t.state.lastAiResolve = { provider: "ollama", models_verified: true, models: ["qwen", "llama"] };
  await t.controller.refresh();
  assert.equal(t.writes().fallbackCalls, 1,
    "model-only refresh erased a successful Local Connect snapshot");
}

// Concurrent/repeated Cloud refreshes share one live catalogue request and
// one selected-model probe. Both results are TTL-cached for an unchanged
// provider/account/model; metadata refresh must not write profile/storage.
{
  let resolveCalls = 0;
  let probeCalls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const t = metaController({ fetch: async (url) => {
    if (String(url).endsWith("/probe")) {
      probeCalls++;
      return { provider: "openrouter", model: "saved-model", status: "passed" };
    }
    resolveCalls++;
    await pending;
    return {
      provider: "openrouter", backend_supported: true, key_status: "valid",
      models_verified: true, models_source: "live", models: ["saved-model", "other-model"],
    };
  } });
  const first = t.controller.refresh();
  const second = t.controller.refresh();
  release();
  await Promise.all([first, second]);
  assert.equal(resolveCalls, 1);
  assert.equal(probeCalls, 1);
  assert.equal(t.els.aiModel.value, "saved-model");
  assert.equal(t.state.lastAiProbe?.status, "passed");
  assert.deepEqual(t.writes(), { profileWrites: 0, storageWrites: 0, fallbackCalls: 0 });
  await t.controller.refresh();
  assert.equal(resolveCalls, 1, "TTL cache did not suppress an unchanged resolve");
  assert.equal(probeCalls, 1, "TTL cache did not suppress an unchanged selected-model probe");
  assert.equal(t.state.lastAiProbe?.cached, true);
}

// Debounced AI saving is strictly dirty-only. Scheduling with unchanged UI
// state performs no canonical write; one prompt edit produces one merged write.
{
  let writes = 0;
  const state = {
    pendingAiSave: false, pendingCredentialSave: false, modelDirty: false,
    desiredAiModel: "saved-model", desiredLang: "th",
    aiPromptByLang: { key: { text: "saved", mode: "append" } },
    aiPromptDirtyByLang: {},
  };
  const els = {
    aiPrompt: option("saved"), aiPromptMode: option("append"), aiKey: option("key"),
    aiModel: option("saved-model"), mode: option("lens_text"), lang: option("th"),
  };
  const controller = createSettingsPersistenceController({
    els, state,
    profileController: {
      promptKey: () => "key",
      buildClosePatch: () => ({ canonical: true }),
    },
    providerMetaController: { renderStatus: () => {}, refresh: () => {} },
    apiHealthController: { check: () => {} }, persist: async () => { writes++; },
    setStatus: () => {}, setFieldMessage: () => {}, toggleUi: () => {},
    canUseAiUi: () => true, isRemoteDefaultApiUrl: () => false,
    refreshPromptHistoryButtons: () => {},
  });
  controller.scheduleSaveAi();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(writes, 0);
  els.aiPrompt.value = "edited";
  state.aiPromptDirtyByLang.key = true;
  controller.scheduleSaveAi();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(writes, 1);
}

// A fresh status stays visible and duplicate health checks share one request.
{
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const statuses = [];
  const state = { lastApiOk: false, healthSeq: 0, retryTimer: null, userInteractedApi: false };
  const controller = createApiHealthController({
    els: { apiUrl: option("https://api.example"), lang: option("th"), sources: option("ai") },
    state, normalizeUrl: (x) => x, checkHealthOnce: async () => { calls++; await pending; return true; },
    fetchJson: async () => ({ ok: false }), paths: { META: "/meta" }, timeout: 100,
    retryDelays: [], setStatus: (...args) => statuses.push(args), setSelectOptions: () => {},
    orderLanguages: (x) => x, languages: [], sources: [], pinnedLanguages: [],
    persist: async () => {}, toggleUi: () => {},
  });
  assert.equal(controller.acceptSnapshot({ ok: true, fresh: true, base: "https://api.example" }, "https://api.example"), true);
  const a = controller.check("https://api.example");
  const b = controller.check("https://api.example");
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(statuses.some(([, text]) => /Checking|Waiting/.test(text)), false);
}

// Strict canonical failure is contained at the AI boundary: no rejection,
// compatibility write, or provider dispatch; callers receive a stable message.
globalThis.document ??= { getElementById: () => null };
const { activateAiProfileSafely } = await import(
  "../src/popup/controllers/settings-hydration-controller.js"
);
{
  let writes = 0;
  let dispatches = 0;
  let message = "";
  const state = { lastAiResolve: { stale: true }, lastAiProbe: { stale: true } };
  const result = await activateAiProfileSafely({
    profileController: {
      initialize: async () => {
        const error = new TypeError("corrupt canonical");
        error.code = "AI_PROFILE_INVALID";
        throw error;
      },
      credentialForCurrent: () => "",
    },
    stored: { aiProfilesV1: { corrupt: true } },
    els: { aiBaseUrl: option(""), aiKey: option("") }, state,
    writeCompatibility: async () => { writes++; },
    showError: (_code, value) => { message = value; },
  });
  if (result.ready) dispatches++;
  assert.equal(result.ready, false);
  assert.equal(state.aiProfileBlocked, true);
  assert.equal(writes, 0);
  assert.equal(dispatches, 0);
  assert.match(message, /AI_PROFILE_INVALID/);
  assert.match(message, /Reset or reconfigure/);
}

// Fail-closed UI disables AI dispatch while keeping every recovery control
// available; another source can still use the ordinary translation controls.
{
  const { createPopupUiController } = await import(
    "../src/popup/controllers/popup-ui-controller.js"
  );
  const control = () => ({ disabled: false });
  const els = {
    mode: option("lens_text"), sources: option("ai"), aiProvider: { ...option("openrouter"), disabled: false },
    aiKey: { ...option("key"), disabled: false }, aiModel: control(), aiBaseUrl: control(),
    aiLocalTest: control(), aiLocalModelId: control(), aiThinking: { ...control(), value: "off", options: [] },
    aiPrompt: control(), aiPromptMode: control(), aiPromptReset: control(),
    aiPromptStudio: control(), translatePageBtn: control(),
  };
  const state = { aiProfileBlocked: true, providerTransitionPending: false, metaCache: null, lastAiResolve: null };
  const ui = createPopupUiController({
    els, state, isLocalProvider: () => false, toggleDom: () => {},
    updatePromptWarning: () => {}, validateAiKey: () => {}, validateLangSource: () => {},
  });
  ui.toggle();
  for (const control of [els.aiProvider, els.aiKey, els.aiModel, els.aiBaseUrl,
    els.aiLocalTest, els.aiLocalModelId, els.aiThinking, els.aiPrompt,
    els.aiPromptMode, els.aiPromptReset, els.aiPromptStudio])
    assert.equal(control.disabled, false, "profile recovery control must remain enabled");
  assert.equal(els.translatePageBtn.disabled, true);
  els.sources.value = "translated";
  ui.toggle();
  assert.equal(els.translatePageBtn.disabled, false,
    "corrupt AI profile disabled non-AI translation");
}

console.log("Popup lifecycle passed: cache-first rendering, strict fail-closed AI, deduped health, explicit Local discovery.");
