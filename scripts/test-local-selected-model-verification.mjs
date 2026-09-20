import assert from "node:assert/strict";
import { discoverLocalModels } from "../src/shared/ai/direct-local/model-discovery.js";
import { createOllamaAdapter } from "../src/shared/ai/providers/local-ollama.js";
import { createOpenAiCompatibleAdapter } from "../src/shared/ai/providers/local-openai-compatible.js";

const originalFetch = globalThis.fetch;
try {
  // Generic OpenAI-compatible discovery is model-list/metadata only. It must
  // never load a model by issuing a throw-away generation during Connect.
  let posts = 0;
  globalThis.fetch = async (_url, init = {}) => {
    if (String(init.method || "GET").toUpperCase() === "GET") {
      return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    posts += 1;
    throw new Error("discovery must not generate");
  };
  const verified = await discoverLocalModels({
    protocol: "openai", baseUrl: "http://127.0.0.1:1234/v1",
  }, { model: "model-a", verifySelected: true, probeTimeoutMs: 1000 });
  assert.deepEqual(verified.models, ["model-a", "model-b"]);
  assert.equal(verified.selectedModelVerification.status, "passed");
  assert.equal(verified.selectedModelVerification.model, "model-a");
  assert.equal(verified.selectedModelVerification.metadataOnly, true);
  assert.equal(posts, 0, "Connect/model discovery must not issue a generation request");

  const missing = await discoverLocalModels({
    protocol: "openai", baseUrl: "http://127.0.0.1:1234/v1",
  }, { model: "missing-model", verifySelected: true, probeTimeoutMs: 1000 });
  assert.equal(missing.selectedModelVerification.status, "model_unavailable");
  assert.equal(posts, 0, "a model absent from the runtime list must not be generated");

  // Ollama exposes per-model capabilities through /api/show. Use those
  // metadata to hide models that provably cannot produce completions, while
  // never calling /api/chat during discovery.
  const ollamaCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    const endpoint = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    ollamaCalls.push({ endpoint, body });
    if (endpoint.endsWith("/api/tags"))
      return new Response(JSON.stringify({ models: [
        { name: "qwen3:8b", size: 4_000_000_000 },
        { name: "nomic-embed-text:latest", size: 300_000_000 },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    if (endpoint.endsWith("/api/ps"))
      return new Response(JSON.stringify({ models: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    if (endpoint.endsWith("/api/show")) {
      if (body?.model === "qwen3:8b") {
        return new Response(JSON.stringify({
          capabilities: ["completion", "thinking"],
          model_info: { "general.architecture": "qwen3", "qwen3.context_length": 32768 },
          details: { family: "qwen3" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body?.model === "nomic-embed-text:latest") {
        return new Response(JSON.stringify({
          capabilities: ["embedding"],
          model_info: { "general.architecture": "nomic-bert" },
          details: { family: "nomic-bert" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    if (endpoint.endsWith("/api/chat"))
      throw new Error("Ollama discovery must not call /api/chat");
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const coldOllama = await discoverLocalModels({
    provider: "ollama", protocol: "ollama", baseUrl: "http://localhost:11434",
  }, { provider: "ollama", model: "qwen3:8b", verifySelected: true, probeTimeoutMs: 1000 });
  assert.deepEqual(coldOllama.models, ["qwen3:8b"],
    "embedding-only Ollama models must be filtered by authoritative metadata");
  assert.equal(coldOllama.selectedModelVerification.status, "passed");
  assert.equal(coldOllama.selectedModelVerification.metadataOnly, true);
  assert.equal(ollamaCalls.filter((call) => call.endpoint.endsWith("/api/chat")).length, 0);


} finally {
  globalThis.fetch = originalFetch;
}
console.log("Local model discovery passed: metadata-only connect and capability filtering; no throw-away generation path remains.");
