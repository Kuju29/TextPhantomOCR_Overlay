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
  assert.equal(captured.init.priority, "high", "AI transport must outrank Lens uploads on the same origin");
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
  assert.equal(captured.body.memory.styleExamples, true);
  assert.equal(captured.body.image.dataUri, "data:image/png;base64,AQ==");

  let emptyPromptDispatches = 0;
  let emptyPromptBody = null;
  globalThis.fetch = async (_url, init) => {
    emptyPromptDispatches += 1;
    emptyPromptBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      schema: "tp.ai.result/1", translations: [{ id: "P0", text: "ค่าเริ่มต้น" }], missing: [],
      meta: { resolvedProvider: "openrouter", resolvedModel: "model-a", generationAttempts: 1,
        providerAttempts: 1, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const emptyPromptResult = await translateViaServer([{ id: "P0", text: "source" }], {
    base: "https://api.test", targetLang: "th",
    ai: { provider: "openrouter", model: "model-a", prompt: "", promptMode: "fallback" },
  });
  assert.equal(emptyPromptResult.translations[0].text, "ค่าเริ่มต้น");
  assert.equal(emptyPromptDispatches, 1, "empty prompt must dispatch once using the built-in style");
  assert.equal(emptyPromptBody.prompt, "");
  assert.equal(emptyPromptBody.prompt_mode, "replace");

  globalThis.fetch = async () => new Response(JSON.stringify({
    schema: "unexpected", translations: null,
    meta: { resolvedProvider: "openrouter", resolvedModel: "model-a", generationAttempts: 1 },
  }), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(translateViaServer([{ id: "P0", text: "source" }], {
    base: "https://api.test", targetLang: "th", sourceLang: "en",
    ai: { provider: "openrouter", model: "model-a", prompt: "style" },
  }), (error) => error?.code === "invalid_result_schema" && error?.status === 200 && error?.generationAttempts === 1);

  const {currentUsage, recordProviderGeneration, flushUsageReceiptJournal} = await import("../src/shared/ai-usage.js");
  const target = {runtime:"cloud",provider:"openrouter",model:"model-a"};
  await flushUsageReceiptJournal({recover:true});
  const beforeFailure = currentUsage(stored.aiUsageV1, target);
  let failureCalls = 0;
  globalThis.fetch = async () => {
    failureCalls++;
    return new Response(JSON.stringify({detail: {code:"provider_timeout", upstreamStatus:504,
      providerFailureKind:"http_status", requestDispatched:true, generationAttempts:1,
      structuralDetails:{generationMeta:{usage:{receiptId:"gateway-failure-receipt",
        usageStatus:"unconfirmed_transport", accountingOrigin:"server_provider_boundary",
        receiptStatus:"interrupted_usage_pending", inputTokens:null,outputTokens:null,totalTokens:null}}}}}),
      {status:502,headers:{"content-type":"application/json"}});
  };
  await assert.rejects(translateViaServer([{id:"P0",text:"source"}], {
    base:"https://api.test",targetLang:"th",operationId:"gateway-failure",
    ai:{provider:"openrouter",model:"model-a"},
  }), error => error.code === "provider_timeout" && error.upstreamStatus === 504 &&
    error.providerFailureKind === "http_status" && error.requestDispatched === true);
  assert.equal(failureCalls, 1, "a confirmed HTTP failure never triggers transport retry");
  await flushUsageReceiptJournal({recover:true});
  assert.match(JSON.stringify(stored.aiUsageV1), /gateway-failure-receipt/,
    "original unknown usage receipt survives repair eligibility classification");

  const afterFailure = currentUsage(stored.aiUsageV1, target);
  assert.equal(afterFailure.requests, beforeFailure.requests + 1);
  assert.equal(afterFailure.totalTokens, beforeFailure.totalTokens, "unknown gateway usage must not invent tokens");
  assert.equal(afterFailure.incompleteRequests, beforeFailure.incompleteRequests + 1);
  const replay = recordProviderGeneration(stored.aiUsageV1, {...target,engine:"runsextension",
    operationId:"gateway-failure",replayed:true,requests:1,usage:{receiptId:"gateway-failure-receipt",
      usageStatus:"unconfirmed_transport",accountingOrigin:"server_provider_boundary"}});
  assert.equal(currentUsage(replay,target).requests, afterFailure.requests, "receipt recovery cannot double count the original call");

  console.log("Server AI transport contract passed: request ownership, correlation, identity, usage and typed schema failure.");
} finally {
  globalThis.fetch = savedFetch;
  globalThis.chrome = savedChrome;
}
