import assert from "node:assert/strict";

import { makeProfilePromptKey, makeProviderIdentity } from "../src/shared/ai-profiles.js";
import * as popupProfiles from "../src/popup/controllers/ai-profile-controller.js";

assert.equal(typeof popupProfiles.createAiProfileController, "function");

const cloudA = { provider: "customcloud", endpoint: "https://a.example/v1", model: "model-a" };
const cloudB = { provider: "customcloud", endpoint: "https://b.example/v1", model: "model-b" };
const local = { provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "local-a" };
const idA = makeProviderIdentity(cloudA.provider, cloudA.endpoint);
const idB = makeProviderIdentity(cloudB.provider, cloudB.endpoint);
const localId = makeProviderIdentity(local.provider, local.endpoint);
const clone = (value) => structuredClone(value);
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function popupFixture(initial = {}) {
  const storage = {
    aiProfilesV1: undefined, aiProfileCredentialsV1: {}, aiProfilePromptsV1: {},
    aiProvider: cloudA.provider, aiBaseUrl: cloudA.endpoint, aiModel: cloudA.model,
    aiCloudKey: "", aiPrompt: "", lang: "th", ...clone(initial),
  };
  const els = {
    aiProvider: { value: storage.aiProvider }, aiBaseUrl: { value: storage.aiBaseUrl },
    aiModel: { value: storage.aiModel }, aiThinking: { value: "off" },
    aiPageImage: { checked: false }, aiMemoryMode: { value: "off" },
    aiLocalCapacityMode: { value: "auto" }, aiLocalManualConcurrency: { value: "1" },
    aiPrompt: { value: storage.aiPrompt }, lang: { value: storage.lang },
  };
  const state = { desiredAiModel: storage.aiModel, desiredLang: storage.lang, aiPromptByLang: {} };
  const writes = [];
  const setStorage = async (patch) => { writes.push(clone(patch)); Object.assign(storage, clone(patch)); };
  const controller = popupProfiles.createAiProfileController({ els, state, setStorage, now: () => 100 });
  const select = (target) => {
    els.aiProvider.value = target.provider; els.aiBaseUrl.value = target.endpoint;
    els.aiModel.value = target.model; state.desiredAiModel = target.model;
    return controller.bindConnection(target);
  };
  return { controller, els, state, storage, writes, setStorage, select };
}

// A strict-v2 failure creates only an editable recovery draft. Explicit save
// persists a clean v2 record and unblocks AI; initialization itself writes none.
{
  const recovery = popupFixture({
    aiProfileStorageVersion: 2,
    aiProfilesV1: { version: 99, providers: {} },
  });
  await assert.rejects(() => recovery.controller.initialize(recovery.storage),
    (error) => error.code === "AI_PROFILE_INVALID");
  assert.equal(recovery.writes.length, 0);
  recovery.state.aiProfileBlocked = true;
  recovery.controller.beginRecovery(recovery.storage);
  await recovery.controller.saveProfile({ thinking: "off" });
  assert.equal(recovery.storage.aiProfileStorageVersion, 2);
  assert.equal(recovery.storage.aiProfilesV1.version, 1);
  assert.equal(recovery.state.aiProfileBlocked, false);
}

// Close before the 400 ms debounce: canonical and rollback fields must be one
// merged patch, produced by the actual popup controller API.
const first = popupFixture();
await first.controller.initialize(first.storage);
first.select(cloudA);
await first.setStorage(first.controller.buildClosePatch({
  credential: "new-key-a", saveCredential: true, language: "th", model: cloudA.model,
  prompt: "new prompt A", savePrompt: true,
}));
assert.equal(first.storage.aiProfileCredentialsV1[idA], "new-key-a");
assert.deepEqual(first.storage.aiProfilePromptsV1[makeProfilePromptKey(idA, cloudA.model, "th")], { text: "new prompt A", mode: "replace" });
assert.equal(first.storage.aiProvider, cloudA.provider);
assert.equal(first.storage.aiBaseUrl, cloudA.endpoint);
assert.equal(first.storage.aiModel, cloudA.model);
assert.equal(first.storage.aiCloudKey, "new-key-a");
assert.equal(first.storage.aiKey, "new-key-a");
assert.equal(first.storage.aiPrompt, "new prompt A");

