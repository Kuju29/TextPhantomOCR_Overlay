import assert from "node:assert/strict";
globalThis.chrome = { storage: { local: { get: (_k, cb) => cb({}), set: (_v, cb) => cb?.() } } };
const { fetchLensRawViaRest, groupParagraphsViaRest, translateViaSyncRest } = await import("../src/background/transport.js");

globalThis.fetch = async () => new Response("<!doctype html><h1>Bad Gateway</h1>", {
  status: 502, headers: { "content-type": "text/html" },
});
await assert.rejects(fetchLensRawViaRest("https://api.example.test", {
  imageBytes: new Uint8Array([1]), mime: "image/png", lang: "th",
}), (e) => e.tpError?.code === "GATEWAY_502" && e.tpError.origin === "hosting_gateway" &&
  e.tpError.stage === "lens" && e.tpError.httpStatus === 502 && e.tpError.retryable === true);

globalThis.fetch = async () => new Response(JSON.stringify({ detail: {
  code: "provider_rate_limited", origin: "ai_provider", stage: "ai", retryable: true,
  upstreamStatus: 429, traceId: "trace-provider", requestId: "request-provider",
} }), { status: 429, headers: { "content-type": "application/json" } });
await assert.rejects(translateViaSyncRest("https://api.example.test", { mode: "lens_text", context: {} }),
  (e) => e.tpError?.origin === "ai_provider" && e.tpError.stage === "ai" && e.failedStage === "ai" && e.status === 429 &&
    e.tpError.upstreamStatus === 429 && e.tpError.traceId === "trace-provider" &&
    e.tpError.requestId === "request-provider");

globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
await assert.rejects(groupParagraphsViaRest("https://api.example.test", { tree: {}, context: {} }),
  (e) => e.tpError?.code === "NET_OFFLINE" && e.tpError.origin === "browser" && e.tpError.stage === "grouping");
console.log("Transport error test passed: failures retain gateway, provider and browser origin.");
