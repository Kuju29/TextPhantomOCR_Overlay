import assert from "node:assert/strict";

import {
  buildAiProfileStoragePatch,
  createAiProfiles,
  makeProfilePromptKey,
  makeProviderIdentity,
  migrateAiProfiles,
  resolveAiProfile,
  sanitizeAiProfileTrace,
  setAiProfilePrompt,
  updateAiProfile,
} from "../src/shared/ai-profiles.js";
import { createAiUsageController } from "../src/popup/controllers/ai-usage-controller.js";

const defaults = {
  thinking: "off",
  tokenPolicy: { mode: "dynamic", maxOutputTokens: 0 },
  temperature: null,
  pageImage: "off",
  memoryMode: "off",
  concurrency: { mode: "auto", max: 0 },
  providerOptions: {},
};

const targets = [
  { runtime: "cloud", provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "cloud-a" },
  { runtime: "cloud", provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "cloud-b" },
  { runtime: "cloud", provider: "customcloud", endpoint: "https://cloud.example/v1", model: "cloud-a" },
  { runtime: "cloud", provider: "customcloud", endpoint: "https://cloud.example/v1", model: "cloud-b" },
  { runtime: "local", provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "local-a" },
  { runtime: "local", provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "local-b" },
];

let state = createAiProfiles();
const credentials = {};
const prompts = {};

// Discovery is read-only: resolving every discovered model must not create a
// provider or model record.
for (const target of targets) {
  const result = resolveAiProfile(state, { ...target, defaults });
  assert.strictEqual(result.state, state);
  assert.deepEqual(result.profile, defaults);
}
assert.deepEqual(state.providers, {});

// Cloud 2 providers x 2 models and Local 2 models each receive independent
// values. A newly selected model starts from defaults, not the previous model.
for (const [index, target] of targets.entries()) {
  const before = resolveAiProfile(state, { ...target, defaults });
  assert.equal(before.profile.thinking, "off", `${target.provider}/${target.model} leaked a previous profile`);
  state = updateAiProfile(state, {
    ...target,
    defaults,
    patch: {
      thinking: index % 2 ? "on" : "off",
      tokenPolicy: { mode: "manual", maxOutputTokens: 1000 + index },
      temperature: index / 10,
    },
    select: true,
    now: 100 + index,
  });
}

for (const [index, target] of targets.entries()) {
  const restored = resolveAiProfile(state, { ...target, defaults }).profile;
  assert.equal(restored.thinking, index % 2 ? "on" : "off");
  assert.equal(restored.tokenPolicy.maxOutputTokens, 1000 + index);
  assert.equal(restored.temperature, index / 10);
}

// Provider connection credentials are provider-scoped and never duplicated in
// a model record. Prompts are isolated by Provider + Model + Language.
for (const target of targets) {
  const identity = makeProviderIdentity(target.provider, target.endpoint);
  if (target.runtime === "cloud") credentials[identity] ??= `cloud-secret-${target.provider}`;
  prompts[makeProfilePromptKey(identity, target.model, "th")] = { text: `prompt:${target.provider}:${target.model}:th`, mode: "replace" };
  prompts[makeProfilePromptKey(identity, target.model, "en")] = { text: `prompt:${target.provider}:${target.model}:en`, mode: "replace" };
}
for (const target of targets) {
  const identity = makeProviderIdentity(target.provider, target.endpoint);
  const providerRecord = state.providers[identity];
  assert.ok(providerRecord);
  assert.equal(providerRecord.endpoint.includes(target.endpoint.replace(/\/$/, "")), true);
  for (const record of Object.values(providerRecord.models)) {
    assert.equal(JSON.stringify(record).includes(credentials[identity]), false, "credential duplicated into a model profile");
  }
  assert.notEqual(
    prompts[makeProfilePromptKey(identity, target.model, "th")],
    prompts[makeProfilePromptKey(identity, target.model, "en")],
  );
}

// Dual-write keeps rollback fields while retaining the canonical profile.
const active = targets.at(-1);
const activeIdentity = makeProviderIdentity(active.provider, active.endpoint);
const storagePatch = buildAiProfileStoragePatch({
  state,
  credentials,
  prompts,
  providerIdentity: activeIdentity,
  model: active.model,
  language: "th",
});
assert.strictEqual(storagePatch.aiProfilesV1.active.model, active.model);
assert.equal(storagePatch.aiProvider, active.provider);
assert.equal(storagePatch.aiModel, active.model);
assert.equal(storagePatch.aiCloudKey, undefined, "Local profile must not expose a Cloud credential field");
assert.equal(JSON.stringify(storagePatch.aiProfilesV1).includes("cloud-secret-"), false);