// Reopen through initialize/select and recover the new canonical values.
const reopened = popupFixture(first.storage);
await reopened.controller.initialize(reopened.storage);
const reopenedA = reopened.select(cloudA);
assert.equal(reopenedA.credential, "new-key-a");
assert.equal(reopened.els.aiPrompt.value, "new prompt A");

// Opening an existing canonical profile and later saving only its prompt must
// preserve the Provider/Model recency ordering. Hydration is not a selection
// event and must not manufacture newer timestamps.
{
  const canonical = clone(first.storage);
  canonical.aiProfilesV1.providers[idA].updatedAt = 17;
  canonical.aiProfilesV1.providers[idA].models[cloudA.model].updatedAt = 11;
  // Deliberately stale rollback fields verify canonical still owns hydration.
  canonical.aiProvider = "ollama";
  canonical.aiBaseUrl = local.endpoint;
  canonical.aiModel = local.model;
  const promptOnly = popupFixture(canonical);
  await promptOnly.controller.initialize(promptOnly.storage);
  assert.equal(promptOnly.els.aiProvider.value, cloudA.provider);
  assert.equal(promptOnly.state.desiredAiModel, cloudA.model);
  await promptOnly.controller.savePrompt("th", "prompt-only edit");
  const savedProvider = promptOnly.storage.aiProfilesV1.providers[idA];
  assert.equal(savedProvider.updatedAt, 17);
  assert.equal(savedProvider.models[cloudA.model].updatedAt, 11);
}

// Endpoint B never inherits A's key; switching back restores A only.
assert.equal(reopened.select(cloudB).credential, "");
await reopened.setStorage(reopened.controller.buildClosePatch({ language: "th", model: cloudB.model }));
assert.equal(reopened.storage.aiProfileCredentialsV1[idB], undefined);
assert.equal(reopened.storage.aiCloudKey, "");
assert.equal(reopened.storage.aiKey, "");
assert.equal(reopened.select(cloudA).credential, "new-key-a");

// Provider round-trips render the newly selected profile immediately. Text
// from the previous Provider must never remain visible in the textarea.
await reopened.controller.savePrompt("th", "style for provider A");
reopened.select(local);
await reopened.controller.savePrompt("th", "style for local");
reopened.select(cloudA);
reopened.select(local);
assert.equal(reopened.els.aiPrompt.value, "style for local");
reopened.select(cloudA);
assert.equal(reopened.els.aiPrompt.value, "style for provider A");
reopened.select(cloudB);
assert.equal(reopened.els.aiPrompt.value, "", "a new Provider retained stale textarea text");

// Async discovery may resolve `auto` to a concrete OpenRouter model. Seed the
// current language once from auto, persist it, and recover it after reopen.
const openRouterEndpoint = "https://openrouter.ai/api/v1";
const openRouterId = makeProviderIdentity("openrouter", openRouterEndpoint);
const autoDiscovery = popupFixture({
  aiProvider: "openrouter", aiBaseUrl: openRouterEndpoint, aiModel: "auto",
});
await autoDiscovery.controller.initialize(autoDiscovery.storage);
await autoDiscovery.controller.savePrompt("th", "OpenRouter auto Thai style");
const concrete = "deepseek/deepseek-v4-flash-0731";
autoDiscovery.els.aiModel.value = concrete;
autoDiscovery.state.desiredAiModel = concrete;
const seeded = autoDiscovery.controller.selectModel(concrete);
assert.equal(seeded.seededPrompt, true);
assert.equal(seeded.value, "OpenRouter auto Thai style");
assert.equal(autoDiscovery.els.aiPrompt.value, "OpenRouter auto Thai style");
await autoDiscovery.controller.persist();
assert.deepEqual(
  autoDiscovery.storage.aiProfilePromptsV1[makeProfilePromptKey(openRouterId, concrete, "th")],
  { text: "OpenRouter auto Thai style", mode: "replace" },
);

const reopenedDiscovery = popupFixture(autoDiscovery.storage);
await reopenedDiscovery.controller.initialize(reopenedDiscovery.storage);
assert.equal(reopenedDiscovery.els.aiPrompt.value, "OpenRouter auto Thai style");

