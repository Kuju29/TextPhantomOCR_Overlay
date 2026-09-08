// Legacy totals stay unchanged; detailed coverage/cache fields have dedicated tests.
const tokenSummary = u => Object.fromEntries(["inputTokens", "outputTokens", "totalTokens", "source"].map(k => [k, u[k]]));
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { readProviderResponse } from "../src/shared/ai/providers/local-transport-runtime.js";
import { completedLineContract } from "../src/shared/ai/contracts/marker-completion.js";
import { createOllamaAdapter } from "../src/shared/ai/providers/local-ollama.js";
import { createOpenAiCompatibleAdapter } from "../src/shared/ai/providers/local-openai-compatible.js";
import { localAiPreset, localProviderCatalog } from "../src/shared/ai/providers/local-registry.js";
import { translateDirectLocal } from "../src/background/ai/transports/direct-local.js";

const generation = fs.readFileSync(new URL("../src/shared/ai/direct-local/generation.js", import.meta.url), "utf8");
const discovery = fs.readFileSync(new URL("../src/shared/ai/direct-local/model-discovery.js", import.meta.url), "utf8");
const capabilities = fs.readFileSync(new URL("../src/shared/ai/direct-local/capability-hints.js", import.meta.url), "utf8");
for (const forbidden of [/\bfetch\s*\(/, /content-type/i, /protocol\s*===/, /prompt_eval_count/,
  /completion_tokens/, /eval_duration/, /\/api\/chat/, /\/chat\/completions/, /normalizeGenerationLine/])
  assert.doesNotMatch(generation, forbidden, `generation leaked provider wire detail: ${forbidden}`);
assert.equal((generation.match(/adapter\.generate\(/g) || []).length, 1);
for (const shared of [discovery, capabilities])
  assert.doesNotMatch(shared, /protocol\s*(?:===|!==)|\/api\/(?:tags|ps)|\/models|prompt_eval_count|completion_tokens/,
    "shared discovery/capability dispatch must not contain provider branches or wire fields");
assert.match(discovery, /adapter\.listModels\(/);

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
const streamed = (frames, type) => new Response(new ReadableStream({ start(controller) {
  for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close();
} }), { status: 200, headers: { "content-type": type } });
try {
  for (const spec of localProviderCatalog().filter((item) => item.id !== "ollama")) {
    const adapter = spec.create(localAiPreset(spec.id));
    const payload = adapter.payload({
      model: "local", messages: [], outputTokens: 128, thinkingMode: "on",
    });
    assert.equal(payload.think, undefined,
      `${spec.id} must not guess Ollama's think field from OpenAI compatibility`);
    assert.equal(payload.reasoning, undefined);
    assert.equal(payload.reasoning_effort, undefined);
  }

  let request;
  globalThis.fetch = async (url, init) => { request = { url: String(url), body: JSON.parse(init.body) };
    return streamed(['{"message":{"content":"<<TP_P0:ไทย>>"}}\n',
      '{"done":true,"done_reason":"stop","prompt_eval_count":9,"eval_count":4}\n'], "application/x-ndjson"); };
  const ollama = createOllamaAdapter({ baseUrl: "http://localhost:11434" });
  const one = await ollama.generate({ model: "qwen", messages: [], outputTokens: 1024, thinkingMode: "off" }, { expectedIds: ["P0"] });
  assert.equal(request.url, "http://localhost:11434/api/chat");
  assert.deepEqual(request.body.options, { num_predict: 1024 });
  assert.deepEqual(tokenSummary(ollama.usage(one.stream.data)), { inputTokens: 9, outputTokens: 4, totalTokens: 13, source: "provider" });
  assert.equal(one.stream.drainStatus, "terminal_received");
  assert.equal(one.stream.providerTerminalComplete, true);
  assert.equal(one.stream.bodyReadComplete, false,
    "cancelling at an authoritative terminal must not claim the HTTP body was fully drained");
  for (const key of ["dispatchToHeadersMs", "firstByteMs", "firstContentMs", "lastContentMs", "terminalMs"])
    assert.ok(Number.isFinite(one.stream[key]) && one.stream[key] >= 0,
      `Ollama ${key} must use the dispatch clock`);
  assert.ok(one.stream.dispatchToHeadersMs <= one.stream.firstByteMs);
  assert.ok(one.stream.firstByteMs <= one.stream.firstContentMs);
  assert.ok(one.stream.firstContentMs <= one.stream.lastContentMs);
  assert.ok(one.stream.lastContentMs <= one.stream.terminalMs);

  globalThis.fetch = async (url, init) => { request = { url: String(url), body: JSON.parse(init.body) };
    return streamed(['data: {"choices":[{"delta":{"content":"<<TP_P0:ไทย>>"}}]}\n\n', 'data: [DONE]\n\n'], "text/event-stream"); };
  const compatible = createOpenAiCompatibleAdapter({ baseUrl: "http://localhost:1234/v1" });
  const two = await compatible.generate({ model: "local", messages: [], outputTokens: 1024, thinkingMode: "default" }, { expectedIds: ["P0"] });
  assert.equal(request.url, "http://localhost:1234/v1/chat/completions");
  assert.equal(request.body.max_tokens, 1024);
  assert.equal(two.stream.terminalEvidence, "protocol_done");
  assert.equal(two.stream.completionEvidence, "all_id_records_closed");

  globalThis.fetch = async () => streamed([
    'data: {"choices":[{"delta":{"content":"<<TP_P0:ไทย>>"}}]}\n\n',
    "data: [DONE]\n\n",
  ], "text/event-stream");
  const delayedSinkStarted = performance.now();
  const delayedSink = await compatible.generate(
    { model: "local", messages: [], outputTokens: 128, thinkingMode: "default" },
    { expectedIds: ["P0"], wireTrace: () => new Promise((resolve) => setTimeout(resolve, 500)) },
  );
  assert.ok(performance.now() - delayedSinkStarted < 200,
    "diagnostic sink latency must not delay the provider path");
  assert.ok(delayedSink.providerMs < 200,
    "providerMs must exclude diagnostic sink latency");

  assert.throws(
    () => ollama.responseText({ choices: [{ message: { content: "wrong provider shape" } }] }),
    (error) => error.code === "local_provider_response_contract" && error.providerResponded === true,
    "Ollama must not accept an OpenAI response envelope",
  );

  assert.throws(
    () => compatible.responseText({ message: { content: "wrong provider shape" } }),
    (error) => error.code === "local_provider_response_contract",
    "OpenAI-compatible adapter must not accept an Ollama response envelope",
  );

  globalThis.fetch = async () => streamed(['data: {bad}\n\n'], "text/event-stream");
  const malformed = await compatible.generate({ model: "local", messages: [], outputTokens: 1024, thinkingMode: "default" }, {});
  assert.equal(malformed.stream.malformedFrameCount, 1);
} finally { globalThis.fetch = originalFetch; }
console.log("Local provider boundary tests passed: adapters own wire, stream, terminal and usage contracts.");

const openAi = createOpenAiCompatibleAdapter({ baseUrl: "http://localhost:1234/v1" });
const sse = (item) => `data: ${JSON.stringify(item)}\n\n`;
const delta = (content) => sse({ choices: [{ delta: { content } }] });
async function readOpenStream(frames, expectedIds = [], adapter = openAi) {
  const abort = new AbortController();
  const cancellations = [];
  const body = new ReadableStream({
    start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); },
    cancel(reason) { cancellations.push(reason); },
  });
  // A test-only watchdog exposes reads left pending after provider completion.
  const timer = setTimeout(() => abort.abort(new Error("stream remained open after completion")), 250);
  try {
    const result = await readProviderResponse(new Response(body, {
      headers: { "content-type": adapter.streamMode === "ollama_ndjson" ? "application/x-ndjson" : "text/event-stream" },
    }), adapter, { expectedIds, signal: abort.signal });
    assert.equal(cancellations.length, 1, "completed streams release the provider connection");
    return result;
  } finally { clearTimeout(timer); }
}

await test("record completion is evidence but waits for authoritative terminal", async () => {
  for (const ending of ["", "\n", "\r\n"]) {
    const output = `<<TP_P0:complete>>${ending}`;
    assert.equal(completedLineContract(output, ["P0"]), "all_id_records_closed");
    const result = await readOpenStream([delta(output), "data: [DONE]\n\n"], ["P0"]);
    assert.equal(result.earlyCompleted, false);
    assert.equal(result.completionEvidence, "all_id_records_closed");
    assert.equal(result.terminalEvidence, "protocol_done");
    assert.equal(result.data.choices[0].message.content, output);
  }
  for (const ending of ["\n\n", "\r\n\r\n", "\r", "\nprose"])
    assert.equal(completedLineContract(`<<TP_P0:complete>>${ending}`, ["P0"]), "");
});

await test("provider DONE ends an open SSE stream independently of record completion", async () => {
  for (const expectedIds of [[], ["P0", "P1"]]) {
    const result = await readOpenStream([
      delta("<<TP_P0:partial>>"),
      "data: [DONE]\n\n" + delta("ignored after terminal"),
    ], expectedIds);
    assert.equal(result.terminalEvidence, "protocol_done");
    assert.equal(result.earlyCompleted, false);
    assert.equal(result.data.choices[0].message.content, "<<TP_P0:partial>>");
  }
});

await test("SSE comments are ignored while malformed frames remain diagnosed", async () => {
  const result = await readProviderResponse(streamed([
    ": keepalive\n\n:\n\n", delta("plain text"), "data: [DONE]\n\n",
  ], "text/event-stream"), openAi);
  assert.equal(result.malformedFrameCount, 0);
  assert.deepEqual(result.malformedFrameSubtypes, []);
  const malformed = await readProviderResponse(streamed(["broken frame\n\ndata: {bad}\n\n"], "text/event-stream"), openAi);
  assert.deepEqual(malformed.malformedFrameSubtypes, ["sse_non_data_line", "invalid_sse_json"]);
});

await test("finish_reason allows trailing usage before protocol DONE", async () => {
  const result = await readOpenStream([
    delta("plain text"),
    sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    sse({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
    "data: [DONE]\n\n",
  ]);
  assert.deepEqual(tokenSummary(openAi.usage(result.data)), { inputTokens: 7, outputTokens: 3, totalTokens: 10, source: "provider" });
  assert.equal(result.terminalCompleted, true);
});

await test("non-stream timing does not mislabel full-body completion as first byte", async () => {
  const events = [];
  const response = new Response(JSON.stringify({ choices: [{ message: { content: "plain" }, finish_reason: "stop" }] }),
    { headers: { "content-type": "application/json" } });
  const result = await readProviderResponse(response, openAi, {
    wireTrace: (stage, value) => events.push({ stage, value }),
  });
  assert.equal(result.firstByteMs, null);
  assert.equal(result.firstContentMs, null);
  assert.equal(result.bodyReadComplete, true);
  assert.equal(result.providerTerminalComplete, true);
  const evidence = events.find((event) => event.stage === "providerResponse").value;
  assert.equal(evidence.bodyReadComplete, true);
  assert.equal(evidence.providerTerminalComplete, true);
});

await test("stream failure preserves truthful completion flags and timing", async () => {
  const events = [];
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(delta("partial")));
    controller.error(new Error("broken stream"));
  } });
  let failure;
  try {
    await readProviderResponse(new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }), openAi, { wireTrace: (stage, value) => events.push({ stage, value }) });
  } catch (error) { failure = error; }
  assert.match(failure.message, /broken stream/);
  assert.ok(failure.diagnostics.providerMs > 0);
  const evidence = events.find((event) => event.stage === "providerResponse").value;
  assert.equal(evidence.bodyReadComplete, false);
  assert.equal(evidence.providerTerminalComplete, false);
  assert.equal(evidence.complete, false);
  assert.ok(Number.isFinite(evidence.timing.terminalMs));
});

