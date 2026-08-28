import assert from "node:assert/strict";
import { buildLocalAiCapabilityHints, discoverLocalModels } from "../src/shared/local-ai-adapter.js";

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
  assert.deepEqual(calls.map((call) => call.url).sort(), ["http://localhost:11434/api/ps", "http://localhost:11434/api/tags"]);
  for (const call of calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal("body" in call.init, false);
  }
  globalThis.fetch = async (url) => String(url).endsWith("/api/ps")
    ? new Response("unsupported", { status: 404 })
    : new Response(JSON.stringify({ models: [{ name: "still-listed", size: 2 * GiB }] }), { status: 200 });
  const compatible = await discoverLocalModels({ protocol: "ollama", baseUrl: "http://localhost:11434" });
  assert.deepEqual(compatible.models, ["still-listed"]);
  assert.equal(compatible.capability.models["still-listed"].loaded, false);
} finally { globalThis.fetch = originalFetch; }
console.log("local AI capability metadata tests passed");