// A concrete model's explicit Style, including an intentionally empty one,
// is isolated and is never overwritten by later changes to the auto Style.
await reopenedDiscovery.controller.savePrompt("th", "Concrete custom style");
reopenedDiscovery.els.aiModel.value = "auto";
reopenedDiscovery.state.desiredAiModel = "auto";
reopenedDiscovery.controller.selectModel("auto");
await reopenedDiscovery.controller.savePrompt("th", "New auto style");
reopenedDiscovery.els.aiModel.value = concrete;
reopenedDiscovery.state.desiredAiModel = concrete;
const existingConcrete = reopenedDiscovery.controller.selectModel(concrete);
assert.equal(existingConcrete.seededPrompt, false);
assert.equal(reopenedDiscovery.els.aiPrompt.value, "Concrete custom style");

const emptyModel = "provider/intentional-empty";
reopenedDiscovery.els.aiModel.value = emptyModel;
reopenedDiscovery.state.desiredAiModel = emptyModel;
reopenedDiscovery.controller.selectModel(emptyModel);
await reopenedDiscovery.controller.savePrompt("th", "");
reopenedDiscovery.controller.selectModel("auto");
const explicitEmpty = reopenedDiscovery.controller.selectModel(emptyModel);
assert.equal(explicitEmpty.seededPrompt, false);
assert.equal(reopenedDiscovery.els.aiPrompt.value, "");

// A migrated OpenRouter profile must never inherit a loopback endpoint from
// Ollama. The canonical + legacy selection is committed in one storage write.
const staleOpenRouterId = makeProviderIdentity("openrouter", "http://localhost:11434");
const staleCloud = popupFixture({
  aiProvider: "ollama", aiBaseUrl: local.endpoint, aiModel: local.model,
  aiProfilesV1: {
    version: 1,
    active: { providerIdentity: localId, model: local.model },
    providers: {
      [localId]: { provider: "ollama", endpoint: local.endpoint, updatedAt: 90, models: {
        [local.model]: { profile: {
          thinking: "off", tokenPolicy: { mode: "dynamic", maxOutputTokens: 0 },
          temperature: null, pageImage: "off", memoryMode: "off",
          concurrency: { mode: "auto", max: 0 }, providerOptions: {},
        }, updatedAt: 90 },
      } },
      [staleOpenRouterId]: { provider: "openrouter", endpoint: "http://localhost:11434", updatedAt: 95, models: {} },
    },
  },
});
await assert.rejects(() => staleCloud.controller.initialize(staleCloud.storage),
  (error) => error.code === "AI_PROFILE_MIGRATION_CONFLICT",
  "a malformed canonical provider identity must be reported, not repaired invisibly");

// Reopening directly on a stale Cloud profile repairs storage immediately;
// the background must not keep seeing localhost after the popup looks Cloud.
const reopenStaleCloud = popupFixture({
  aiProvider: "openrouter", aiBaseUrl: "http://localhost:11434", aiModel: "auto",
  aiProfilesV1: {
    version: 1,
    active: { providerIdentity: staleOpenRouterId, model: "auto" },
    providers: {
      [staleOpenRouterId]: {
        provider: "openrouter", endpoint: "http://localhost:11434", updatedAt: 95,
        models: { auto: { profile: {}, updatedAt: 95 } },
      },
    },
  },
});
await assert.rejects(() => reopenStaleCloud.controller.initialize(reopenStaleCloud.storage),
  (error) => error.code === "AI_PROFILE_MIGRATION_CONFLICT");

// First-time Local -> Cloud must work when no Cloud profile exists. Empty and
// legacy default sentinels all resolve before Provider identity validation.
for (const endpoint of ["", " ", "auto", "default", "localhost:11434", "not a url"]) {
  const freshCloud = popupFixture({ aiProvider: local.provider, aiBaseUrl: local.endpoint, aiModel: local.model });
  await freshCloud.controller.initialize(freshCloud.storage);
  const transition = freshCloud.controller.beginProviderTransition("openrouter", endpoint);
  assert.equal(transition.selected.endpoint, "https://openrouter.ai/api/v1");
  await transition.commit();
  assert.equal(freshCloud.storage.aiProvider, "openrouter");
  assert.equal(freshCloud.storage.aiBaseUrl, "https://openrouter.ai/api/v1");
}

