import assert from "node:assert/strict";
import {
  classifyLocalEndpointForTrace,
  createLocalConnectionController,
} from "../src/popup/controllers/local-connection-controller.js";

assert.equal(classifyLocalEndpointForTrace(""), "empty");
assert.equal(classifyLocalEndpointForTrace("http://localhost:11434"), "loopback");
assert.equal(classifyLocalEndpointForTrace("http://192.168.1.8:1234/v1"), "private");
assert.equal(classifyLocalEndpointForTrace("https://example.invalid/v1"), "public");
assert.equal(classifyLocalEndpointForTrace("not a URL"), "invalid");

const element = (value = "") => ({
  value, textContent: "", disabled: false,
  handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; },
});
const events = [];
const els = {
  aiProvider: element("ollama"), aiBaseUrl: element("https://example.invalid/secret/path"),
  aiLocalStatus: element(), aiLocalTest: element(), aiModel: element("model-secret"),
apiUrl: element("http://localhost:7860"), aiModelWrap: {},
};
const state = {
  localConnectSeq: 0, localConnectInFlight: null, providerTransitionRevision: 7,
  desiredAiModel: "model-secret", aiMetaSeq: 0,
};
const controller = createLocalConnectionController({
  els, state, profile: {}, persist: async () => {}, getStorage: async () => ({}),
  sendMessage: async () => { throw new Error("must not dispatch"); },
  normalizeUrl: (v) => v, setModelOptions() {}, setFieldMessage() {},
  renderPrompt: async () => {}, scheduleSave() {}, clearResolveTimer() {},
  clearCapacity() {}, renderCapacity() {}, persistCapacity: async () => {}, toggleUi() {},
  traceLocalConnection: (event) => events.push(structuredClone(event)),
});
controller.bind();
await els.aiLocalTest.handlers.click();

assert.deepEqual(events.map((event) => [event.status, event.stage]), [
  ["started", "normalize"], ["failed", "normalize"],
]);
assert.equal(events[1].endpointClass, "public");
assert.equal(events[1].endpointSource, "provider_field");
assert.equal(events[1].transitionRevision, 7);
assert.equal(events[1].errorCode, "INVALID_LOCAL_ADAPTER");
assert.equal(events[1].errorName, "Error");
const serialized = JSON.stringify(events);
assert.doesNotMatch(serialized, /secret\/path|model-secret|example\.invalid/);

const successEvents = [];
const successEls = {
  aiProvider: element("ollama"), aiBaseUrl: element("http://localhost:11434"),
  aiLocalStatus: element(), aiLocalTest: element(), aiModel: element("qwen"),
apiUrl: element("http://localhost:7860"), aiModelWrap: {},
};
const successState = {
  localConnectSeq: 0, localConnectInFlight: null, providerTransitionRevision: 8,
  desiredAiModel: "qwen", aiMetaSeq: 0, aiModelBlocked: true,
};
const successController = createLocalConnectionController({
  els: successEls, state: successState, profile: { selectModel() {} },
  persist: async () => {}, getStorage: async () => ({}),
  sendMessage: async () => ({
    ok: true, models: ["qwen"], capability: {},
    selectedModelVerification: { model: "qwen", status: "passed" },
  }),
  normalizeUrl: (v) => v,
  setModelOptions(models, { keepValue } = {}) { successEls.aiModel.value = keepValue || models[0] || ""; },
  setFieldMessage() {}, renderPrompt: async () => {}, scheduleSave() {},
  clearResolveTimer() {}, clearCapacity() {}, renderCapacity() {},
  persistCapacity: async () => {}, toggleUi() {},
  traceLocalConnection: (event) => successEvents.push(structuredClone(event)),
});
successController.bind();
await successEls.aiLocalTest.handlers.click();
assert.deepEqual(successEvents.map((event) => [event.status, event.stage]), [
  ["started", "normalize"], ["completed", "normalize"],
  ["started", "persist"], ["completed", "persist"],
  ["started", "message"], ["completed", "discovery"],
  ["completed", "model_verify"],
]);
assert.equal(successEvents.every((event) => event.endpointClass === "loopback"), true);
assert.doesNotMatch(JSON.stringify(successEvents), /qwen|localhost|11434/);

