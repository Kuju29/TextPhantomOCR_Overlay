import assert from "node:assert/strict";

import { bindPopupEvents } from "../src/popup/controllers/popup-event-controller.js";
import { createAiProfileController } from "../src/popup/controllers/ai-profile-controller.js";
import { createLocalConnectionController } from "../src/popup/controllers/local-connection-controller.js";
import { normalizeUrl } from "../src/shared/url.js";
import { normalizeLocalAiAdapter } from "../src/shared/ai/providers/local-registry.js";
import {
  createAiProfiles,
  updateAiProfile,
} from "../src/shared/ai-profiles.js";

class FakeElement {
  constructor(value = "") {
    this.value = value;
    this.checked = false;
    this.disabled = false;
    this.textContent = "";
    this.style = {};
    this.options = [];
    this.listeners = new Map();
    this.classList = { toggle: () => false };
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute() {}
  focus() {}
  fire(type) { return this.listeners.get(type)?.({ target: this }); }
}

globalThis.chrome = {
  runtime: { getURL: (path) => path },
  storage: { onChanged: { addListener() {} } },
};
globalThis.window = { addEventListener() {}, close() {} };

const el = (value = "") => new FakeElement(value);
const els = {
  mode: el("lens_text"), sources: el("ai"), lang: el("th"),
  apiUrl: el("http://localhost:7860"), resetApi: el(),
  aiProvider: el("openrouter"), aiProviderWrap: el(),
  aiBaseUrl: el("https://openrouter.ai/api/v1"), aiEndpointWrap: el(),
  aiKey: el("fixture-key"), aiKeyWrap: el(),
  aiModel: el("deepseek/deepseek-v4-flash-0731"), aiModelWrap: el(),
  aiPrompt: el("saved prompt"), aiPromptWrap: el(), aiPromptReset: el(),
  aiLocalTest: el(), aiLocalStatus: el(), aiLocalAdapter: el(),
  aiLocalModelId: el(),
};
const state = {
  activeAiProvider: "openrouter", desiredAiModel: els.aiModel.value,
  desiredLang: "th", desiredSources: "ai", providerTransitionRevision: 0,
  aiMetaSeq: 0, localConnectSeq: 0, localConnectInFlight: null,
  healthSeq: 0, aiPromptByLang: {}, aiPromptDirtyByLang: {},
  modelDirty: false, pendingAiSave: false, pendingCredentialSave: false,
};
let storage = {
  aiProvider: "openrouter", aiBaseUrl: els.aiBaseUrl.value,
  aiModel: els.aiModel.value, aiKey: "fixture-key", aiCloudKey: "fixture-key",
};
const writes = [];
const setStorage = async (patch) => {
  writes.push(structuredClone(patch));
  Object.assign(storage, structuredClone(patch));
};
const getStorage = async (keys) => Object.fromEntries(
  keys.filter((key) => key in storage).map((key) => [key, structuredClone(storage[key])]),
);
let tick = 100;
const profileController = createAiProfileController({ els, state, setStorage, now: () => ++tick });
await profileController.initialize(storage);

// Upgrade regression: a pre-fix popup could persist a Cloud URL under the
// Ollama identity. Its canonical record wins over the freshly-prefilled field
// unless the profile boundary repairs the endpoint.
profileController.bindConnection({
  provider: "ollama",
  endpoint: "https://openrouter.ai/api/v1",
});
profileController.selectProvider("openrouter", "https://openrouter.ai/api/v1");

const setModelOptions = (models, { keepValue = "", selectFirst = false } = {}) => {
  const values = models.map(String);
  els.aiModel.value = values.includes(keepValue) ? keepValue : (selectFirst ? values[0] || "" : keepValue);
};
let discoverCalls = 0;
const localConnectionController = createLocalConnectionController({
  els, state, profile: profileController, persist: setStorage, getStorage,
  sendMessage: async (message) => {
    assert.equal(message.type, "TP_LOCAL_AI_DISCOVER");
    discoverCalls += 1;
    return {
      ok: true, models: ["qwen2.5:7b"], capability: {},
      selectedModelVerification: { model: "", status: "not_tested" },
    };
  },
  normalizeUrl, setModelOptions, setFieldMessage() {}, renderPrompt: async () => {},
  scheduleSave() {}, clearResolveTimer() {}, clearCapacity() {}, renderCapacity() {},
  persistCapacity: async () => {}, toggleUi() {},
});
localConnectionController.bind();

bindPopupEvents({
  els, state, profileController,
  profilePagehideFlush: { flush: async () => ({ ok: true }) },
  usageController: { select: async () => {}, reset: async () => {} },
  providerMetaController: { refresh() {}, schedule() {}, cancelSchedule() {} },
  localConnectionController,
  apiHealthController: { check() {}, markBrowserOffline() {} },
  applyPromptForLang: async () => {}, applyPromptHistoryResult: async () => {},
  refreshPromptHistoryButtons: async () => {}, resetPromptForLang() {},
  updateAiPromptWarning() {}, updateAiPromptModeHint() {}, updatePromptCount() {},
  fieldMessageType: () => "", setFieldMessage() {}, setEmojiStatus() {}, setModelOptions,
  toggleUi() {}, canUseAiUi: () => true, validateAiKey() {},
  ensureAiAvailableOrFallback: () => true, flushPromptForLang: async () => {},
  flushPendingAiEditsForSwitch: async () => ({ ok: true }), scheduleSaveApi() {},
  scheduleSaveAi() {}, selectedUsageTarget: () => ({}), renderLocalCapacityHint() {},
  persistSelectedLocalCapacityHint: async () => {}, clearLocalCapacitySnapshot() {},
  rateSettingsController: { renderHint() {} }, renderAiUsage() {}, refreshSeriesMemory() {},
  openAiUsageHistory() {}, closeAiUsageHistory() {}, isRemoteDefaultApiUrl: () => false,
  traceProviderTransition() {}, setProviderTransitionPending(value) { state.providerTransitionPending = value; },
});

// Reproduce the popup bug: the hidden Cloud endpoint survives into the named
// Local provider selection, then Connect rejects it before discovery.
els.aiProvider.value = "ollama";
await els.aiProvider.fire("change");
assert.equal(els.aiBaseUrl.value, "http://localhost:11434",
  "named Local selection must replace a stale Cloud endpoint with its preset");
assert.equal(storage.aiBaseUrl, "http://localhost:11434",
  "the same preset endpoint shown by the popup must be persisted canonically");

await els.aiLocalTest.fire("click");
assert.equal(discoverCalls, 1, "Connect must dispatch TP_LOCAL_AI_DISCOVER exactly once");
assert.equal(writes.some((patch) => patch.localAiAdapter?.baseUrl === "http://localhost:11434"), true);

// User-selected Local endpoints are not presets, but they are valid ownership
// boundaries and must survive a named-provider switch.
els.aiBaseUrl.value = "http://192.168.1.50:1234/v1";
els.aiProvider.value = "lmstudio";
await els.aiProvider.fire("change");
assert.equal(els.aiBaseUrl.value, "http://192.168.1.50:1234/v1");
assert.equal(storage.aiBaseUrl, "http://192.168.1.50:1234/v1");

els.aiBaseUrl.value = "http://localhost:9999/v1";
els.aiProvider.value = "localai";
await els.aiProvider.fire("change");
assert.equal(els.aiBaseUrl.value, "http://localhost:9999/v1");
assert.equal(storage.aiBaseUrl, "http://localhost:9999/v1");
assert.equal(discoverCalls, 1, "provider changes alone must not auto-discover Local AI");

// Reopening the popup must repair the same poisoned canonical active profile,
// not merely a live provider-change event.
let poisonedProfiles = createAiProfiles();
poisonedProfiles = updateAiProfile(poisonedProfiles, {
  provider: "ollama", endpoint: "https://openrouter.ai/api/v1", model: "qwen2.5:7b",
  defaults: {}, patch: {}, select: true, now: 1,
});
const reopenStorage = {
  aiProfileStorageVersion: 4,
  aiProfilesV1: poisonedProfiles,
  aiProfileCredentialsV1: {}, aiProfilePromptsV1: {},
  aiProvider: "ollama", aiBaseUrl: "https://openrouter.ai/api/v1", aiModel: "qwen2.5:7b",
};
const reopenWrites = [];
els.aiProvider.value = "ollama";
els.aiBaseUrl.value = "https://openrouter.ai/api/v1";
els.aiModel.value = "qwen2.5:7b";
const reopenedController = createAiProfileController({
  els, state,
  setStorage: async (patch) => {
    reopenWrites.push(structuredClone(patch));
    Object.assign(reopenStorage, structuredClone(patch));
  },
  now: () => ++tick,
});
const reopened = await reopenedController.initialize(reopenStorage);
assert.equal(reopened.endpoint, "http://localhost:11434");
assert.equal(els.aiBaseUrl.value, "http://localhost:11434");
assert.equal(reopenStorage.aiBaseUrl, "http://localhost:11434");
assert.equal(reopenWrites.length, 1, "the repaired canonical selection must be persisted once");

// A valid explicit private-LAN endpoint remains owned by the user.
const privateSelected = reopenedController.selectProvider(
  "jan", "http://192.168.1.77:11435/v1",
);
assert.equal(privateSelected.endpoint, "http://192.168.1.77:11435/v1");

// Protocol-less named Local input is rejected rather than guessed. Custom
// Local is not silently rewritten and fails the same strict adapter boundary.
assert.throws(
  () => reopenedController.selectProvider("lmstudio", "localhost:1234/v1"),
  /Invalid provider endpoint URL|Unsupported provider endpoint protocol/,
);
const customPublic = reopenedController.selectProvider(
  "customlocal", "https://public.example.com/v1",
);
assert.equal(customPublic.endpoint, "https://public.example.com/v1");
assert.throws(
  () => normalizeLocalAiAdapter({
    protocol: "openai", baseUrl: customPublic.endpoint,
  }, { provider: "customlocal" }),
  /baseUrl must use localhost or a private LAN address/,
);

console.log(JSON.stringify({
  test: "real popup Cloud URL -> named Local preset -> explicit Connect",
  endpoint: "http://localhost:11434", persistedEndpoint: "http://localhost:11434",
  discoverCalls, passed: true,
}));