await test("assembled evidence does not claim completion without provider terminal", async () => {
  const events = [];
  const result = await readProviderResponse(streamed([delta("plain")], "text/event-stream"), openAi, {
    wireTrace: (stage, value) => events.push({ stage, value }),
  });
  assert.equal(result.providerTerminalComplete, false);
  const assembled = events.find((event) => event.stage === "providerAssembled").value;
  assert.equal(assembled.complete, false);
  assert.equal(assembled.providerTerminalComplete, false);
});

await test("body-read and connection failures reach Direct Local timing evidence", async () => {
  const canonicalPrompt = { version: "translation-plan-2", pieces: {
    systemPolicy: "Translate.", editableStyle: "Target language: Thai",
    targetLanguageInstruction: "Target language: Thai (ภาษาไทย).",
    sourceInputContract: "Read records.", imageHint: "Use image context.",
    structuredOutputContract: "Return JSON.", markerOutputContract: "Return markers.",
    seriesNotesHeading: "SERIES NOTES",
  } };
  const run = async (fetchImpl) => {
    const events = [];
    globalThis.fetch = fetchImpl;
    await assert.rejects(translateDirectLocal([{ id: "g0", text: "原文" }], {
      ai: { model: "local", provider: "local", local_adapter: {
        protocol: "openai", baseUrl: "http://127.0.0.1:1234/v1",
      }, prompt: "Target language: Thai\nTranslate naturally.", promptMode: "replace" },
      targetLang: "th", sourceLang: "ja", canonicalPrompt,
      wireTrace: (stage, value) => events.push({ stage, value }),
    }));
    const timing = events.findLast((event) => event.stage === "timing")?.value;
    assert.ok(timing && Number.isFinite(timing.providerMs) && timing.providerMs > 0,
      "Direct Local 09_timing must retain elapsed provider time on failure");
  };
  try {
    await run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(new ReadableStream({ start(controller) {
        controller.error(new Error("body read failed"));
      } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new TypeError("connection failed");
    });
  } finally { globalThis.fetch = originalFetch; }
});

await test("Ollama done ends an open stream even when record output is incomplete", async () => {
  const ollama = createOllamaAdapter({ baseUrl: "http://localhost:11434" });
  for (const content of ["", "<<TP_P0:partial>>", "malformed output"]) {
    const result = await readOpenStream([
      JSON.stringify({ message: { content } }) + "\n",
      JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 7, eval_count: 3 }) + "\n",
    ], ["P0", "P1"], ollama);
    assert.equal(result.earlyCompleted, false);
    assert.equal(result.terminalEvidence, "provider_done");
    assert.equal(result.data.message.content, content);
    assert.equal(result.data.eval_count, 3);
  }
});
