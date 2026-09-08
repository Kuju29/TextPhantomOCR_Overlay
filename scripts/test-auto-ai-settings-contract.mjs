import assert from "node:assert/strict";

const storage = Object.create(null);
globalThis.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const out = {};
        for (const key of keys || []) out[key] = storage[key];
        cb(out);
      },
      set(patch, cb) { Object.assign(storage, patch); cb?.(); },
    },
  },
  runtime: { lastError: null },
  contextMenus: { removeAll() {}, create() {} },
  tabs: {
    sendMessage(_tabId, message, _options, callback) {
      // The readiness ping succeeds. A configuration failure must occur before
      // the production handler asks the tab for an image payload.
      callback?.(message?.type === "TP_PING" ? { ok: true } : null);
    },
  },
  extension: { isAllowedFileSchemeAccess(callback) { callback(true); } },
};

const { readFullSettings } = await import("../src/shared/settings.js");
const { readCoreSettings } = await import("../src/shared/settings.js");
const { getStorage, setStorage } = await import("../src/shared/storage.js");
const { autoAiSettingsIssue, classifyAiRuntime } = await import("../src/shared/ai-settings-contract.js");
const contextMenuSource = await (await import("node:fs/promises")).readFile(
  new URL("../src/background/context-menu.js", import.meta.url), "utf8",
);

storage.lang = "en";
storage.aiModel = "gemini-test";
storage.aiPromptByLang = { en: "English style", th: "Thai style" };
let settings = await readFullSettings({ lang: "th" });
assert.equal(settings.lang, "th");
assert.equal(settings.aiPrompt, "Thai style", "Auto override language must select its own prompt");

storage.aiProvider = "ollama";
storage.aiBaseUrl = "http://192.168.1.22:11434/v1";
storage.localAiAdapter = {
  version: 1, protocol: "openai", baseUrl: "http://192.168.1.11:11434/v1",
  modelsPath: "/models", chatPath: "/chat/completions",
  modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content",
};
settings = await readFullSettings({ lang: "th" });
assert.equal(settings.localAiAdapter.baseUrl, "http://192.168.1.22:11434",
  "native Ollama must use the newly visible endpoint root, never a stale stored /v1 adapter");
assert.equal(settings.localAiAdapter.protocol, "ollama",
  "legacy Ollama OpenAI-compatible settings must migrate to the native protocol");
storage.aiProvider = "";
storage.aiBaseUrl = "";
delete storage.localAiAdapter;

// Baseline round-trip for the current flat settings contract. These assertions
// intentionally describe today's behaviour before aiProfilesV1 is introduced.
Object.assign(storage, {
  mode: "lens_text",
  lang: "ja",
  sources: "ai",
  aiProvider: "openrouter",
  aiModel: "deepseek/test",
  aiCloudKey: "roundtrip-secret",
  aiBaseUrl: "https://openrouter.ai/api/v1",
  aiThinking: "off",
  aiLocalThinking: "on",
  aiMemoryMode: "terms",
  aiPageImage: "always",
  rateLimitEnabled: true,
  rateRpm: 42,
  rateBurst: 3,
  engineMode: "api",
});
settings = await readFullSettings();
assert.deepEqual(
  {
    mode: settings.mode, lang: settings.lang, sources: settings.sources,
    provider: settings.aiProvider, model: settings.aiModel, key: settings.aiKey,
    baseUrl: settings.aiBaseUrl, thinking: settings.aiThinking,
    memory: settings.aiMemoryMode, image: settings.aiPageImage,
    rate: [settings.rateLimitEnabled, settings.rateRpm, settings.rateBurst],
    engine: settings.engineMode,
  },
  {
    mode: "lens_text", lang: "ja", sources: "ai",
    provider: "openrouter", model: "deepseek/test", key: "roundtrip-secret",
    baseUrl: "https://openrouter.ai/api/v1", thinking: "off",
    memory: "terms", image: "always", rate: [true, 42, 3], engine: "api",
  },
  "flat settings must round-trip unchanged before profile migration",
);

