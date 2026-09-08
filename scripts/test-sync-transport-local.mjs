import assert from "node:assert/strict";

globalThis.chrome = {
  runtime: { getManifest: () => ({ version: "2026.test" }) },
  storage: { local: { get: (_keys, cb) => cb({}), set: (_value, cb) => cb?.() } },
};

const { syncTotalTimeoutMs, translateViaSyncRest } = await import("../src/background/transports/translate.js");
const { failureUsageDetails } = await import("../src/shared/ai-usage.js");

const delayedResponse = (delayMs, response, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(response), delayMs);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(new DOMException("aborted", "AbortError"));
  }, { once: true });
});

const localPayload = { mode: "lens_text", ai: { provider: "ollama", base_url: "http://127.0.0.1:11434" } };
const cloudPayload = { mode: "lens_text", ai: { provider: "gemini", base_url: "https://generativelanguage.googleapis.com" } };
assert.equal(syncTotalTimeoutMs(localPayload, 5), null, "Local AI must not receive a fixed total timeout");
assert.equal(syncTotalTimeoutMs(cloudPayload, 5), 5, "Cloud AI retains its bounded total timeout");

globalThis.fetch = async (_url, init) => delayedResponse(20, new Response(JSON.stringify({ ok: true }), {
  status: 200, headers: { "content-type": "application/json" },
}), init.signal);
assert.deepEqual(await translateViaSyncRest("https://api.example.test", localPayload, { cloudTimeoutMs: 5 }), { ok: true },
  "Local runsapi request must survive beyond the configured Cloud timer");

await assert.rejects(
  translateViaSyncRest("https://api.example.test", cloudPayload, { cloudTimeoutMs: 5 }),
  (error) => error.timeout === true && error.tpError?.code === "NET_TIMEOUT",
  "Cloud runsapi request must still abort at its configured timeout",
);

const secret = "SIGNED_TOKEN_MUST_NOT_SURVIVE";
globalThis.fetch = async () => new Response(JSON.stringify({ detail: {
  code: "invalid_model_output",
  stage: "ai",
  retryable: false,
  generationAttempts: 1,
  provider: "ollama",
  model: "qwen-test",
  runtime: "local",
  engine: "runsapi",
  finishReason: "length",
  providerMs: 1200,
  parseMs: 15,
  totalMs: 1300,
  timeoutPolicy: "unbounded-read",
  usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
  structuralDetails: {
    generationMeta: {
      provider: "ollama", model: "qwen-test", runtime: "local", engine: "runsapi",
      finishReason: "length", providerMs: 1200, parseMs: 15, totalMs: 1300,
      timeoutPolicy: "unbounded-read", generationAttempts: 1,
      usage: { input_tokens: 100, output_tokens: 25, total_tokens: 125 },
      rawResponse: `https://images.example/page.jpg?token=${secret}`,
    },
    src: `https://images.example/page.jpg?token=${secret}`,
  },
  signedUrl: `https://images.example/page.jpg?token=${secret}`,
} }), { status: 422, headers: { "content-type": "application/json" } });

let chargedError;
try {
  await translateViaSyncRest("https://api.example.test", localPayload, { cloudTimeoutMs: 5 });
  assert.fail("expected terminal provider failure");
} catch (error) {
  chargedError = error;
}
const charged = failureUsageDetails(chargedError);
assert.deepEqual({
  provider: charged.provider, model: charged.model,
  inputTokens: charged.inputTokens, outputTokens: charged.outputTokens, totalTokens: charged.totalTokens,
  finishReason: charged.finishReason, generationAttempts: charged.generationAttempts,
}, {
  provider: "ollama", model: "qwen-test",
  inputTokens: 100, outputTokens: 25, totalTokens: 125,
  finishReason: "length", generationAttempts: 1,
});
assert.equal(chargedError.runtime, "local");
assert.equal(chargedError.engine, "runsapi");
assert.equal(chargedError.parseMs, 15);
assert.equal(chargedError.timeoutPolicy, "unbounded-read");
assert.doesNotMatch(JSON.stringify({
  tpError: chargedError.tpError,
  generationMeta: chargedError.generationMeta,
  structuralDetails: chargedError.structuralDetails,
}), new RegExp(secret));
assert.equal(chargedError.structuralDetails?.src, undefined);
assert.equal(chargedError.generationMeta?.rawResponse, undefined);

console.log("Sync transport test passed: Local waits, Cloud times out, charged telemetry is safe.");
