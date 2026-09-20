import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const popup = await readFile(new URL("../src/popup/popup.js", import.meta.url), "utf8");
const localConnection = await readFile(
  new URL("../src/popup/controllers/local-connection-controller.js", import.meta.url),
  "utf8",
);
const providerMeta = await readFile(
  new URL("../src/popup/controllers/provider-meta-controller.js", import.meta.url),
  "utf8",
);

assert.match(popup, /localConnectSeq:\s*0/);
assert.match(popup, /localConnectInFlight:\s*null/);
assert.match(providerMeta, /if \(state\.localConnectInFlight\) return;/,
  "automatic discovery must not start a duplicate Local connection");
assert.match(providerMeta, /await local\.connect\(\)/,
  "Local provider selection must load installed-model metadata automatically");

assert.match(localConnection, /clearResolveTimer\(\)/,
  "Connect must cancel a pending blur refresh");
assert.match(localConnection, /const sequence = \+\+state\.localConnectSeq/);
assert.match(localConnection, /if \(state\.localConnectInFlight\) return;/,
  "manual refresh and automatic refresh must share one in-flight request");
assert.doesNotMatch(localConnection, /sequence !== state\.aiMetaSeq/,
  "generic metadata refresh must not invalidate Connect");
assert.match(localConnection, /finally[\s\S]*setBusy\(false\)/,
  "the button must be restored on every terminal outcome");
assert.match(localConnection, /provider, URL, or selected model changed/,
  "identity changes must have a visible terminal status");
assert.match(localConnection, /selectedModelVerification/,
  "Connect must consume selected-model metadata availability evidence");
assert.match(localConnection, /markModelChanged/,
  "changing a Local model must invalidate the previous availability proof");
assert.match(popup, /localConnectSeq:\s*0/);

// Exercise the real controller and Thinking event handler across async storage
// and response boundaries; no provider, browser or extension calls escape here.
const { createLocalConnectionController } = await import("../src/popup/controllers/local-connection-controller.js");
const { bindPopupEvents } = await import("../src/popup/controllers/popup-event-controller.js");
const { localVerificationSnapshotStatus } = await import("../src/shared/ai/direct-local/verification-snapshot.js");
const defer = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const element = (value = "") => ({ value, handlers: {}, disabled: false, textContent: "",
  addEventListener(type, fn) { this.handlers[type] = fn; } });
const endpoint = "http://localhost:11434", model = "qwen3.5:9b";
const key = "aiLocalCapabilitySnapshotsV1", identity = "ollama|" + endpoint;
function fixture({ persistGate = null, snapshotGate = null, saveGate = null } = {}) {
  const els = Object.fromEntries(["mode", "lang", "sources", "apiUrl", "resetApi", "aiKey", "aiPrompt",
    "aiProvider", "aiBaseUrl", "aiModel", "aiThinking", "aiLocalStatus", "aiLocalTest"].map(name => [name, element()]));
  Object.assign(els.aiProvider, { value: "ollama" });
  els.aiBaseUrl.value = endpoint; els.aiModel.value = model; els.aiThinking.value = "off";
  const state = { localConnectSeq: 0, localConnectInFlight: null, providerTransitionRevision: 0,
    desiredAiModel: model, aiModelBlocked: true };
  const storage = {}, requests = [], writes = [];
  const profile = { selectModel() {}, async saveProfile() { if (saveGate) await saveGate.promise; } };
  const controller = createLocalConnectionController({ els, state, profile,
    persist: async patch => {
      if (persistGate && patch.localAiAdapter) await persistGate.promise;
      writes.push(structuredClone(patch)); Object.assign(storage, structuredClone(patch));
    },
    getStorage: async () => { if (snapshotGate) await snapshotGate.promise; return structuredClone(storage); },
    sendMessage: message => {
      const reply = defer(); requests.push({ message: structuredClone(message), reply }); return reply.promise;
    },
    normalizeUrl: value => value,
    setModelOptions: (models, { keepValue, selectFirst }) => {
      els.aiModel.value = models.includes(keepValue) ? keepValue : selectFirst ? models[0] || "" : "";
    },
    setFieldMessage() {}, renderPrompt: async () => {}, scheduleSave() {}, clearResolveTimer() {},
    clearCapacity() { state.localAiCapability = null; }, renderCapacity() {},
    persistCapacity: async () => {}, toggleUi() {}, traceLocalConnection() {},
  });
  globalThis.chrome = { storage: { onChanged: { addListener() {} } } };
  globalThis.window = { addEventListener() {} };
  bindPopupEvents({ els, state, profileController: profile, localConnectionController: controller,
    providerMetaController: { refresh: () => controller.connect() }, toggleUi() {} });
  const passed = (index, selectedModel = model) => requests[index].reply.resolve({ ok: true,
    models: [selectedModel], capability: { models: { [selectedModel]: {
      generation: { supported: true, source: "fixture-metadata" },
      reasoning: { supported: true, control: "boolean" },
    } } },
    selectedModelVerification: { model: selectedModel, status: "passed", metadataOnly: true,
      evidence: "fixture-metadata" } });
  return { els, state, storage, requests, writes, controller, passed };
}
async function until(check) {
  for (let i = 0; i < 100 && !check(); i++) await Promise.resolve();
  assert.ok(check(), "expected asynchronous milestone");
}