// Corrupt values normalize instead of escaping into provider payloads.
Object.assign(storage, {
  mode: { bad: true }, aiModel: "", aiProvider: 17,
  aiMemoryMode: "corrupt", aiPageImage: "corrupt",
  rateLimitEnabled: "yes", rateRpm: "NaN", rateBurst: -9,
  engineMode: "corrupt", localAiAdapter: "not-an-adapter",
});
settings = await readFullSettings();
assert.equal(settings.mode, "lens_text");
assert.equal(settings.aiModel, "auto");
assert.equal(settings.aiProvider, "");
assert.equal(settings.aiMemoryMode, "off");
assert.equal(settings.aiPageImage, "off");
assert.equal(settings.rateLimitEnabled, false);
assert.equal(settings.engineMode, "extension");

// Storage failures are observable: UI transactions can preserve dirty state
// or roll back instead of claiming a write succeeded.
const savedSet = chrome.storage.local.set;
chrome.storage.local.set = (_patch, callback) => {
  chrome.runtime.lastError = { message: "QUOTA_BYTES exceeded" };
  callback();
  chrome.runtime.lastError = null;
};
await assert.rejects(
  setStorage({ oversizedProfile: "x".repeat(1000) }),
  /QUOTA_BYTES exceeded/,
  "callback runtime.lastError must reject so UI rollback remains reachable",
);
chrome.storage.local.set = () => Promise.reject(new Error("Promise storage denied"));
await assert.rejects(
  setStorage({ rejectedProfile: true }),
  /Promise storage denied/,
  "Promise-based browser storage rejection must reach the UI transaction",
);
chrome.storage.local.set = () => { throw new Error("Synchronous storage failure"); };
await assert.rejects(setStorage({ syncFailure: true }), /Synchronous storage failure/);
chrome.storage.local.set = savedSet;
assert.equal(storage.oversizedProfile, undefined,
  "a rejected write must not mutate the persisted fixture");
assert.equal(storage.rejectedProfile, undefined,
  "a rejected Promise write must not mutate the persisted fixture");
assert.deepEqual(await getStorage(["missing"]), { missing: undefined });

// Security inventory: the full reader correctly selects the cloud-only key,
// but the current content-side reader still exposes legacy aiKey. Keep this
// explicit so the profile/security refactor cannot accidentally broaden it.
storage.aiKey = "legacy-content-secret";
storage.aiCloudKey = "service-worker-secret";
storage.aiProvider = "openrouter";
const coreSettings = await readCoreSettings();
settings = await readFullSettings();
assert.equal(coreSettings.aiKey, "legacy-content-secret",
  "known baseline: content settings currently include legacy aiKey");
assert.equal(settings.aiKey, "service-worker-secret",
  "service-worker settings prefer aiCloudKey for cloud providers");
assert.ok(!JSON.stringify({ ...settings, aiKey: "[redacted]" }).includes("service-worker-secret"),
  "a redacted settings snapshot must not contain the credential");

assert.equal(autoAiSettingsIssue({ aiProvider: "gemini", aiKey: "" }, { hasServerKey: true }), null,
  "a server-owned cloud key must remain valid");
assert.equal(autoAiSettingsIssue({ aiProvider: "auto", aiModel: "auto", aiKey: "" }, { hasServerKey: null }), null,
  "unknown server key state and auto resolution must not be falsely blocked");
assert.equal(autoAiSettingsIssue(
  { aiOnDevice: true, aiProvider: "auto", aiModel: "auto", aiKey: "", aiBaseUrl: "" },
  { hasServerKey: false },
 )?.code, "missing_api_key",
  "the current server-owned text.ai path must not pretend on-device is a keyless route");
assert.equal(autoAiSettingsIssue(
  { aiOnDevice: true, aiProvider: "ollama", aiModel: "auto", aiKey: "", aiBaseUrl: "" },
  { hasServerKey: false },
 )?.code, "ai_endpoint_missing",
  "an explicit local provider still requires its HTTP endpoint");
assert.equal(autoAiSettingsIssue({ aiProvider: "gemini", aiKey: "" }, { hasServerKey: false })?.code,
  "missing_api_key");
assert.equal(autoAiSettingsIssue({ aiProvider: "ollama", aiBaseUrl: "", aiKey: "" })?.code,
  "ai_endpoint_missing");
