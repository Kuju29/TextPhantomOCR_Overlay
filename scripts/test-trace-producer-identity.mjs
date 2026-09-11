import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

globalThis.chrome = { runtime: { getManifest: () => ({ version: "test-build" }) } };
const requests = [];
let failFirst = true;
globalThis.fetch = async (_url, options) => {
  requests.push(JSON.parse(options.body));
  if (failFirst) {
    failFirst = false;
    throw new Error("lost ack");
  }
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ok:true, session:JSON.parse(options.body).traceSession}) };
};

const trace = await import("../src/shared/trace.js");
assert.equal(trace.getTraceShippingState().clientBuild, "test-build");
assert.equal(trace.getTraceShippingState().traceSession, "");
trace.setTracingEnabled(true, () => "http://local", "compact", "session-a");
assert.equal(trace.getTraceShippingState().traceSession, "session-a");
trace.traceLine("worker.js", "run", "->", { attempt: 1 }, "t1");
await trace.flushTrace();
await trace.flushTrace();

assert.equal(requests.length, 2, "a lost ACK retains and resends the same batch");
assert.equal(requests[0].shipmentId, requests[1].shipmentId, "exact resend has stable shipment identity");
assert.match(requests[0].shipmentId, /^(?:[0-9a-f]{64}|fnv-[0-9a-f]+)$/);
assert.ok(requests[0].producerId, "payload identifies the worker producer");
assert.equal(requests[0].records[0].producerId, requests[0].producerId);

trace.traceRelay({
  t: Date.now(), n: 1, trace: "t2", side: "page", producerId: "page-context-a",
  tabId: 7, frameId: 3, file: "page.js", fn: "go", ev: "->",
});
await trace.flushTrace();
const relayed = requests.at(-1).records[0];
assert.equal(relayed.producerId, "page-context-a");
assert.equal(relayed.tabId, 7);
assert.equal(relayed.frameId, 3);

// A Connect click may happen before the first translation/capabilities probe.
// It stays memory-only, then ships only after the server explicitly opts in.
const cold = await import(`../src/shared/trace.js?cold=${Date.now()}`);
const beforeCold = requests.length;
cold.traceLine("background/index.js", "localModelDiscovery", "..", { event: "error", code: "local_ai_unreachable" }, "discover-cold");
await cold.flushTrace();
assert.equal(requests.length, beforeCold, "pre-capability trace never writes externally");
cold.setTracingEnabled(true, () => "http://local", "compact", "session-cold");
await cold.flushTrace();
assert.equal(requests.length, beforeCold + 1, "cold-start discovery ships after trace-enabled handshake");
assert.equal(requests.at(-1).records[0].trace, "discover-cold");

const sentinel = cold.shortenValue({
  apiKey: "sk-SENTINELSECRET123456789", authorization: "Bearer SENTINELTOKEN123456",
  cookie: "session=SENTINELCOOKIE", safeCode: "local_ai_unreachable",
});
const sentinelJson = JSON.stringify(sentinel);
assert.ok(!sentinelJson.includes("SENTINELSECRET") && !sentinelJson.includes("SENTINELTOKEN") && !sentinelJson.includes("SENTINELCOOKIE"));
assert.ok(sentinelJson.includes("local_ai_unreachable"));
const counters = cold.shortenValue({
  requestedOutputTokens: 8192, inputTokens: 120, outputTokens: 40, totalTokens: 160, thinkingTokens: 12,
  apiKey: 12345, accessToken: 67890, refreshToken: 222, bearer: "Bearer SENTINEL_BEARER",
  token: "SENTINEL_STRING_TOKEN", nested: { output_tokens: 9, total_tokens: "SENTINEL_NOT_NUMERIC" },
});
assert.deepEqual({
  requestedOutputTokens: counters.requestedOutputTokens, inputTokens: counters.inputTokens,
  outputTokens: counters.outputTokens, totalTokens: counters.totalTokens, thinkingTokens: counters.thinkingTokens,
  nestedOutput: counters.nested.output_tokens,
}, { requestedOutputTokens: 8192, inputTokens: 120, outputTokens: 40, totalTokens: 160, thinkingTokens: 12, nestedOutput: 9 });
const counterJson = JSON.stringify(counters);
assert.doesNotMatch(counterJson, /12345|67890|SENTINEL|222/,
  "only the five allowlisted numeric diagnostic counters may bypass token/key redaction");
assert.equal(counters.nested.total_tokens, "<redacted>", "string token-like values remain credentials");

const cachedObservation = cold.enrichOperationalTrace("aiModelWorkload", "..", {
  event: "observation", operationId: "op-cache", usage: { cachedInput: 768 },
});
assert.deepEqual(cachedObservation.cache,
  { kind: "provider_prompt", hit: true, cachedInputTokens: 768 },
  "provider prompt cache requires positive cached-input evidence");