// Credential isolation regression: chrome.storage.local.set() merges keys, so
// omitting aiCloudKey while switching identities is not sufficient to clear a
// legacy key. Endpoint B must neither inherit, save nor display endpoint A's
// key; switching back may restore A and only A.
const endpointA = { runtime: "cloud", provider: "customcloud", endpoint: "https://a.example/v1", model: "shared" };
const endpointB = { runtime: "cloud", provider: "customcloud", endpoint: "https://b.example/v1", model: "shared" };
const identityA = makeProviderIdentity(endpointA.provider, endpointA.endpoint);
const identityB = makeProviderIdentity(endpointB.provider, endpointB.endpoint);
let credentialState = createAiProfiles();
for (const target of [endpointA, endpointB]) {
  credentialState = updateAiProfile(credentialState, {
    ...target, defaults, patch: {}, select: true, now: 500,
  });
}
const isolatedCredentials = { [identityA]: "endpoint-a-secret" };
let browserStorage = { aiCloudKey: "endpoint-a-secret" };
const applyStoragePatch = (patch) => { Object.assign(browserStorage, structuredClone(patch)); };

applyStoragePatch(buildAiProfileStoragePatch({
  state: credentialState, credentials: isolatedCredentials, prompts: {},
  providerIdentity: identityA, model: endpointA.model, language: "th",
}));
assert.equal(browserStorage.aiCloudKey, "endpoint-a-secret");

applyStoragePatch(buildAiProfileStoragePatch({
  state: credentialState, credentials: isolatedCredentials, prompts: {},
  providerIdentity: identityB, model: endpointB.model, language: "th",
}));
assert.notEqual(browserStorage.aiCloudKey, "endpoint-a-secret",
  "switching to endpoint B retained endpoint A's merged legacy key");
assert.equal(isolatedCredentials[identityB], undefined, "endpoint A credential moved to endpoint B");
assert.equal(JSON.stringify(credentialState.providers[identityB]).includes("endpoint-a-secret"), false);

applyStoragePatch(buildAiProfileStoragePatch({
  state: credentialState, credentials: isolatedCredentials, prompts: {},
  providerIdentity: identityA, model: endpointA.model, language: "th",
}));
assert.equal(browserStorage.aiCloudKey, "endpoint-a-secret", "switching back did not restore endpoint A's key");
assert.deepEqual(Object.keys(isolatedCredentials), [identityA], "credential changed provider identity");

// A legacy Cloud key must not be migrated into a Local provider identity.
const migratedWhileLocal = migrateAiProfiles({
  legacy: {
    aiProvider: "ollama",
    aiBaseUrl: "http://127.0.0.1:11434",
    aiModel: "local-a",
    aiCloudKey: "legacy-cloud-secret",
    lang: "th",
  },
  now: 600,
});
const localIdentity = makeProviderIdentity("ollama", "http://127.0.0.1:11434");
assert.equal(migratedWhileLocal.credentials[localIdentity], undefined,
  "legacy Cloud key was attached to the active Local provider");
assert.equal(JSON.stringify(migratedWhileLocal.state).includes("legacy-cloud-secret"), false);

// Rapid switches must render zero immediately and ignore stale async refreshes.
const renders = [];
let selected = targets[0];
let releaseFirst;
const firstPersist = new Promise((resolve) => { releaseFirst = resolve; });
let calls = 0;
const usage = createAiUsageController({
  persistBoundary: async () => { if (++calls === 1) await firstPersist; },
  readCurrentUsage: (_ledger, target) => ({ ...target, requests: 9, totalTokens: 900 }),
  renderUsage: (row) => renders.push(row),
});
const stale = usage.select(targets[0], () => selected);
selected = targets[1];
const current = usage.select(targets[1], () => selected);
releaseFirst();
await Promise.all([stale, current]);
assert.equal(renders[0].totalTokens, 0);
assert.equal(renders[1].totalTokens, 0);
assert.equal(renders.some((row) => row.model === targets[0].model && row.totalTokens === 900), false);