// Duplicate refreshes share the actual controller's active metadata request.
{
  const f = fixture(); const first = f.controller.connect();
  await until(() => f.requests.length === 1);
  await f.controller.connect(); assert.equal(f.requests.length, 1);
  f.passed(0); await first;
  assert.equal(f.state.aiModelBlocked, false); assert.equal(f.els.aiLocalTest.disabled, false);
  assert.equal(f.storage[key][identity].verifiedThinking, "off");
  assert.equal(f.storage[key][identity].metadataOnly, true);

  const refresh = f.controller.connect();
  assert.equal(f.state.aiModelBlocked, true, "refresh suspends the previous UI proof");
  await until(() => f.requests.length === 2);
  f.requests[1].reply.reject(new Error("runtime offline")); await refresh;
  assert.equal(f.state.aiModelBlocked, true, "failed refresh cannot retain the previous passed state");
  assert.equal(f.storage[key][identity], undefined);
}

// Reasoning is a generation preference, not a model-availability identity.
// Changing it during a Local metadata request must neither cancel nor restart
// discovery, and the resulting snapshot is fresh for both old/new preferences.
{
  const saveGate = defer(), f = fixture({ saveGate });
  const pending = f.controller.connect(); await until(() => f.requests.length === 1);
  f.els.aiThinking.value = "on";
  const changed = f.els.aiThinking.handlers.change();
  assert.ok(f.state.localConnectInFlight, "thinking changes must not cancel metadata discovery");
  saveGate.resolve(); await changed;
  assert.equal(f.requests.length, 1, "thinking changes must not trigger another Local discovery");
  f.passed(0); await pending;
  const accepted = structuredClone(f.storage[key][identity]);
  assert.equal(f.state.aiModelBlocked, false);
  assert.equal(localVerificationSnapshotStatus(accepted, { provider: "ollama", endpoint, model, thinking: "on" }).fresh, true);
  assert.equal(localVerificationSnapshotStatus(accepted, { provider: "ollama", endpoint, model, thinking: "off" }).fresh, true);
}

// Identity edits still invalidate a response. A plain reasoning edit does not.
{
  const f = fixture(); const pending = f.controller.connect();
  await until(() => f.requests.length === 1);
  f.els.aiThinking.value = "on";
  f.passed(0); await pending;
  assert.ok(f.storage[key][identity], "thinking is not part of Local availability identity");
  assert.equal(f.state.aiModelBlocked, false);
}
for (const edit of ["model", "endpoint", "provider", "transition"]) {
  const f = fixture(); const pending = f.controller.connect();
  await until(() => f.requests.length === 1);
  if (edit === "model") f.els.aiModel.value = "another-model";
  if (edit === "endpoint") f.els.aiBaseUrl.value = "http://localhost:9999";
  if (edit === "provider") f.els.aiProvider.value = "lmstudio";
  if (edit === "transition") f.state.providerTransitionRevision++;
  f.passed(0); await pending;
  assert.equal(f.storage[key], undefined, edit);
  assert.equal(f.state.aiModelBlocked, true, edit);
  assert.equal(f.els.aiLocalTest.disabled, false, edit);
}

// A reasoning change before the first await also does not suppress Local
// discovery; model/provider/endpoint identity is the only availability key.
{
  const persistGate = defer(), f = fixture({ persistGate });
  const pending = f.controller.connect();
  f.els.aiThinking.value = "on"; persistGate.resolve();
  await until(() => f.requests.length === 1);
  f.passed(0); await pending;
  assert.ok(f.storage[key][identity]);
}

// A true model identity change during the snapshot write must still stop stale
// persistence even though reasoning changes no longer do.
{
  const snapshotGate = defer(), f = fixture({ snapshotGate });
  const pending = f.controller.connect(); await until(() => f.requests.length === 1);
  f.passed(0); await until(() => f.state.aiModelBlocked === false);
  f.els.aiModel.value = "another-model";
  f.controller.markModelChanged();
  snapshotGate.resolve(); await pending;
  assert.equal(f.storage[key], undefined); assert.equal(f.state.aiModelBlocked, true);
}
console.log("Local AI Connect races passed: metadata identity excludes Thinking while provider/model/endpoint races stay guarded.");