assert.equal(autoAiSettingsIssue({ aiProvider: "auto", aiBaseUrl: "http://127.0.0.1:11434", aiKey: "" }), null,
  "a keyless local URL with auto provider is supported");
assert.deepEqual(
  classifyAiRuntime({ aiProvider: "openrouter", aiBaseUrl: "http://localhost:11434" }),
  { runtime: "cloud", local: false, conflict: true, reason: "cloud_provider_local_endpoint_conflict" },
  "an explicit Cloud provider must never be reclassified as Local by a stale localhost endpoint",
);
assert.equal(autoAiSettingsIssue({
  aiProvider: "openrouter", aiBaseUrl: "http://localhost:11434", aiKey: "cloud-key",
})?.code, "ai_provider_endpoint_conflict",
"a contradictory Cloud provider/Local endpoint must fail before dispatch even when a key exists");
assert.deepEqual(
  classifyAiRuntime({ aiProvider: "auto", aiBaseUrl: "http://127.0.0.1:11434" }),
  { runtime: "local", local: true, conflict: false, reason: "local_by_auto_endpoint" },
  "legacy Auto plus loopback endpoint remains an explicit compatibility path",
);
assert.equal(classifyAiRuntime({
  aiProvider: "ollama", aiBaseUrl: "http://localhost:11434",
}).reason, "local_by_provider", "an explicit Local provider remains Local");

storage.aiProvider = "openrouter";
storage.aiBaseUrl = "http://localhost:11434";
storage.aiCloudKey = "cloud-key";
settings = await readFullSettings();
assert.equal(settings.aiKey, "cloud-key",
  "a stale localhost endpoint must not strip the selected Cloud provider credential");
assert.equal(settings.localAiAdapter, null,
  "a stale localhost endpoint must not construct a Local adapter for a selected Cloud provider");
const { resolveJobAiProfile } = await import("../src/background/ai-profile-resolver.js");
const cloudConflictSnapshot = await resolveJobAiProfile(
  { ...settings, lang: "th", aiPrompt: "full style" }, { language: "th" },
);
assert.equal(cloudConflictSnapshot.audit.runtime, "cloud");
assert.equal(cloudConflictSnapshot.audit.classificationReason, "cloud_provider_local_endpoint_conflict");
assert.equal(cloudConflictSnapshot.audit.configurationConflict, true);
assert.equal(cloudConflictSnapshot.audit.provider, "openrouter");
assert.equal(cloudConflictSnapshot.audit.model, settings.aiModel);
assert.equal(typeof cloudConflictSnapshot.audit.profileRevision, "number");

// A present canonical record is authoritative even when flat rollback values
// look usable. Corruption and a broken active pointer must surface explicitly.
const canonicalState = structuredClone((await import("../src/shared/ai-profiles.js")).migrateAiProfiles({
  stored: undefined,
  legacy: { ...settings, aiProvider: "openrouter", aiBaseUrl: "https://openrouter.ai/api/v1", aiModel: "strict-model", aiCloudKey: "canonical-key" },
}).state);
const canonicalIdentity = canonicalState.active.providerIdentity;
storage.aiProfilesV1 = canonicalState;
storage.aiProfileCredentialsV1 = { [canonicalIdentity]: "canonical-key" };
const canonicalPromptKey = [canonicalIdentity, "strict-model", "th"].map(encodeURIComponent).join("::");
storage.aiProfilePromptsV1 = { [canonicalPromptKey]: { text: "strict full style", mode: "replace" } };
const emptyPromptSnapshot = await resolveJobAiProfile({
  ...settings,
  aiProvider: "ollama",
  aiBaseUrl: "http://localhost:11434",
  aiModel: "legacy-model",
  aiPrompt: "legacy prompt must not return",
  aiCloudKey: "legacy-key",
}, { language: "th" });
assert.equal(emptyPromptSnapshot.settings.aiProvider, "openrouter");
assert.equal(emptyPromptSnapshot.settings.aiModel, "strict-model");
assert.equal(emptyPromptSnapshot.settings.aiPrompt, "strict full style",
  "the canonical full style must win over stale flat prompt data");
