import assert from "node:assert/strict";
import { AI_WIRE_TRACE_SCHEMA, aiWireTraceEnabled, createAiWireRecorder,
  redactAiWireValue } from "../src/background/ai/wire-trace.js";

assert.equal(AI_WIRE_TRACE_SCHEMA, "tp.ai-wire-trace/1");
assert.equal(aiWireTraceEnabled({ aiWireTrace: true }), true);
assert.equal(aiWireTraceEnabled({ aiWireTrace: false }), false);
assert.deepEqual(redactAiWireValue({ Authorization: "Bearer x", apiKey: "x", prompt: "keep" }),
  { Authorization: "<redacted>", apiKey: "<redacted>", prompt: "keep" });

const calls = [];
const recorder = createAiWireRecorder({ enabled: true, operationId: "op-1", traceId: "trace-1",
  identity: { engine: "runsextension", route: "direct-local", imageId: "image-1" },
  apiBase: "http://127.0.0.1:7860", relay: {
    path: "/v2/engine/runsextension/ai/local-wire-trace", token: "capability", maxEventBytes: 200000,
  }, fetchImpl: async (url, init) => {
    calls.push({ url, init, payload: JSON.parse(init.body) });
    return { ok: true, status: 202 };
  } });
await recorder("units", [{ id: "g0", text: "原文" }]);
await recorder("providerRequest", { url: "http://127.0.0.1:11434/api/chat?key=secret",
  headers: { Authorization: "Bearer secret" }, body: { model: "qwen", messages: [{ content: "<<TP_P0:原文>>" }] } });
await recorder("providerResponse", { raw: '{"message":{"content":"<<TP_P0:ไทย>>"}}' });
await recorder("contractSelection", { selectedContract: "tp.translation.schema-object/1" });
await recorder("contractApplied", { selectedContract: "tp.translation.schema-object/1" });
await recorder("failure", { stage: "target_language_validation", code: "wrong_language_output" });
assert.equal(await recorder.flush(1000), true);
assert.deepEqual(calls.map((call) => call.payload.stage),
  ["trace_started", "units", "providerRequest", "providerResponse", "contractSelection", "contractApplied", "failure"]);
assert.ok(calls.every((call) => call.init.headers["X-TP-AI-Wire-Capability"] === "capability"));
assert.ok(calls.every((call) => call.payload.identity.executionKey));
const request = calls[2].payload.value;
assert.equal(request.headers.Authorization, "<redacted>");
assert.match(request.url, /key=%3Credacted%3E/);
assert.equal(request.body.messages[0].content, "<<TP_P0:原文>>");
assert.equal(calls[2].init.headers["X-TP-Trace-Id"], "trace-1");
assert.equal(calls[2].init.headers["X-TP-Image-Id"], "image-1");

const timeoutRecorder = createAiWireRecorder({ enabled: true, operationId: "op-timeout", traceId: "trace-timeout",
  identity: { route: "direct-local" }, apiBase: "http://api",
  relay: { path: "/relay", token: "x", timeoutMs: 250 },
  fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }) });
const timeoutStarted = performance.now();
await timeoutRecorder("units", []);
await timeoutRecorder("providerRequest", { body: "queued behind trace start" });
await timeoutRecorder("providerResponse", { raw: "never relayed" });
assert.ok(performance.now() - timeoutStarted < 80,
  "diagnostic calls must be nonblocking even while the first relay hangs");
assert.equal(await timeoutRecorder.flush(600), false);

let stalledBodyCalls = 0;
const stalledBodyRecorder = createAiWireRecorder({ enabled: true, operationId: "op-body", traceId: "trace-body",
  identity: { route: "direct-local" }, apiBase: "http://api",
  relay: { path: "/relay", token: "x", timeoutMs: 250 },
  fetchImpl: (_url, init) => {
    stalledBodyCalls += 1;
    return Promise.resolve({ ok: false, status: 500, text: () => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }) });
  } });
await stalledBodyRecorder("units", []);
assert.equal(await stalledBodyRecorder.flush(600), false,
  "a stalled relay error body must trip the bounded circuit breaker");
assert.equal(stalledBodyCalls, 1, "the circuit breaker stops later trace stages after failure");

const persistedStages = [];
let releaseTerminal;
const terminalGate = new Promise((resolve) => { releaseTerminal = resolve; });
const generationRecorder = createAiWireRecorder({ enabled: true, operationId: "op-generations",
  traceId: "trace-generations", identity: { route: "direct-local" }, apiBase: "http://api",
  relay: { path: "/relay", token: "x", timeoutMs: 1000 },
  fetchImpl: async (_url, init) => {
    const stage = JSON.parse(init.body).stage;
    if (stage === "terminal") await terminalGate;
    persistedStages.push(stage);
    return { ok: true, status: 202 };
  } });
await generationRecorder("failure", { code: "intermediate" });
assert.equal(await generationRecorder.flush(1000), true);
assert.deepEqual(persistedStages, ["trace_started", "failure"]);
await generationRecorder("terminal", { state: "failed" });
let ownerFlushDone = false;
const ownerFlush = generationRecorder.flush(1000).then((value) => {
  ownerFlushDone = true; return value;
});
await Promise.resolve();
assert.equal(ownerFlushDone, false,
  "a later terminal must have a fresh drain generation after an earlier failure flush");
releaseTerminal();
assert.equal(await ownerFlush, true);
assert.deepEqual(persistedStages, ["trace_started", "failure", "terminal"]);

let invoked = false;
assert.equal(createAiWireRecorder({ enabled: false, fetchImpl: async () => { invoked = true; } }), null);
const cloud = createAiWireRecorder({ enabled: true, identity: { route: "server" },
  relay: { path: "/relay", token: "x" }, apiBase: "http://api", fetchImpl: async () => { invoked = true; } });
await cloud("units", []);
assert.equal(invoked, false, "cloud trace remains owned by its Python provider route");

console.log("Extension Direct Local AI wire relay tests passed");
