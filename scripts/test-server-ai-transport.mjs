import assert from "node:assert/strict";

const savedChrome = globalThis.chrome;
const savedFetch = globalThis.fetch;
const stored = {};
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: "2026.test" }) },
  storage: { local: {
    get(keys, callback) { callback(Array.isArray(keys) ? Object.fromEntries(keys.map((key) => [key, stored[key]])) : { ...keys, ...stored }); },
    set(value, callback) { Object.assign(stored, value); callback?.(); },
  } },
};

const { translateViaServer } = await import("../src/background/ai/transports/server.js");

try {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      schema: "tp.ai.result/1", translations: [{ id: "P0", text: "แปลแล้ว" }], missing: [],
      meta: { resolvedProvider: "openrouter", resolvedModel: "model-a", generationAttempts: 1,
        providerAttempts: 1, usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await translateViaServer([{ id: "P0", text: "source" }], {
    base: "https://api.test/", targetLang: "th", sourceLang: "en", operationId: "operation-1",
    batchId: "batch-1", imageId: "image-1", jobId: "job-1", unlimited: true, traceId: "trace-1",
    imageDataUri: "data:image/png;base64,AQ==",
    ai: { provider: "openrouter", model: "model-a", base_url: "https://openrouter.ai/api/v1",
      api_key: "test-key", thinking: "off", prompt: "style", promptMode: "replace", char_memory: true,
      model_capabilities: { reasoning: { supported: true, mandatory: false,
        supports_max_tokens: true, supported_efforts: ["low", "HIGH", "bad effort"], ignored: "x" } },
      glossary: [{ from: "a", to: "b" }], characters: [{ name: "A" }],
      series_state: "state", prev_context: ["prior"] },
  });

  assert.equal(result.meta.route, "server");
  assert.equal(captured.body.schema, "tp.ai.request/1");
  assert.deepEqual(captured.body.repair, { owner: "extension", enabled: false });
  assert.equal(captured.init.headers["Idempotency-Key"], "operation-1");
  assert.equal(captured.init.headers["X-TP-Job-Id"], "job-1");
  assert.equal(captured.init.headers["X-TP-Image-Id"], "image-1");
  assert.equal(captured.init.headers["X-TP-Batch-Id"], "batch-1");
  assert.equal(captured.init.headers["X-TP-Client-Version"], "2026.test");
  assert.equal(captured.init.headers["X-TP-Local-Unlimited"], "1");
  assert.equal(captured.body.provider.apiKey, "test-key");
  assert.deepEqual(captured.body.provider.modelCapabilities, { reasoning: {
    supported: true, mandatory: false, supports_max_tokens: true,
    supported_efforts: ["high", "low"],
  } });
  assert.equal(captured.body.prompt_mode, "replace");
  assert.equal(captured.body.memory.enabled, true);
  assert.equal(captured.body.image.dataUri, "data:image/png;base64,AQ==");

  let emptyPromptDispatches = 0;
  globalThis.fetch = async () => { emptyPromptDispatches += 1; throw new Error("must not dispatch"); };
  await assert.rejects(translateViaServer([{ id: "P0", text: "source" }], {
    base: "https://api.test", targetLang: "th",
    ai: { provider: "openrouter", model: "model-a", prompt: "" },
  }), (error) => error?.code === "AI_PROMPT_REQUIRED" && error?.requestDispatched === false);
  assert.equal(emptyPromptDispatches, 0, "empty prompt must fail before HTTP dispatch");

  globalThis.fetch = async () => new Response(JSON.stringify({
    schema: "unexpected", translations: null,
    meta: { resolvedProvider: "openrouter", resolvedModel: "model-a", generationAttempts: 1 },
  }), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(translateViaServer([{ id: "P0", text: "source" }], {
    base: "https://api.test", targetLang: "th", sourceLang: "en",
    ai: { provider: "openrouter", model: "model-a", prompt: "style" },
  }), (error) => error?.code === "invalid_result_schema" && error?.status === 200 && error?.generationAttempts === 1);

  console.log("Server AI transport contract passed: request ownership, correlation, identity, usage and typed schema failure.");
} finally {
  globalThis.fetch = savedFetch;
  globalThis.chrome = savedChrome;
}