storage.aiProfilePromptsV1 = {};
await assert.rejects(() => resolveJobAiProfile(settings, { language: "th" }),
  (error) => error.code === "AI_PROMPT_REQUIRED" && error.requestDispatched === false);
storage.aiProfilePromptsV1 = { [canonicalPromptKey]: { text: "strict full style", mode: "replace" } };
const flatMutatedSnapshot = await resolveJobAiProfile({
  ...settings,
  aiThinking: "on", aiLocalThinking: "on", aiPageImage: "always",
  aiMemoryMode: "full", aiLocalCapacityMode: "manual", aiLocalManualConcurrency: 31,
}, { language: "th" });
for (const key of ["aiThinking", "aiLocalThinking", "aiPageImage", "aiMemoryMode",
  "aiLocalCapacityMode", "aiLocalManualConcurrency", "aiPrompt"])
  assert.deepEqual(flatMutatedSnapshot.settings[key], emptyPromptSnapshot.settings[key],
    `strict v2 runtime must ignore stale flat ${key}`);
const savedCanonical = storage.aiProfilesV1;
storage.aiProfilesV1 = { ...canonicalState, version: 999 };
await assert.rejects(() => resolveJobAiProfile(settings),
  (error) => error.code === "AI_PROFILE_INVALID" &&
    error.profileValidationStage === "storage_contract" &&
    error.profileValidationReason === "Canonical AI profile schema is invalid");
storage.aiProfilesV1 = structuredClone(savedCanonical);
storage.aiProfilesV1.active.model = "missing-model";
await assert.rejects(() => resolveJobAiProfile(settings),
  (error) => error.code === "AI_PROFILE_INCOMPLETE");
delete storage.aiProfilesV1;
delete storage.aiProfileCredentialsV1;
delete storage.aiProfilePromptsV1;
delete storage.aiProfileStorageVersion;
assert.equal(autoAiSettingsIssue({
  aiProvider: "customlocal", aiBaseUrl: "http://127.0.0.1:9000/v1",
  aiKey: "", engineMode: "api",
})?.code, "custom_local_extension_only",
"the API engine must fail early with a clear instruction for custom adapters");
assert.equal(autoAiSettingsIssue({
  aiProvider: "customlocal", aiBaseUrl: "http://127.0.0.1:9000/v1",
  aiKey: "", engineMode: "extension",
}), null, "custom adapters remain available on the direct Extension engine");
assert.equal(autoAiSettingsIssue({
  aiProvider: "ollama", aiBaseUrl: "http://127.0.0.1:11434", engineMode: "extension",
}, { mainApiBaseUrl: "https://example.hf.space" }), null,
"Extension mode reaches Local AI directly even when the main API is remote");
assert.equal(autoAiSettingsIssue({
  aiProvider: "ollama", aiBaseUrl: "http://127.0.0.1:11434", engineMode: "api",
}, { mainApiBaseUrl: "https://example.hf.space" })?.code, "local_ai_unreachable_from_remote_api",
"a remote API must not mistake its localhost for the user's PC");
assert.equal(autoAiSettingsIssue({
  aiProvider: "ollama", aiBaseUrl: "http://127.0.0.1:11434", engineMode: "api",
}, { mainApiBaseUrl: "http://192.168.1.20:8000" }), null,
"a self-hosted local API may reach Local AI on its network");

// Keep this test dependency-light: context-menu imports the whole service-worker
// graph, which expects browser APIs at module evaluation time. The source checks
// protect the authoritative placement and its conservative server-key policy.
assert.match(contextMenuSource, /has_env_ai_key/);
assert.match(contextMenuSource, /if \(mode === "lens_text" && source === "ai"\)/,
  "preflight must cover both manual and Auto text.ai paths");
assert.match(contextMenuSource, /readFullSettings\(\{ lang: effectiveLang \}\)/);
assert.match(contextMenuSource, /if \(options\?\.propagateErrors === true\) throw e;/,
  "programmatic callers must receive failures caught by the menu boundary");