const cloudDefaults = {
  openai: "https://api.openai.com/v1", openrouter: "https://openrouter.ai/api/v1",
  huggingface: "https://router.huggingface.co/v1", featherless: "https://api.featherless.ai/v1",
  groq: "https://api.groq.com/openai/v1", together: "https://api.together.xyz/v1",
  deepseek: "https://api.deepseek.com/v1", anthropic: "https://api.anthropic.com",
};
for (const [provider, expectedEndpoint] of Object.entries(cloudDefaults)) {
  const fixture = popupFixture({ aiProvider: local.provider, aiBaseUrl: local.endpoint, aiModel: local.model });
  await fixture.controller.initialize(fixture.storage);
  const transition = fixture.controller.beginProviderTransition(provider, "localhost:11434");
  assert.equal(transition.selected.endpoint, expectedEndpoint);
}

const malformedId = "openrouter::legacy-malformed";
const malformedStored = popupFixture({
  aiProvider: "openrouter", aiBaseUrl: "not a url", aiModel: "auto",
  aiProfilesV1: {
    version: 1, active: { providerIdentity: malformedId, model: "auto" },
    providers: { [malformedId]: {
      provider: "openrouter", endpoint: "localhost:11434", updatedAt: 95,
      models: { auto: { profile: {}, updatedAt: 95 } },
    } },
  },
});
await assert.rejects(() => malformedStored.controller.initialize(malformedStored.storage),
  (error) => error.code === "AI_PROFILE_MIGRATION_INCOMPLETE");

const unsafeSwitch = popupFixture({ aiProvider: local.provider, aiBaseUrl: local.endpoint, aiModel: local.model });
await unsafeSwitch.controller.initialize(unsafeSwitch.storage);
for (const endpoint of ["javascript:alert(1)", "file:///tmp/provider"]) {
  const transition = unsafeSwitch.controller.beginProviderTransition("openrouter", endpoint);
  assert.equal(transition.selected.endpoint, "https://openrouter.ai/api/v1",
    "a named Cloud provider must ignore stale/untrusted endpoint text and use its canonical host");
}
await unsafeSwitch.controller.saveConnection(local);
assert.equal(unsafeSwitch.storage.aiProvider, local.provider);
assert.equal(unsafeSwitch.storage.aiBaseUrl, local.endpoint);

// Failed persistence restores controller identity so a popup can roll its DOM
// back without leaving runtime selection on Ollama or half-selecting Cloud.
let rejected = false;
const rejectingFixture = popupFixture({ aiProvider: local.provider, aiBaseUrl: local.endpoint, aiModel: local.model });
rejectingFixture.controller = popupProfiles.createAiProfileController({
  els: rejectingFixture.els,
  state: rejectingFixture.state,
  setStorage: async (patch) => {
    if (rejected) throw new Error("storage unavailable");
    await rejectingFixture.setStorage(patch);
  },
  now: () => 100,
});
await rejectingFixture.controller.initialize(rejectingFixture.storage);
rejected = true;
rejectingFixture.els.aiProvider.value = "openrouter";
rejectingFixture.els.aiBaseUrl.value = "http://localhost:11434";
rejectingFixture.state.desiredAiModel = "auto";
const failedTransition = rejectingFixture.controller.beginProviderTransition("openrouter", rejectingFixture.els.aiBaseUrl.value);
rejectingFixture.els.aiBaseUrl.value = failedTransition.selected.endpoint;
await assert.rejects(() => failedTransition.commit(), /storage unavailable/);
rejected = false;
rejectingFixture.els.aiProvider.value = local.provider;
rejectingFixture.els.aiBaseUrl.value = local.endpoint;
rejectingFixture.state.desiredAiModel = local.model;
await rejectingFixture.controller.saveConnection(local);
assert.equal(rejectingFixture.storage.aiProvider, local.provider);
assert.equal(rejectingFixture.storage.aiBaseUrl, local.endpoint);

