import assert from "node:assert/strict";
import {
  discoverLocalModels,
  verifyLocalModelGeneration,
} from "../src/shared/ai/direct-local/model-discovery.js";

const originalFetch = globalThis.fetch;
try {
  let posts = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(init.method || "GET").toUpperCase() === "GET") {
      return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    posts += 1;
    const body = JSON.parse(String(init.body || "{}"));
    assert.equal(body.model, "model-a");
    assert.equal(body.max_tokens, 64);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const verified = await discoverLocalModels({
    protocol: "openai", baseUrl: "http://127.0.0.1:1234/v1",
  }, { model: "model-a", verifySelected: true, probeTimeoutMs: 1000 });
  assert.deepEqual(verified.models, ["model-a", "model-b"]);
  assert.equal(verified.selectedModelVerification.status, "passed");
  assert.equal(verified.selectedModelVerification.model, "model-a");
  assert.equal(posts, 1, "selected model should receive exactly one tiny generation probe");

  posts = 0;
  const missing = await discoverLocalModels({
    protocol: "openai", baseUrl: "http://127.0.0.1:1234/v1",
  }, { model: "missing-model", verifySelected: true, probeTimeoutMs: 1000 });
  assert.equal(missing.selectedModelVerification.status, "model_unavailable");
  assert.equal(posts, 0, "a model absent from the runtime list must not be generated");

  globalThis.fetch = async (url, init = {}) => {
    if (String(init.method || "GET").toUpperCase() === "GET")
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    posts += 1;
    return new Response(JSON.stringify({ error: { message: "model cannot generate chat" } }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  };
  posts = 0;
  const rejected = await discoverLocalModels({
    protocol: "openai", baseUrl: "http://127.0.0.1:1234/v1",
  }, { model: "model-a", verifySelected: true, probeTimeoutMs: 1000 });
  assert.equal(rejected.selectedModelVerification.status, "rejected");
  assert.equal(posts, 1);

  const ollamaCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    const endpoint = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    ollamaCalls.push({ endpoint, body });
    if (endpoint.endsWith("/api/tags"))
      return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    if (endpoint.endsWith("/api/ps"))
      return new Response(JSON.stringify({ models: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    if (endpoint.endsWith("/api/show"))
      return new Response("not supported", { status: 404 });
    if (endpoint.endsWith("/api/chat")) {
      assert.equal(Object.hasOwn(body, "think"), false,
        "an unverified Ollama model must not receive an unsupported think field");
      return new Response(JSON.stringify({
        message: { content: "OK" }, done: true, done_reason: "stop",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const coldOllama = await discoverLocalModels({
    provider: "ollama", protocol: "ollama", baseUrl: "http://localhost:11434",
  }, { provider: "ollama", model: "qwen3:8b", verifySelected: true, probeTimeoutMs: 1000 });
  assert.equal(coldOllama.selectedModelVerification.status, "passed");
  assert.equal(ollamaCalls.filter((call) => call.endpoint.endsWith("/api/chat")).length, 1);

  const mandatory = await verifyLocalModelGeneration({
    resolveThinkingMode() {
      throw Object.assign(new Error("thinking required"), {
        code: "local_ai_thinking_required",
      });
    },
  }, "mandatory-model", { timeoutMs: 1000 });
  assert.equal(mandatory.status, "thinking_required");
  assert.equal(mandatory.code, "local_ai_thinking_required");
} finally {
  globalThis.fetch = originalFetch;
}
console.log("Local selected-model verification passed: listed candidate + exact tiny generation required before use.");
