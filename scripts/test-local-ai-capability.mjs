import assert from "node:assert/strict";
import { buildLocalAiCapabilityHints, discoverLocalModels } from "../src/shared/ai/direct-local/generation.js";
import { createOllamaAdapter, ollamaReasoningCapability } from "../src/shared/ai/providers/local-ollama.js";

const GiB = 1024 ** 3;
const hints = buildLocalAiCapabilityHints({
  protocol: "ollama",
  modelsData: { models: [
    { name: "small:latest", size: 6 * GiB, details: { family: "qwen", parameter_size: "7B" } },
    { name: "large:latest", size: 18 * GiB }, { name: "idle:latest", size: 4 * GiB },
  ] },
  runningData: { models: [
    { name: "small:latest", size: 6 * GiB, size_vram: Math.floor(5.8 * GiB), context_length: 8192 },
    { name: "large:latest", size: 18 * GiB, size_vram: 9 * GiB, context_length: 4096 },
  ] },
});
assert.equal(hints.recommendedMax, 1);
assert.equal(hints.models["small:latest"].recommendedMax, 2);
assert.equal(hints.models["large:latest"].recommendedMax, 1);
assert.equal(hints.models["idle:latest"].recommendedMax, 1);
assert.equal(hints.models["small:latest"].details.parameterSize, "7B");
const unknown = buildLocalAiCapabilityHints({ protocol: "openai" });
assert.equal(unknown.known, false);
assert.equal(unknown.recommendedMax, null);
assert.deepEqual(unknown.models, {});

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const payload = String(url).endsWith("/api/ps")
    ? { models: [{ name: "qwen:7b", size: 6 * GiB, size_vram: 6 * GiB, context_length: 4096 }] }
    : { models: [{ name: "qwen:7b", size: 6 * GiB }] };
  return new Response(JSON.stringify(payload), { status: 200 });
};
try {
  const discovered = await discoverLocalModels({ protocol: "ollama", baseUrl: "http://localhost:11434" });
  assert.deepEqual(discovered.models, ["qwen:7b"]);
  assert.equal(discovered.capability.models["qwen:7b"].recommendedMax, 2);
  assert.deepEqual(calls.map((call) => call.url).sort(), ["http://localhost:11434/api/ps", "http://localhost:11434/api/show", "http://localhost:11434/api/tags"]);
  for (const call of calls) {
    const show = call.url.endsWith("/api/show");
    assert.equal(call.init.method, show ? "POST" : "GET");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal("body" in call.init, show);
    if (show) assert.deepEqual(JSON.parse(call.init.body), { model: "qwen:7b" });
  }
  globalThis.fetch = async (url) => String(url).endsWith("/api/ps")
    ? new Response("unsupported", { status: 404 })
    : new Response(JSON.stringify({ models: [{ name: "still-listed", size: 2 * GiB }] }), { status: 200 });
  const compatible = await discoverLocalModels({ protocol: "ollama", baseUrl: "http://localhost:11434" });
  assert.deepEqual(compatible.models, ["still-listed"]);
  assert.equal(compatible.capability.models["still-listed"].loaded, false);
} finally { globalThis.fetch = originalFetch; }
console.log("local AI capability metadata tests passed");

assert.equal(ollamaReasoningCapability().supported, null);
assert.equal(ollamaReasoningCapability({ capabilities: "thinking" }).supported, null);
assert.equal(ollamaReasoningCapability({ capabilities: ["completion"] }).supported, false);
assert.equal(ollamaReasoningCapability({ capabilities: ["completion", "thinking"] }).control, "boolean");
const levelCapability = ollamaReasoningCapability({ capabilities: ["thinking"], model_info: { "general.architecture": "gptoss" } });
assert.equal(levelCapability.control, "levels");
assert.equal(levelCapability.mandatory, true);
assert.deepEqual(levelCapability.levels, ["low", "medium", "high"]);

const native = createOllamaAdapter({ baseUrl: "http://localhost:11435" });
let showPayload = { capabilities: ["thinking"], model_info: { "general.architecture": "gptoss" } };
const metadataCalls = [];
globalThis.fetch = async (url, init) => {
  metadataCalls.push({ url: String(url), init });
  return new Response(JSON.stringify(String(url).endsWith("/api/show") ? showPayload
    : { models: [{ name: "first" }, { name: "selected" }, { name: "qwen-name-does-not-prove-support" }] }));
};
try {
  const result = await native.listModels({ model: "selected" });
  const shown = metadataCalls.filter((call) => call.url.endsWith("/api/show"));
  assert.equal(shown.length, 1, "query only the selected model, regardless of installed model count");
  assert.deepEqual(JSON.parse(shown[0].init.body), { model: "selected" });
  assert.equal(result.capability.models.selected.reasoning.control, "levels");
  assert.equal(result.capability.models["qwen-name-does-not-prove-support"].reasoning.supported, null);
  assert.equal(native.payload({ model: "selected", thinkingMode: "off" }).think, undefined);
  assert.equal(native.thinkingApplied("off", { model: "selected" }), "provider_default_levels");
  const otherEndpoint = createOllamaAdapter({ baseUrl: "http://localhost:11436" });
  assert.equal(otherEndpoint.thinkingApplied("off", { model: "selected" }), "requested_off_unverified");
  assert.equal(native.thinkingApplied("off", { model: "first" }), "requested_off_unverified");

  showPayload = { capabilities: ["thinking"] };
  await native.listModels({ model: "selected" });
  assert.equal(native.payload({ model: "selected", thinkingMode: "off" }).think, false);
  assert.equal(native.thinkingApplied("off", { model: "selected" }), "requested_off");
  showPayload = { capabilities: ["completion"] };
  await native.listModels({ model: "selected" });
  assert.equal(native.payload({ model: "selected", thinkingMode: "on" }).think, undefined);
  assert.equal(native.thinkingApplied("on", { model: "selected" }), "unsupported");

  globalThis.fetch = async (url) => String(url).endsWith("/api/show")
    ? new Response("not supported", { status: 404 })
    : new Response(JSON.stringify({ models: [{ name: "selected" }] }));
  const unavailable = await native.listModels({ model: "selected" });
  assert.equal(unavailable.capability.models.selected.reasoning.supported, null);
  assert.equal(native.thinkingApplied("on", { model: "selected" }), "requested_on_unverified", "rediscovery invalidates stale support");
  assert.ok(metadataCalls.every((call) => !/\/(?:chat|generate)$/.test(call.url)), "metadata discovery must never generate or cold-load a model");
} finally { globalThis.fetch = originalFetch; }
console.log("Ollama selected-model thinking discovery passed: unknown, unsupported, boolean and levels-only metadata; endpoint/model isolation.");