// Overlapping Provider writes may settle out of order in chrome.storage. A
// late A completion must be corrected back to B, while controller/UI state
// and Provider-specific data remain bound to B.
const raceFixture = popupFixture({
  aiProvider: local.provider, aiBaseUrl: local.endpoint, aiModel: local.model,
});
const providerWriteA = deferred();
let delayedA = true;
raceFixture.controller = popupProfiles.createAiProfileController({
  els: raceFixture.els,
  state: raceFixture.state,
  setStorage: async (patch) => {
    const copy = clone(patch);
    if (delayedA && copy.aiProvider === "openrouter") {
      delayedA = false;
      await providerWriteA.promise;
    }
    raceFixture.writes.push(copy);
    Object.assign(raceFixture.storage, copy);
  },
  now: () => 100,
});
await raceFixture.controller.initialize(raceFixture.storage);
raceFixture.els.aiProvider.value = "openrouter";
raceFixture.els.aiBaseUrl.value = openRouterEndpoint;
raceFixture.state.desiredAiModel = "auto";
const transitionA = raceFixture.controller.beginProviderTransition("openrouter", openRouterEndpoint);
const commitA = transitionA.commit();
raceFixture.els.aiProvider.value = "gemini";
raceFixture.els.aiBaseUrl.value = "";
raceFixture.state.desiredAiModel = "auto";
const transitionB = raceFixture.controller.beginProviderTransition("gemini", "");
raceFixture.els.aiBaseUrl.value = transitionB.selected.endpoint;
const resultB = await transitionB.commit();
assert.equal(resultB.stale, undefined);
assert.equal(raceFixture.storage.aiProvider, "gemini");
providerWriteA.resolve();
const resultA = await commitA;
assert.equal(resultA.stale, true);
assert.equal(raceFixture.storage.aiProvider, "gemini", "late Provider A overwrote Provider B");
assert.equal(raceFixture.controller.currentProviderIdentity(), transitionB.selected.providerIdentity);
assert.equal(raceFixture.els.aiProvider.value, "gemini");
assert.equal(
  raceFixture.storage.aiProfilesV1.active.providerIdentity,
  transitionB.selected.providerIdentity,
  "late Provider A contaminated the active profile",
);

// Failure from an obsolete write is swallowed: it must neither roll back B
// nor masquerade as a save failure for the Provider currently visible.
const staleFailureFixture = popupFixture({
  aiProvider: local.provider, aiBaseUrl: local.endpoint, aiModel: local.model,
});
const failA = deferred();
let rejectOldA = true;
staleFailureFixture.controller = popupProfiles.createAiProfileController({
  els: staleFailureFixture.els,
  state: staleFailureFixture.state,
  setStorage: async (patch) => {
    const copy = clone(patch);
    if (rejectOldA && copy.aiProvider === "openrouter") {
      rejectOldA = false;
      await failA.promise;
    }
    Object.assign(staleFailureFixture.storage, copy);
  },
  now: () => 100,
});
await staleFailureFixture.controller.initialize(staleFailureFixture.storage);
staleFailureFixture.els.aiProvider.value = "openrouter";
staleFailureFixture.els.aiBaseUrl.value = openRouterEndpoint;
staleFailureFixture.state.desiredAiModel = "auto";
const staleA = staleFailureFixture.controller.beginProviderTransition("openrouter", openRouterEndpoint);
const staleACommit = staleA.commit();
staleFailureFixture.els.aiProvider.value = "gemini";
staleFailureFixture.els.aiBaseUrl.value = "";
staleFailureFixture.state.desiredAiModel = "auto";
const currentB = staleFailureFixture.controller.beginProviderTransition("gemini", "");
staleFailureFixture.els.aiBaseUrl.value = currentB.selected.endpoint;
await currentB.commit();
failA.reject(new Error("obsolete storage failure"));
const staleFailure = await staleACommit;
assert.equal(staleFailure.stale, true);
assert.equal(staleFailure.writeFailed, true);
assert.equal(staleFailureFixture.storage.aiProvider, "gemini");
assert.equal(staleFailureFixture.controller.currentProviderIdentity(), currentB.selected.providerIdentity);

// Local flush stores its prompt, but no key under the Local identity.
reopened.select(local);
await reopened.setStorage(reopened.controller.buildClosePatch({
  credential: "must-not-save-local", saveCredential: true, language: "th", model: local.model,
  prompt: "local prompt", savePrompt: true,
}));
assert.equal(reopened.storage.aiProfileCredentialsV1[localId], undefined);
assert.equal(reopened.storage.aiCloudKey, "");
assert.equal(reopened.storage.aiKey, "");
assert.deepEqual(reopened.storage.aiProfilePromptsV1[makeProfilePromptKey(localId, local.model, "th")], { text: "local prompt", mode: "replace" });