const backgroundSource = await (await import("node:fs/promises")).readFile(
  new URL("../src/background/index.js", import.meta.url), "utf8",
);
assert.match(backgroundSource, /propagateErrors:\s*true/);
assert.match(backgroundSource, /catch\(\(e\)\s*=>\s*sendResponse\(\{[\s\S]*?ok:\s*false,[\s\S]*?tpError:\s*publicTpError\(e\)/,
  "TP_RUN must turn a propagated start failure into a structured negative response");
assert.doesNotMatch(contextMenuSource, /apiKey.*message|message.*aiKey/,
  "configuration messages must not expose a credential");

// Exercise the real outer catch boundary, not just its source text. A local
// provider without an endpoint makes assertAutoAiReady throw before enqueue.
// Programmatic Auto must reject; legacy browser menu invocation must retain
// its historical log-and-resolve behavior.
storage.aiProvider = "ollama";
storage.aiBaseUrl = "";
storage.aiKey = "do-not-print-this-key";
const { buildRatePayload, onContextMenuClicked } = await import("../src/background/context-menu.js");

delete storage.rateLimitEnabled;
delete storage.rateRpm;
delete storage.rateBurst;
storage.aiProvider = "gemini";
storage.aiBaseUrl = "https://generativelanguage.googleapis.com";
const freshRateSettings = await readFullSettings();
assert.equal(freshRateSettings.rateLimitEnabled, false,
  "fresh settings must keep the manual request-rate cap disabled");
assert.deepEqual(
  buildRatePayload("lens_text", "ai", freshRateSettings),
  { enabled: false, rpm: 0, burst: 0 },
  "fresh cloud settings must produce rate.enabled=false even when visible RPM defaults exist",
);
assert.deepEqual(
  buildRatePayload("lens_text", "ai", {
    ...freshRateSettings, rateLimitEnabled: true, rateRpm: 30, rateBurst: 4,
  }),
  { enabled: true, rpm: 30, burst: 4 },
  "manual pacing activates only after explicit opt-in with rpm > 0",
);
// Restore the preflight fixture below; no test may leak a cloud provider into
// a later case and accidentally perform a real network request.
storage.aiProvider = "ollama";
storage.aiBaseUrl = "";

assert.deepEqual(
  buildRatePayload("lens_text", "ai", {
    aiProvider: "ollama", aiBaseUrl: "http://127.0.0.1:11434",
    rateLimitEnabled: true, rateRpm: 30, rateBurst: 4,
  }),
  { enabled: false, rpm: 0, burst: 0, unlimited: true },
  "direct-local must always bypass legacy time/RPM pacing while capacity remains separately bounded",
);
assert.deepEqual(
  buildRatePayload("lens_text", "ai", {
    aiProvider: "gemini", aiBaseUrl: "https://generativelanguage.googleapis.com",
    rateLimitEnabled: true, rateRpm: 0, rateBurst: 4,
  }),
  { enabled: false, rpm: 0, burst: 0 },
  "cloud Burst alone must not activate a time/RPM cap",
);
assert.deepEqual(
  buildRatePayload("lens_text", "ai", {
    aiProvider: "gemini", aiBaseUrl: "https://generativelanguage.googleapis.com",
    rateLimitEnabled: true, rateRpm: 30, rateBurst: 4,
  }),
  { enabled: true, rpm: 30, burst: 4 },
  "cloud manual pacing requires both the explicit switch and RPM > 0",
);
const savedConsoleError = console.error;
console.error = () => {};
try {
  await assert.rejects(
    onContextMenuClicked(
      { menuItemId: "img_one" },
      { id: 7, url: "chrome-extension://test/auto.html", title: "Auto" },
      {
        overrides: { mode: "lens_text", lang: "th", source: "ai" },
        propagateErrors: true,
      },
    ),
    (error) => error?.tpError?.code === "ai_endpoint_missing" &&
      !String(error?.message || "").includes(storage.aiKey),
    "TP_RUN's programmatic path must reject with a safe structured preflight error",
  );
  await assert.doesNotReject(
    onContextMenuClicked(
      { menuItemId: "img_one" },
      { id: 7, url: "https://example.invalid/page", title: "Page" },
      { overrides: { mode: "lens_text", lang: "th", source: "ai" } },
    ),
    "legacy context-menu behavior must continue to consume and log the same failure",
  );
} finally {
  console.error = savedConsoleError;
}

console.log("Auto AI settings contract test passed: effective-language prompt and conservative preflight are wired.");
