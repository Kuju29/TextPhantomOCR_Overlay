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
  "Local provider selection must load and verify models automatically");

assert.match(localConnection, /clearResolveTimer\(\)/,
  "Connect must cancel a pending blur refresh");
assert.match(localConnection, /const sequence = \+\+state\.localConnectSeq/);
assert.match(localConnection, /if \(state\.localConnectInFlight\) return;/,
  "manual refresh and automatic refresh must share one in-flight request");
assert.doesNotMatch(localConnection, /sequence !== state\.aiMetaSeq/,
  "generic metadata refresh must not invalidate Connect");
assert.match(localConnection, /finally[\s\S]*setBusy\(false\)/,
  "the button must be restored on every terminal outcome");
assert.match(localConnection, /provider or URL changed/,
  "identity changes must have a visible terminal status");
assert.match(localConnection, /selectedModelVerification/,
  "Connect must consume selected-model generation verification");
assert.match(localConnection, /markModelChanged/,
  "changing a Local model must invalidate the previous verification");
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
    models: [selectedModel], capability: { models: { [selectedModel]: { reasoning: { supported: true, control: "boolean" } } } },
    selectedModelVerification: { model: selectedModel, status: "passed" } });
  return { els, state, storage, requests, writes, controller, passed };
}
async function until(check) {
  for (let i = 0; i < 100 && !check(); i++) await Promise.resolve();
  assert.ok(check(), "expected asynchronous milestone");
}

// Duplicate refreshes share the actual controller's active request.
{
  const f = fixture(); const first = f.controller.connect();
  await until(() => f.requests.length === 1);
  await f.controller.connect(); assert.equal(f.requests.length, 1);
  f.passed(0); await first;
  assert.equal(f.state.aiModelBlocked, false); assert.equal(f.els.aiLocalTest.disabled, false);
  assert.equal(f.storage[key][identity].verifiedThinking, "off");

  const refresh = f.controller.connect();
  assert.equal(f.state.aiModelBlocked, true, "refresh suspends the previous UI proof");
  await until(() => f.requests.length === 2);
  f.requests[1].reply.reject(new Error("runtime offline")); await refresh;
  assert.equal(f.state.aiModelBlocked, true, "failed refresh cannot retain the previous passed state");
  assert.equal(f.storage[key][identity], undefined);
}

// Thinking invalidates synchronously, before profile persistence can finish.
// Only the new probe can unblock the UI or write its readiness snapshot.
for (const staleOutcome of ["passed", "failed"]) {
  const saveGate = defer(), f = fixture({ saveGate });
  const old = f.controller.connect(); await until(() => f.requests.length === 1);
  f.els.aiThinking.value = "on";
  const changed = f.els.aiThinking.handlers.change();
  assert.equal(f.state.localConnectInFlight, null);
  assert.equal(f.state.aiModelBlocked, true);
  saveGate.resolve(); await until(() => f.requests.length === 2);
  assert.equal(f.requests[0].message.thinking, "off");
  assert.equal(f.requests[1].message.thinking, "on");
  f.passed(1); await changed;
  const accepted = structuredClone(f.storage[key][identity]);
  if (staleOutcome === "passed") f.passed(0);
  else f.requests[0].reply.reject(new Error("stale network failure"));
  await old;
  assert.deepEqual(f.storage[key][identity], accepted);
  assert.equal(f.state.aiModelBlocked, false);
  assert.equal(accepted.verifiedThinking, "on");
  assert.equal(localVerificationSnapshotStatus(accepted, { provider: "ollama", endpoint, model, thinking: "on" }).fresh, true);
  assert.equal(localVerificationSnapshotStatus(accepted, { provider: "ollama", endpoint, model, thinking: "off" }).fresh, false);
}

// Even edits without an event callback cannot relabel an old response.
for (const edit of ["thinking", "model", "endpoint", "provider", "transition"]) {
  const f = fixture(); const pending = f.controller.connect();
  await until(() => f.requests.length === 1);
  if (edit === "thinking") f.els.aiThinking.value = "on";
  if (edit === "model") f.els.aiModel.value = "another-model";
  if (edit === "endpoint") f.els.aiBaseUrl.value = "http://localhost:9999";
  if (edit === "provider") f.els.aiProvider.value = "lmstudio";
  if (edit === "transition") f.state.providerTransitionRevision++;
  f.passed(0); await pending;
  assert.equal(f.storage[key], undefined, edit);
  assert.equal(f.state.aiModelBlocked, true, edit);
  assert.equal(f.els.aiLocalTest.disabled, false, edit);
}

// Settings captured before the first await must never dispatch for a newer UI.
{
  const persistGate = defer(), f = fixture({ persistGate });
  const pending = f.controller.connect();
  f.els.aiThinking.value = "on"; persistGate.resolve(); await pending;
  assert.equal(f.requests.length, 0); assert.equal(f.storage[key], undefined);
}

// A change during the snapshot read must stop the stale write as well.
{
  const snapshotGate = defer(), f = fixture({ snapshotGate });
  const pending = f.controller.connect(); await until(() => f.requests.length === 1);
  f.passed(0); await until(() => f.state.aiModelBlocked === false);
  f.els.aiThinking.value = "on";
  f.controller.invalidate("AI thinking changed"); f.state.aiModelBlocked = true;
  snapshotGate.resolve(); await pending;
  assert.equal(f.storage[key], undefined); assert.equal(f.state.aiModelBlocked, true);
}
console.log("Local AI Connect races passed: real handlers reject stale execution identities and retry Thinking changes.");