const uncachedObservation = cold.enrichOperationalTrace("aiModelWorkload", "..", {
  event: "observation", operationId: "op-no-cache", usage: { cachedInput: 0 },
});
assert.equal(uncachedObservation.cache.hit, false, "zero cached tokens must never claim a cache hit");
const operationalFlags = cold.shortenValue({ pageImageToAi: true, manualAiRateCap: false,
  imageDataUri: "data:image/png;base64,SENTINEL_IMAGE" });
assert.equal(operationalFlags.pageImageToAi, true);
assert.equal(operationalFlags.manualAiRateCap, false);
assert.notEqual(operationalFlags.imageDataUri, "data:image/png;base64,SENTINEL_IMAGE",
  "allowing path booleans must not allow image payloads");
const terminal = cold.enrichOperationalTrace("aiPageContract", "..", {
  event: "final", operationId: "shared-op", batchId: "batch-a", imageId: "image-a",
  userScopeHash: "opaque-user-a",
});
const otherUser = cold.enrichOperationalTrace("aiPageContract", "..", {
  event: "final", operationId: "shared-op", batchId: "batch-a", imageId: "image-a",
  userScopeHash: "opaque-user-b",
});
assert.equal(terminal.final, true);
assert.equal(terminal.owner, "unknown", "success does not invent provider ownership");
assert.notEqual(terminal.incidentId, otherUser.incidentId, "opaque user scopes isolate incidents");
assert.equal(terminal.correlation.imageId, "image-a");
assert.notEqual(terminal.userScopeHash, "opaque-user-a", "raw client scope claim leaked");
assert.match(terminal.userScopeHash, /^user:/);
assert.equal(terminal.userScopeHash, terminal.correlation.userScopeHash,
  "flat and nested user scopes must share one canonical hash");
const nestedScopeOnly = cold.enrichOperationalTrace("aiPageContract", "..", {
  event: "final", operationId: "nested-op", scope: { clientInstanceHash: "raw-client" },
});
assert.equal(nestedScopeOnly.clientInstanceHash, nestedScopeOnly.correlation.clientInstanceHash,
  "nested-only client scope must be normalized once and copied");
const cacheWrite = cold.shortenValue({ cacheWriteInputTokens: 64 });
assert.equal(cacheWrite.cacheWriteInputTokens, 64, "numeric cache-write evidence was redacted");
const nestedPrivate = JSON.stringify(cold.shortenValue({
  nested: { source: "SENTINEL_DIALOGUE", translation: "SENTINEL_TRANSLATION", prompt: "SENTINEL_PROMPT" },
  original: "https://img.example/a.jpg?X-Amz-Signature=SENTINEL_SIGNED_URL",
}));
assert.ok(!nestedPrivate.includes("SENTINEL_"), "nested content and signed image URL fields are redacted");
const neutralPrivate = JSON.stringify(cold.shortenValue({
  foo: "data:image/png;base64,SENTINEL_RAW_IMAGE",
  list: ["https://example.com/private/path?ordinary=SENTINEL_FULL_URL"],
}));
assert.ok(!neutralPrivate.includes("SENTINEL_RAW_IMAGE") && !neutralPrivate.includes("SENTINEL_FULL_URL"),
  "URL and image values are redacted even under neutral keys and arrays");

const pageRecords = [];
const pageContext = {
  window: { __TP: {} }, Element: class {}, TextEncoder, Date, Math,
  crypto: globalThis.crypto,
  chrome: { runtime: { lastError: null, sendMessage: (msg, cb) => { pageRecords.push(msg.record); cb?.(); } } },
};
vm.runInNewContext(readFileSync(new URL("../src/content/trace.js", import.meta.url), "utf8"), pageContext);
pageContext.window.__TP.setTracingEnabled(true, "full");
pageContext.window.__TP.traceNote("content/overlay.js", "sentinel", {
  original: "https://img.example/a.jpg?X-Amz-Signature=SENTINEL_URL_SIGNATURE",
  nested: { text: "SENTINEL_DIALOGUE", prompt: "SENTINEL_PROMPT", authorization: "Bearer SENTINEL_AUTH" },
  event: "safe_event",
});
const pageJson = JSON.stringify(pageRecords);
assert.ok(!pageJson.includes("SENTINEL_URL_SIGNATURE") && !pageJson.includes("SENTINEL_DIALOGUE") &&
  !pageJson.includes("SENTINEL_PROMPT") && !pageJson.includes("SENTINEL_AUTH"));
assert.ok(pageJson.includes("safe_event"));