// Diagnostics remain content-free even when source state is populated.
const diagnostic = JSON.stringify(sanitizeAiProfileTrace({ state }));
for (const forbidden of [...Object.values(credentials), ...Object.values(prompts), "cloud.example", "openrouter.ai", "127.0.0.1"]) {
  assert.equal(diagnostic.includes(forbidden), false, `profile trace leaked ${forbidden}`);
}

// Activation must be a public behavioral seam. This intentionally remains RED
// until runtime activation lands; no source-string assertions are permitted.
let activation;
try {
  activation = await import("../src/shared/ai-profile-activation.js");
} catch (error) {
  assert.fail(`AI Profile activation boundary is missing: ${error.code || error.message}`);
}
for (const name of [
  "createAiProfileActivationController",
  "resolveEffectiveAiProfile",
  "buildEffectiveAiPayload",
]) {
  assert.equal(typeof activation[name], "function", `activation must export ${name}()`);
}

// These checks exercise actual exported runtime boundaries once implemented:
// immutable in-flight snapshots, allowlisted provider options, and the exact
// same effective snapshot for runsextension and runsapi.
const activationController = activation.createAiProfileActivationController({ state, credentials, prompts, defaults });
const selectedSnapshot = activationController.select(targets[0], { language: "th" });
const inFlight = structuredClone(selectedSnapshot);
activationController.select(targets[1], { language: "th" });
assert.deepEqual(selectedSnapshot, inFlight, "an in-flight snapshot mutated after a model switch");

const effective = activation.resolveEffectiveAiProfile(selectedSnapshot);
const extensionPayload = activation.buildEffectiveAiPayload(effective, { engine: "runsextension" });
const apiPayload = activation.buildEffectiveAiPayload(effective, { engine: "runsapi" });
assert.deepEqual(extensionPayload.ai, apiPayload.ai, "engines received different effective AI settings");
assert.deepEqual(Object.keys(extensionPayload.ai.providerOptions || {}).sort(),
  ["reasoningEffort", "reasoningExclude", "responseFormat"].filter((key) => key in (extensionPayload.ai.providerOptions || {})).sort());
assert.equal(effective.promptMode, "replace");
assert.equal(extensionPayload.ai.prompt_mode, "replace");
for (const invalidMode of [undefined, "", "fallback", null]) {
  assert.throws(
    () => activation.resolveEffectiveAiProfile({ ...selectedSnapshot, promptMode: invalidMode }),
    (error) => error.code === "AI_PROFILE_INVALID",
    "activation must not coerce an invalid canonical prompt mode",
  );
  assert.throws(
    () => activation.buildEffectiveAiPayload({ ...effective, promptMode: invalidMode }),
    (error) => error.code === "AI_PROFILE_INVALID",
    "wire payload must not coerce an invalid canonical prompt mode",
  );
}

const replacePromptKey = makeProfilePromptKey(
  makeProviderIdentity(targets[0].provider, targets[0].endpoint),
  targets[0].model,
  "th",
);
const replaceController = activation.createAiProfileActivationController({
  state,
  credentials,
  prompts: setAiProfilePrompt(prompts, replacePromptKey, {
    text: "replace instructions",
    mode: "replace",
  }),
  defaults,
});
const replaceEffective = activation.resolveEffectiveAiProfile(
  replaceController.select(targets[0], { language: "th" }),
);
assert.equal(replaceEffective.prompt, "replace instructions");
assert.equal(replaceEffective.promptMode, "replace");
assert.equal(
  activation.buildEffectiveAiPayload(replaceEffective).ai.prompt_mode,
  "replace",
);

// Exercise the actual activation/popup controller credential view as well as
// the pure storage core. Selecting B must produce an empty credential view,
// and selecting A again must restore only A's credential.
const credentialController = activation.createAiProfileActivationController({
  state: credentialState,
  credentials: isolatedCredentials,
  prompts: {},
  defaults,
});
const viewA = credentialController.select(endpointA, { language: "th" });
assert.equal(viewA.credential, "endpoint-a-secret");
const viewB = credentialController.select(endpointB, { language: "th" });
assert.ok(viewB.credential === "" || viewB.credential == null,
  "popup activation view showed endpoint A key after selecting endpoint B");
assert.equal(isolatedCredentials[identityB], undefined);
const restoredViewA = credentialController.select(endpointA, { language: "th" });
assert.equal(restoredViewA.credential, "endpoint-a-secret");

console.log("AI Profiles activation matrix passed: cloud 2x2, local 2, UI/storage/payload parity.");