// The lifecycle/debounce coordinator must be an exported behavioral seam.
// buildClosePatch alone cannot prove pagehide cancels a pending callback.
assert.equal(typeof popupProfiles.createAiProfilePagehideFlush, "function",
  "popup controller must export createAiProfilePagehideFlush()");

const page = new EventTarget();
let timerId = 0;
const timers = new Map();
const setTimer = (fn) => { const id = ++timerId; timers.set(id, fn); return id; };
const clearTimer = (id) => timers.delete(id);
const lifecycle = popupProfiles.createAiProfilePagehideFlush({
  controller: reopened.controller, eventTarget: page, persist: reopened.setStorage,
  debounceMs: 400, setTimer, clearTimer,
});
assert.equal(typeof lifecycle.schedule, "function");
assert.equal(typeof lifecycle.whenIdle, "function");

// pagehide supersedes pending debounce; even a captured stale callback cannot
// overwrite the later values.
reopened.select(cloudA);
lifecycle.schedule({ credential: "stale-key", saveCredential: true, language: "th", model: cloudA.model,
  prompt: "stale prompt", savePrompt: true });
const staleCallback = timers.values().next().value;
lifecycle.schedule({ credential: "latest-key", saveCredential: true, language: "th", model: cloudA.model,
  prompt: "latest prompt", savePrompt: true });
page.dispatchEvent(new Event("pagehide"));
await lifecycle.whenIdle();
await staleCallback?.();
await lifecycle.whenIdle();
assert.equal(reopened.storage.aiProfileCredentialsV1[idA], "latest-key");
assert.deepEqual(reopened.storage.aiProfilePromptsV1[makeProfilePromptKey(idA, cloudA.model, "th")], { text: "latest prompt", mode: "replace" });
assert.equal(reopened.storage.aiCloudKey, "latest-key");
assert.equal(reopened.storage.aiPrompt, "latest prompt");

// Switching A -> B while A is pending cannot save either edit to the wrong
// provider identity or let A replace B's active legacy fields.
lifecycle.schedule({ ...cloudA, language: "th", credential: "race-key-a", saveCredential: true,
  prompt: "race prompt A", savePrompt: true });
reopened.select(cloudB);
lifecycle.schedule({ ...cloudB, language: "th", credential: "race-key-b", saveCredential: true,
  prompt: "race prompt B", savePrompt: true });
page.dispatchEvent(new Event("pagehide"));
await lifecycle.whenIdle();
assert.equal(reopened.storage.aiProfileCredentialsV1[idA], "latest-key");
assert.equal(reopened.storage.aiProfileCredentialsV1[idB], "race-key-b");
assert.deepEqual(reopened.storage.aiProfilePromptsV1[makeProfilePromptKey(idB, cloudB.model, "th")], { text: "race prompt B", mode: "replace" });
assert.equal(reopened.storage.aiBaseUrl, cloudB.endpoint);
assert.equal(reopened.storage.aiCloudKey, "race-key-b");
assert.equal(reopened.storage.aiPrompt, "race prompt B");

// Deferred persistence proves writes are actually serialized. A begins first;
// B may be scheduled/pagehidden while A is pending, but persist(B) must not be
// invoked until A settles. The final merged canonical and legacy state is B.
const deferredStorage = {};
const deferredCalls = [];
const deferredPersist = (patch) => new Promise((resolve, reject) => {
  deferredCalls.push({
    patch: clone(patch),
    resolve: () => { Object.assign(deferredStorage, clone(patch)); resolve(); },
    reject,
  });
});
const deferredPage = new EventTarget();
const deferredLifecycle = popupProfiles.createAiProfilePagehideFlush({
  controller: reopened.controller, eventTarget: deferredPage, persist: deferredPersist,
  debounceMs: 400, setTimer, clearTimer,
});
reopened.select(cloudA);
const writeA = deferredLifecycle.flush({
  credential: "deferred-key-a", saveCredential: true, language: "th", model: cloudA.model,
  prompt: "deferred prompt A", savePrompt: true,
});
assert.equal(deferredCalls.length, 1, "A did not start synchronously");
reopened.select(cloudB);
deferredLifecycle.schedule({
  credential: "deferred-key-b", saveCredential: true, language: "th", model: cloudB.model,
  prompt: "deferred prompt B", savePrompt: true,
});
deferredPage.dispatchEvent(new Event("pagehide"));
assert.equal(deferredCalls.length, 1, "B started before pending write A settled");
deferredCalls[0].resolve();
await writeA;
await Promise.resolve();
assert.equal(deferredCalls.length, 2, "serialized write B did not start after A");
deferredCalls[1].resolve();
await deferredLifecycle.whenIdle();
assert.equal(deferredStorage.aiProfileCredentialsV1[idB], "deferred-key-b");
assert.deepEqual(deferredStorage.aiProfilePromptsV1[makeProfilePromptKey(idB, cloudB.model, "th")], { text: "deferred prompt B", mode: "replace" });
assert.equal(deferredStorage.aiBaseUrl, cloudB.endpoint);
assert.equal(deferredStorage.aiModel, cloudB.model);
assert.equal(deferredStorage.aiCloudKey, "deferred-key-b");
assert.equal(deferredStorage.aiPrompt, "deferred prompt B");