const disabled = await import(`../src/shared/trace.js?disabled=${Date.now()}`);
disabled.traceLine("background/index.js", "localModelDiscovery", "..", { event: "stale_discard" }, "discard-me");
disabled.setTracingEnabled(false, () => "http://other", "off", "session-off");
disabled.setTracingEnabled(true, () => "http://other", "compact", "session-new");
const beforeDisabledFlush = requests.length;
await disabled.flushTrace();
assert.equal(requests.length, beforeDisabledFlush, "disabled/base-session transition clears pre-capability records");

// Exercise the production handshake helper used by TP_LOCAL_AI_DISCOVER.
const handshake = await import("../src/background/trace-handshake.js");
handshake.resetTraceHandshakeIdentity();
const noBase = await handshake.ensureTraceHandshake("");
assert.equal(noBase.reason, "no_api_base");
assert.deepEqual(handshake.getTraceHandshakeState(), {
  schema: "tp.trace-handshake/1", outcome: "no_api_base", status: 0,
  durationMs: 0, endpointClass: "empty", traceSession: "", traceFile: "",
});
const connectRequests = [];
globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  if (href.endsWith("/v1/capabilities")) {
    const traceOn = href.startsWith("http://trace-on");
    return new Response(JSON.stringify({
      apiVersion: "test", features: {
        trace: traceOn, traceDetail: traceOn ? "compact" : "off",
        traceSession: traceOn ? "connect-session" : "off-session",
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (href.endsWith("/v1/trace")) {
    connectRequests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  throw new Error(`unexpected test request ${href}`);
};
trace.traceLine("background/index.js", "localModelDiscovery", "..", { event: "start" }, "connect-before-job");
const on = await handshake.ensureTraceHandshake("http://trace-on");
assert.equal(on.known, true);
assert.equal(on.trace, true);
assert.deepEqual(handshake.getTraceHandshakeState(), {
  schema: "tp.trace-handshake/1", outcome: "active", status: 200,
  durationMs: handshake.getTraceHandshakeState().durationMs,
  endpointClass: "public", traceSession: "connect-session", traceFile: "",
});
assert.ok(connectRequests.some((batch) => batch.records.some((record) => record.trace === "connect-before-job")),
  "Connect itself negotiates tracing and ships its start before any translation job");

handshake.resetTraceHandshakeIdentity();
trace.traceLine("background/index.js", "localModelDiscovery", "..", { event: "start" }, "connect-trace-off");
const beforeOff = connectRequests.length;
const off = await handshake.ensureTraceHandshake("http://trace-off");
assert.equal(off.known, true);
assert.equal(off.trace, false);
assert.equal(handshake.getTraceHandshakeState().outcome, "disabled");
await trace.flushTrace();
assert.equal(connectRequests.length, beforeOff, "authoritative trace=false clears the buffered Connect prefix");

// A late capabilities response for an old API base must not overwrite the new base.
handshake.resetTraceHandshakeIdentity();
let resolveA;
let resolveB;
globalThis.fetch = (url) => new Promise((resolve) => {
  const href = String(url);
  if (href.endsWith("/v1/capabilities") && href.startsWith("http://race-a")) resolveA = resolve;
  else if (href.endsWith("/v1/capabilities") && href.startsWith("http://race-b")) resolveB = resolve;
  else throw new Error(`unexpected race request ${href}`);
});
const raceA = handshake.ensureTraceHandshake("http://race-a");
const raceB = handshake.ensureTraceHandshake("http://race-b");
resolveB(new Response(JSON.stringify({ apiVersion: "test", features: { trace: true, traceDetail: "compact", traceSession: "race-b" } }),
  { status: 200, headers: { "Content-Type": "application/json" } }));
const resultB = await raceB;
resolveA(new Response(JSON.stringify({ apiVersion: "test", features: { trace: false, traceDetail: "off", traceSession: "race-a" } }),
  { status: 200, headers: { "Content-Type": "application/json" } }));
const resultA = await raceA;
assert.equal(resultB.trace, true);
assert.equal(resultA.reason, "stale_capabilities");
assert.equal(handshake.getTraceHandshakeState().outcome, "stale_capabilities");

handshake.resetTraceHandshakeIdentity();
globalThis.fetch = async () => { throw new Error("https://secret.example/?token=SENTINEL"); };
const unavailable = await handshake.ensureTraceHandshake("http://192.168.1.8:7860");
assert.equal(unavailable.reason, "capabilities_unavailable");
const unavailableState = handshake.getTraceHandshakeState();
assert.equal(unavailableState.endpointClass, "private");
assert.equal(unavailableState.outcome, "capabilities_unavailable");
assert.doesNotMatch(JSON.stringify(unavailableState), /secret|SENTINEL|192\.168/);

for (const instance of [trace, cold, disabled]) instance.setTracingEnabled(false);
console.log("trace producer identity tests passed");