const unsupportedMessages = [];
const unsupportedEls = {
  aiProvider: element("ollama"), aiBaseUrl: element("http://localhost:11434"),
  aiLocalStatus: element(), aiLocalTest: element(), aiModel: element("nomic-embed-text"),
apiUrl: element("http://localhost:7860"), aiModelWrap: {},
};
const unsupportedState = {
  localConnectSeq: 0, localConnectInFlight: null, providerTransitionRevision: 10,
  desiredAiModel: "nomic-embed-text", aiMetaSeq: 0, aiModelBlocked: true,
};
const unsupportedController = createLocalConnectionController({
  els: unsupportedEls, state: unsupportedState, profile: { selectModel() {} },
  persist: async () => {}, getStorage: async () => ({}),
  sendMessage: async () => ({
    ok: true, models: ["qwen"], capability: {},
    selectedModelVerification: {
      model: "nomic-embed-text", status: "unsupported_model",
      evidence: "ollama-api-show",
    },
  }),
  normalizeUrl: (v) => v,
  setModelOptions(models, { keepValue, selectFirst = true } = {}) {
    const list = [...models];
    unsupportedEls.aiModel.value = list.includes(keepValue) ? keepValue : selectFirst ? list[0] || "" : "";
  },
  setFieldMessage(_wrap, type, message) { unsupportedMessages.push({ type, message }); },
  renderPrompt: async () => {}, scheduleSave() {}, clearResolveTimer() {},
  clearCapacity() {}, renderCapacity() {}, persistCapacity: async () => {}, toggleUi() {},
  traceLocalConnection() {},
});
unsupportedController.bind();
await unsupportedEls.aiLocalTest.handlers.click();
assert.equal(unsupportedState.aiModelBlocked, true);
assert.equal(unsupportedEls.aiModel.value, "", "an explicit unusable Local model must be cleared, not silently replaced");
assert.equal(unsupportedMessages.at(-1).type, "error");
assert.match(unsupportedMessages.at(-1).message, /cannot generate chat completions/i);
assert.doesNotMatch(unsupportedEls.aiLocalStatus.textContent, /CORS|runtime is running/i);

let releaseDiscovery;
const staleEvents = [];
const staleEls = {
  aiProvider: element("ollama"), aiBaseUrl: element("http://localhost:11434"),
  aiLocalStatus: element(), aiLocalTest: element(), aiModel: element("qwen"),
apiUrl: element("http://localhost:7860"), aiModelWrap: {},
};
const staleState = {
  localConnectSeq: 0, localConnectInFlight: null, providerTransitionRevision: 9,
  desiredAiModel: "qwen", aiMetaSeq: 0,
};
const staleController = createLocalConnectionController({
  els: staleEls, state: staleState, profile: {}, persist: async () => {},
  getStorage: async () => ({}),
  sendMessage: () => new Promise((resolve) => { releaseDiscovery = resolve; }),
  normalizeUrl: (v) => v, setModelOptions() {}, setFieldMessage() {},
  renderPrompt: async () => {}, scheduleSave() {}, clearResolveTimer() {},
  clearCapacity() {}, renderCapacity() {}, persistCapacity: async () => {}, toggleUi() {},
  traceLocalConnection: (event) => staleEvents.push(structuredClone(event)),
});
staleController.bind();
const pending = staleEls.aiLocalTest.handlers.click();
await Promise.resolve();
staleController.invalidate("provider changed");
releaseDiscovery({ ok: true, models: ["qwen"], capability: {} });
await pending;
assert.equal(
  staleEvents.some((event) => event.stage === "discovery" && event.status === "completed"),
  false,
  "a stale discovery response must not be reported as completed",
);
assert.equal(staleState.localConnectInFlight, null);

console.log("PASS popup Local AI observability milestones are staged and sanitized");