// Synchronous persistence failure during pagehide is contained. whenIdle()
// settles and exposes a controlled failure status; a later generation can
// recover and clear the failure.
let syncShouldFail = true;
const syncPage = new EventTarget();
const syncLifecycle = popupProfiles.createAiProfilePagehideFlush({
  controller: reopened.controller,
  eventTarget: syncPage,
  persist: (patch) => {
    if (syncShouldFail) throw new Error("sync storage failure");
    Object.assign(deferredStorage, clone(patch));
  },
  setTimer, clearTimer,
});
reopened.select(cloudB);
syncLifecycle.schedule({ credential: "sync-fail", saveCredential: true, language: "th", model: cloudB.model });
assert.doesNotThrow(() => syncPage.dispatchEvent(new Event("pagehide")),
  "pagehide leaked a synchronous persistence exception");
const syncFailure = await syncLifecycle.whenIdle();
assert.equal(syncFailure.ok, false);
assert.match(String(syncFailure.status || ""), /fail|error/i);
assert.match(String(syncFailure.error?.message || ""), /sync storage failure/i);
syncShouldFail = false;
syncLifecycle.schedule({ credential: "sync-recovered", saveCredential: true, language: "th", model: cloudB.model });
syncPage.dispatchEvent(new Event("pagehide"));
const syncRecovery = await syncLifecycle.whenIdle();
assert.equal(syncRecovery.ok, true);
assert.equal(deferredStorage.aiCloudKey, "sync-recovered");

// Async rejection follows the same controlled path and does not produce an
// unhandled rejection. A later successful generation remains usable.
let rejectAsync = true;
let unhandled = null;
const onUnhandled = (reason) => { unhandled = reason; };
process.once("unhandledRejection", onUnhandled);
const asyncPage = new EventTarget();
const asyncLifecycle = popupProfiles.createAiProfilePagehideFlush({
  controller: reopened.controller,
  eventTarget: asyncPage,
  persist: async (patch) => {
    if (rejectAsync) throw new Error("async storage rejection");
    Object.assign(deferredStorage, clone(patch));
  },
  setTimer, clearTimer,
});
asyncLifecycle.schedule({ credential: "async-fail", saveCredential: true, language: "th", model: cloudB.model });
assert.doesNotThrow(() => asyncPage.dispatchEvent(new Event("pagehide")));
const asyncFailure = await asyncLifecycle.whenIdle();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(unhandled, null, "pagehide persistence created an unhandled rejection");
assert.equal(asyncFailure.ok, false);
assert.match(String(asyncFailure.status || ""), /fail|error/i);
assert.match(String(asyncFailure.error?.message || ""), /async storage rejection/i);
rejectAsync = false;
asyncLifecycle.schedule({ credential: "async-recovered", saveCredential: true, language: "th", model: cloudB.model });
asyncPage.dispatchEvent(new Event("pagehide"));
const asyncRecovery = await asyncLifecycle.whenIdle();
assert.equal(asyncRecovery.ok, true);
assert.equal(deferredStorage.aiCloudKey, "async-recovered");
process.removeListener("unhandledRejection", onUnhandled);

console.log("AI Profile popup pagehide/debounce/identity-race persistence tests passed.");
