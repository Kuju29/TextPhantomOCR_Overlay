import assert from "node:assert/strict";
import { discoverLocalModels } from "../src/shared/ai/direct-local/model-discovery.js";

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
} finally {
  globalThis.fetch = originalFetch;
}
console.log("Local selected-model verification passed: listed candidate + exact tiny generation required before use.");
