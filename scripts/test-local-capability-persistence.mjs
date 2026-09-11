import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LOCAL_CAPABILITY_SNAPSHOTS_KEY,
  createLocalConnectionController,
  normalizeLocalConnectionIdentity,
  savedLocalCapabilitySnapshot,
} from "../src/popup/controllers/local-connection-controller.js";
import { createLocalCapacityController } from "../src/popup/controllers/local-capacity-controller.js";

const endpoint = "http://localhost:11434";
const identity = normalizeLocalConnectionIdentity(" Ollama ", `${endpoint}/`);
assert.equal(identity, `ollama|${endpoint}`);

const capability = {
  protocol: "ollama",
  models: {
    "qwen3.5:9b": { reasoning: { supported: true, control: "boolean" } },
  },
};
const records = {
  [identity]: {
    identity,
    provider: "ollama",
    endpoint,
    models: ["qwen3.5:9b"],
    capability,
    verifiedModel: "qwen3.5:9b",
    verificationStatus: "passed",
    checkedAt: 1234,
  },
};
assert.equal(
  savedLocalCapabilitySnapshot(records, "ollama", `${endpoint}/`)?.capability,
  capability,
  "the exact provider/endpoint identity restores model thinking metadata",
);

const modelOptions = [];
const els = {
  aiProvider: { value: "ollama" }, aiBaseUrl: { value: endpoint },
  aiModel: { value: "qwen3.5:9b" }, aiLocalModelId: { value: "" },
  aiLocalStatus: { textContent: "" }, aiLocalTest: null,
};
const state = { desiredAiModel: "qwen3.5:9b", localAiCapability: null, lastAiResolve: null, aiModelBlocked: true };
const controller = createLocalConnectionController({
  els, state, profile: {}, persist: async () => {}, getStorage: async () => ({}),
  sendMessage: async () => ({}), normalizeUrl: String,
  setModelOptions: (models) => modelOptions.push(...models),
  setFieldMessage: () => {}, renderPrompt: async () => {}, scheduleSave: () => {},
  clearResolveTimer: () => {}, clearCapacity: () => {}, renderCapacity: () => {},
  persistCapacity: async () => {}, toggleUi: () => {},
});
assert.equal(controller.restoreSnapshot(records), true);
assert.equal(state.localAiCapability.models["qwen3.5:9b"].reasoning.supported, true);
assert.deepEqual(modelOptions, ["qwen3.5:9b"]);
assert.equal(state.lastAiResolve.verification_source, "saved_snapshot");
assert.match(els.aiLocalStatus.textContent, /was verified/);
assert.equal(state.aiModelBlocked, false);

let persistedHint = null;
const capacityState = { localAiCapability: { models: {
  "qwen3.5:9b": { recommendedMax: 1,
    reasoning: { supported: true, control: "boolean", source: "ollama-api-show" },
    structuredOutput: { supported: true, contract: "tp.translation.schema-object/1" },
    limits: { contextTokens: 8192, source: "ollama-api-ps" } },
  "other-model": { recommendedMax: 2, reasoning: { supported: false } },
}}};
const capacity = createLocalCapacityController({
  els: { aiProvider: { value: "ollama" }, aiBaseUrl: { value: endpoint },
    aiModel: { value: "qwen3.5:9b" } },
  state: capacityState, isLocalProvider: (value) => value === "ollama",
  persist: async (patch) => { persistedHint = structuredClone(patch.aiLocalCapabilityHint); },
});
await capacity.persistSelected();
assert.deepEqual(persistedHint.modelCapabilities.reasoning,
  { supported: true, control: "boolean", source: "ollama-api-show" });
assert.equal(JSON.stringify(persistedHint).includes("other-model"), false,
  "persisted hint leaked another model's capability");
const restartedSettings = { aiLocalCapabilityHint: persistedHint };
assert.equal(restartedSettings.aiLocalCapabilityHint.provider, "ollama");
assert.equal(restartedSettings.aiLocalCapabilityHint.baseUrl, endpoint);
assert.equal(restartedSettings.aiLocalCapabilityHint.model, "qwen3.5:9b");
assert.equal(restartedSettings.aiLocalCapabilityHint.modelCapabilities.reasoning.control, "boolean",
  "verified boolean capability did not survive restart persistence");
assert.equal(
  savedLocalCapabilitySnapshot(records, "ollama", "http://localhost:1234"),
  null,
  "an endpoint change cannot reuse stale metadata",
);
assert.equal(
  savedLocalCapabilitySnapshot(records, "lmstudio", endpoint),
  null,
  "a provider change cannot reuse stale metadata",
);

const hydration = await readFile(
  new URL("../src/popup/controllers/settings-hydration-controller.js", import.meta.url),
  "utf8",
);
const connection = await readFile(
  new URL("../src/popup/controllers/local-connection-controller.js", import.meta.url),
  "utf8",
);
assert.match(hydration, new RegExp(LOCAL_CAPABILITY_SNAPSHOTS_KEY));
assert.match(hydration, /restoreSnapshot\(stored\.aiLocalCapabilitySnapshotsV1\)/);
assert.match(connection, /verification_source:\s*"saved_snapshot"/,
  "a restored snapshot must not masquerade as a live health result");
assert.match(connection, /Reconnect to verify/);
assert.match(connection, /verifiedModel/);
assert.match(connection, /forgetSnapshot\(provider,[\s\S]*?\.catch\(\(\) => \{\}\)/,
  "an evidenced discovery failure invalidates that identity's saved snapshot");

console.log("Local capability persistence passed: exact saved identity survives popup reopen without claiming live connectivity.");
