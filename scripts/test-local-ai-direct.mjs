// Legacy totals stay unchanged; detailed coverage/cache fields have dedicated tests.
const tokenSummary = u => Object.fromEntries(["inputTokens", "outputTokens", "totalTokens", "source"].map(k => [k, u[k]]));
import assert from "node:assert/strict";
import { assertNoDuplicateJsonKeys, completedLineContract, discoverLocalModels, localAiOutputBudgetForTest, shouldUseDirectLocalAi, translateWithLocalOpenAi as translateRaw } from "../src/shared/ai/direct-local/generation.js";
import { failureUsageDetails, recordUsage, usageKey } from "../src/shared/ai-usage.js";
const translateWithLocalOpenAi = (units, options = {}) => translateRaw(units, {
  canonicalPrompt: options.canonicalPrompt || canonicalPrompt,
  targetLang: "th",
  ...options,
  ai: { prompt: "full style", promptMode: "replace", ...(options.ai || {}) },
});

assert.ok(localAiOutputBudgetForTest([{ text: "สั้น" }]) >= 1024);
assert.equal(localAiOutputBudgetForTest([{ text: "漢".repeat(10000) }]), 8192);

assert.equal(shouldUseDirectLocalAi("extension", "ollama", "http://localhost:11434"), true);
assert.equal(shouldUseDirectLocalAi("api", "ollama", "http://localhost:11434"), false,
  "runs:API must remain API-owned even for a local provider");
assert.equal(shouldUseDirectLocalAi("extension", "gemini", "https://api.example.com"), false,
  "cloud AI in runs:Extension keeps the TextPhantom API route");
assert.equal(completedLineContract("<<TP_P1:แปล>>\n<<TP_P0:ไทย>>", ["P0", "P1"]),
  "all_id_records_closed");
assert.equal(completedLineContract("<<TP_P0:ไทย>>\n<<TP_P1:แป", ["P0", "P1"]), "",
  "the final record must be syntactically closed before early stop");
for (const legacy of ["<<TP_P0>> ไทย\n", "<<TP_P0>>\nไทย\n<<TP_END>>\n", "<<TP_P0>>\nไทย\n<<TP_DONE>>\n"])
  assert.equal(completedLineContract(legacy, ["P0"]), "", "legacy grammar must not complete the selected record contract");

const originalFetch = globalThis.fetch;
const calls = [];
const canonicalPrompt = {
  version: "translation-plan-2",
  localContractVersion: "v1",
  pieces: {
    systemPolicy: "SYSTEM BASE",
    editableStyle: "Target language: Thai\nBUILT-IN STYLE",
    targetLanguageInstruction: "Target language: Thai (ภาษาไทย).",
    sourceInputContract: "SOURCE INPUT CONTRACT",
    imageHint: "IMAGE HINT",
    markerOutputContract: "MARKER CONTRACT",
    structuredOutputContract: "STRUCTURED CONTRACT",
    seriesNotesHeading: "SERIES NOTES HEADING",
  },
};
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({
    message: { content: "<<TP_P0:สวัสดี>>\n<<TP_P1:โลก>>" },
    prompt_eval_count: 21, eval_count: 9,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

try {
  const answer = await translateWithLocalOpenAi([
    { id: "bubble-a", text: "Hello" },
    { id: "bubble-b", text: "world" },
  ], {
    ai: {
      provider: "ollama",
      model: "qwen2.5:14b-instruct-q4_K_M",
      base_url: "http://127.0.0.1:11434",
      api_key: "CLOUD-KEY-MUST-NOT-LEAK",
    },
    systemText: "Translate and preserve every <<TP_Pn>> marker.",
    canonicalPrompt,
    targetLang: "th",
  });
  assert.equal(calls.length, 1, "one image must make exactly one model request");
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/chat");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.credentials, "omit");
  assert.doesNotMatch(calls[0].init.body, /CLOUD-KEY-MUST-NOT-LEAK/);
  assert.equal(calls[0].body.model, "qwen2.5:14b-instruct-q4_K_M", "arbitrary Ollama model ids are preserved");
  assert.equal("temperature" in calls[0].body, false, "Local requests must use model defaults instead of forced sampling controls");
  assert.ok(Number.isInteger(calls[0].body.options?.num_predict), "Ollama owns its native output-token option");
  assert.deepEqual(answer.translations, [
    { id: "bubble-a", text: "สวัสดี" },
    { id: "bubble-b", text: "โลก" },
  ]);
  assert.equal(answer.meta.automaticTransportRetry, false);
  assert.equal(answer.meta.timeoutMs, 0, "direct-local generation must have no default wall-clock deadline");
  assert.ok(answer.meta.providerMs >= 0, "provider timing must be observable");
  assert.ok(answer.meta.parseMs >= 0, "parse timing must be observable");
  assert.ok(answer.meta.requestedOutputTokens >= 1024, "requested output budget must be observable");
  assert.equal(answer.meta.finishReason, "unknown", "missing provider finish reason must stay explicitly unknown");
  assert.deepEqual(tokenSummary(answer.meta.usage), { inputTokens: 21, outputTokens: 9, totalTokens: 30, source: "provider" });

  // Markerless output is an attributable all-missing partial. The page repair
  // owner receives the expected ID while provider usage remains observable.
  let chargedRequest;
  globalThis.fetch = async (_url, init) => {
    chargedRequest = JSON.parse(init.body);
    return new Response(JSON.stringify({
    model: "resolved-openai-local",
    choices: [{ finish_reason: "stop", message: { content: "not the required marker contract" } }],
    usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const chargedPartial = await translateWithLocalOpenAi([{ id: "charged", text: "source" }], {
      ai: { provider: "local-openai", model: "requested-model", base_url: "http://localhost:1234/v1" },
      systemText: "Translate and preserve every <<TP_Pn>> marker.",
      canonicalPrompt,
    });
  assert.equal(chargedRequest.model, "requested-model", "provider dispatch preserves the requested model");
  assert.equal(chargedPartial.meta.model, "resolved-openai-local", "billing identity comes from the serving model");
  assert.deepEqual(chargedPartial.missing, ["charged"]);
  assert.equal(chargedPartial.meta.providerAttempts, 1);
  assert.equal(chargedPartial.meta.httpAttempts, 1);
  const chargedUsage = {
    provider: chargedPartial.meta.provider,
    model: chargedPartial.meta.model,
    ...chargedPartial.meta.usage,
    finishReason: chargedPartial.meta.finishReason,
  };
  assert.deepEqual({
    provider: chargedUsage.provider, model: chargedUsage.model,
    inputTokens: chargedUsage.inputTokens, outputTokens: chargedUsage.outputTokens,
    totalTokens: chargedUsage.totalTokens, finishReason: chargedUsage.finishReason,
  }, {
    provider: "local-openai", model: "resolved-openai-local",
    inputTokens: 100, outputTokens: 25, totalTokens: 125, finishReason: "stop",
  });
  let failureLedger = recordUsage(undefined, {
    runtime: "local", provider: chargedUsage.provider, model: chargedUsage.model,
    engine: "runsextension", requests: 1, failures: 0,
    inputTokens: chargedUsage.inputTokens, outputTokens: chargedUsage.outputTokens,
    totalTokens: chargedUsage.totalTokens,
  }, { now: 1, id: () => "charged-session" });
  const chargedSession = failureLedger.models[usageKey("local", "local-openai", "resolved-openai-local")].sessions[0];
  assert.equal(chargedSession.requests, 1);
  assert.equal(chargedSession.failures, 0);
  assert.equal(chargedSession.totalTokens, 125);

  // A realistic Ollama terminal response without counters remains unknown,
  // never a fabricated zero, while still carrying finish/timing identity.
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: "resolved-ollama", message: { content: "" }, done_reason: "stop",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  let missingUsageError;
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "missing-usage", text: "source" }], {
      ai: { provider: "ollama", model: "requested-ollama", base_url: "http://localhost:11434",
        local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } },
      canonicalPrompt,
    }),
    (error) => { missingUsageError = error; return error.code === "invalid_model_output"; },
  );
  const missingUsage = failureUsageDetails(missingUsageError);
  assert.equal(missingUsage.model, "resolved-ollama");
  assert.equal(missingUsage.inputTokens, null);
  assert.equal(missingUsage.outputTokens, null);
  assert.equal(missingUsage.totalTokens, null);
  assert.equal(missingUsage.finishReason, "stop");
  assert.doesNotMatch(JSON.stringify(missingUsageError), /not the required marker contract|missing-usage/,
    "terminal telemetry must not retain raw prompts or provider output");

  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ message: { content: "<<TP_P0:ทดสอบ>>" }, prompt_eval_count: 13, eval_count: 7 }), { status: 200 });
  };
  const thinkingAnswer = await translateWithLocalOpenAi([{ id: "style", text: "hello" }], {
    ai: {
      model: "qwen", base_url: "http://localhost:11434", prompt: "Target language: Thai\nMY COMPLETE STYLE", promptMode: "replace",
      thinking: "on",
      local_adapter: { version: 1, protocol: "ollama", baseUrl: "http://localhost:11434" },
    },
    canonicalPrompt,
  });
  assert.match(calls[0].body.messages[0].content,
    /^You are an expert translator[\s\S]*\nTRANSLATION STYLE\nMY COMPLETE STYLE$/);
  assert.doesNotMatch(calls[0].body.messages[0].content, /BUILT-IN STYLE|USER TRANSLATION NOTES/,
    "a full editable style replaces the built-in style exactly as on Cloud");
  assert.match(calls[0].body.messages[1].content, /<<TP_Pn:translated text>>/);
  assert.equal("format" in calls[0].body, false, "new Ollama calls never request JSON/schema output");
  assert.equal(calls[0].body.stream, true, "new Local calls request streaming");
  assert.equal(calls[0].body.think, true);
  assert.equal(calls[0].body.options.num_predict, 8192,
    "Ollama thinking must receive the full safe completion ceiling");
  assert.equal(thinkingAnswer.meta.requestedOutputTokens, calls[0].body.options.num_predict,
    "logged requestedOutputTokens must equal the value sent to Ollama");
  assert.equal(calls[0].body.messages[1].content.split("SOURCE TEXT\n")[1], "<<TP_P0:hello>>");
  assert.match(calls[0].body.messages[1].content, /^TRANSLATION TASK\nTranslate every source unit into Thai/);
  assert.doesNotMatch(calls[0].body.messages[1].content, /<<TP_(?:END|DONE)>>/);

  calls.length = 0;
  await translateWithLocalOpenAi([{ id: "style-edge", text: "hello" }], {
    ai: { model: "qwen", base_url: "http://localhost:11434", prompt: "Target languages: Thai edge policy", promptMode: "replace",
      local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } },
    canonicalPrompt,
  });
  assert.match(calls[0].body.messages[0].content,
    /^You are an expert translator[\s\S]*\nTRANSLATION STYLE\nTarget languages: Thai edge policy$/);
  assert.doesNotMatch(calls[0].body.messages[0].content, /BUILT-IN STYLE|SERIES NOTES HEADING/,
    "explicit replace mode does not depend on a magic prompt heading");

  calls.length = 0;
  await translateWithLocalOpenAi([{ id: "notes", text: "hello" }], {
    ai: {
      model: "qwen", base_url: "http://localhost:11434", prompt: "Use the established nickname.",
      local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" },
      series_state: "The group reached town.",
      characters: [{ name: "Rey", gender: "unknown", speech: "blunt", note: "captain" }],
      glossary: [{ src: "Hi", tgt: "หวัดดี" }, { src: "Black Tower", tgt: "หอคอยดำ" }],
      prev_context: [{ src: "Where are we?", who: "Rey" }],
    },
    canonicalPrompt,
  });
  assert.match(calls[0].body.messages[0].content,
    /Use the established nickname\.$/,
    "saved AI Style replaces the built-in style exactly like Cloud");
  assert.doesNotMatch(calls[0].body.messages[0].content, /BUILT-IN STYLE|SERIES NOTES HEADING/);
  assert.doesNotMatch(calls[0].body.messages[0].content, /USER TRANSLATION NOTES/);
  assert.match(calls[0].body.messages[1].content, /CONTEXT[\s\S]*STORY SO FAR[\s\S]*CHARACTER SHEET[\s\S]*TRANSLATION MEMORY[\s\S]*PREVIOUS PAGE[\s\S]*OUTPUT —/,
    "Local context is carried in the user task before its exact output contract");
  assert.doesNotMatch(calls[0].body.messages[1].content, /Hi → หวัดดี/,
    "short context-dependent fragments are filtered exactly like Cloud glossary memory");

  const invalidStructuredReplies = [
    { name: "duplicate", translations: [{ id: "P0", text: "a" }, { id: "P0", text: "b" }], memo: "" },
    { name: "missing", translations: [{ id: "P0", text: "a" }], memo: "" },
    { name: "extra", translations: [{ id: "P0", text: "a" }, { id: "P1", text: "b" }, { id: "P2", text: "c" }], memo: "" },
    { name: "reordered", translations: [{ id: "P1", text: "b" }, { id: "P0", text: "a" }], memo: "" },
    { name: "non-string", translations: [{ id: "P0", text: "a" }, { id: "P1", text: 7 }], memo: "" },
  ];
  for (const invalid of invalidStructuredReplies) {
    globalThis.fetch = async () => new Response(JSON.stringify({
      message: { content: JSON.stringify(invalid) },
    }), { status: 200 });
    const markerlessJson = await translateWithLocalOpenAi([{ id: "a", text: "A" }, { id: "b", text: "B" }], {
        ai: { model: "qwen", base_url: "http://localhost:11434", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, canonicalPrompt,
      });
    assert.deepEqual(markerlessJson.missing, ["a", "b"],
      `markerless ${invalid.name} JSON must send all expected IDs to the single repair owner`);
    assert.equal(markerlessJson.meta.providerAttempts, 1);
  }
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { content: "<<TP_P0:ข้อความ>>" },
  }), { status: 200 });
  const completeWithoutEnd = await translateWithLocalOpenAi([{ id: "a", text: "A" }], {
    ai: { model: "qwen", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, canonicalPrompt,
  });
  assert.equal(completeWithoutEnd.translations[0].text, "ข้อความ");
  assert.equal(completeWithoutEnd.meta.responseShape, "plain-records-v1");

  const rawDuplicateReplies = [
    '{"translations":[],"translations":[],"memo":""}',
    '{"translations":[{"id":"P0","id":"P0","text":"a"}],"memo":""}',
    '{"translations":[{"id":"P0","text":"a","text":"b"}],"memo":""}',
  ];
  for (const rawReply of rawDuplicateReplies) {
    globalThis.fetch = async () => new Response(JSON.stringify({
      message: { content: rawReply },
    }), { status: 200 });
    const duplicateJson = await translateWithLocalOpenAi([{ id: "a", text: "A" }], {
        ai: { model: "qwen", base_url: "http://localhost:11434", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, canonicalPrompt,
      });
    assert.deepEqual(duplicateJson.missing, ["a"],
      "markerless JSON shape is ignored and the expected ID reaches repair");
  }
  assert.doesNotThrow(() => assertNoDuplicateJsonKeys(
    '{"outer":[{"id":"P0","text":"escaped \\\"id\\\":\\\"fake\\\""},{"id":"P1","nested":[1,{"id":"inner"}]}]}'
  ), "escaped key-looking text and keys in separate nested objects are not duplicate-key false positives");

  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { content: '```json\n{"translations":[{"id":"P0","text":"ข้อความ"}],"memo":""}\n```' },
  }), { status: 200 });
  const fencedJson = await translateWithLocalOpenAi([{ id: "real", text: "source" }], {
    ai: { model: "qwen", base_url: "http://localhost:11434", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, canonicalPrompt,
  });
  assert.deepEqual(fencedJson.missing, ["real"]);

  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ message: { content: "<<TP_P0:ทดสอบ>>" }, prompt_eval_count: 13, eval_count: 7 }), { status: 200 });
  };
  const native = await translateWithLocalOpenAi([{ id: "real-id", text: "test" }], {
    ai: {
      model: "any/new-model:latest",
      thinking: "off",
      base_url: "http://localhost:11434",
      api_key: "OTHER-CLOUD-KEY",
      local_adapter: { version: 1, protocol: "ollama", baseUrl: "http://localhost:11434" },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:11434/api/chat");
  assert.equal(calls[0].body.think, false, "native Ollama must receive think:false when thinking is off");
  assert.doesNotMatch(calls[0].init.body, /OTHER-CLOUD-KEY/);
  assert.deepEqual(native.translations, [{ id: "real-id", text: "ทดสอบ" }]);
  assert.deepEqual(tokenSummary(native.meta.usage), { inputTokens: 13, outputTokens: 7, totalTokens: 20, source: "provider" });

  calls.length = 0;
  await translateWithLocalOpenAi([{ id: "real-id", text: "test" }], {
    ai: {
      model: "any/new-model:latest", thinking: "on", base_url: "http://localhost:11434",
      local_adapter: { version: 1, protocol: "ollama", baseUrl: "http://localhost:11434" },
    },
  });
  assert.equal(calls[0].body.think, true, "native Ollama must receive think:true when explicitly enabled");

  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      choices: [{ message: { content: '<<TP_P0:ทดสอบ>>' } }],
    }), { status: 200 });
  };
  await translateWithLocalOpenAi([{ id: "real-id", text: "test" }], {
    ai: {
      model: "local-model", thinking: "on", base_url: "http://localhost:1234/v1",
      local_adapter: {
        version: 1, protocol: "openai", baseUrl: "http://localhost:1234/v1",
        thinking: { parameter: "reasoning_effort", off: "none", on: "medium" },
      },
    },
  });
  assert.equal(calls[0].body.reasoning_effort, "medium",
    "custom OpenAI-compatible runtimes receive only their declared thinking mapping");

  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { content: [{ type: "text", text: '<<TP_P0:ส่วนคำตอบ>>' }] }, done_reason: "stop",
  }), { status: 200 });
  const parts = await translateWithLocalOpenAi([{ id: "parts", text: "answer" }], {
    ai: { model: "qwen", base_url: "http://localhost:11434", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } },
  });
  assert.equal(parts.translations[0].text, "ส่วนคำตอบ", "native content parts must be joined as final output");

  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { content: "", thinking: "internal reasoning only" }, done_reason: "stop",
  }), { status: 200 });
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "P0", text: "x" }], {
      ai: { model: "qwen", base_url: "http://localhost:11434", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } },
    }),
    (error) => error.code === "local_ai_thinking_no_answer" && /reasoning was produced/.test(error.message) && /stop/.test(error.message),
    "thinking must be diagnostic only and never become translated text",
  );

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 });
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "P0", text: "x" }], {
      ai: { model: "missing", base_url: "http://localhost:11434" },
    }),
    (error) => error.code === "local_model_not_found" && error.retryable === false &&
      error.requestDispatched === true && error.providerResponded === true && error.generationAttempts === 0,
  );

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "route not found" } }), { status: 404 });
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "P0", text: "x" }], {
      ai: { model: "installed", base_url: "http://localhost:11434" },
    }),
    (error) => error.code === "local_ai_endpoint_incompatible",
    "a missing chat route must remain distinct from a missing model",
  );

  await assert.rejects(
    translateWithLocalOpenAi([{ id: "P0", text: "x" }], {
      ai: { model: "auto", base_url: "http://localhost:11434", api_key: "SECRET" },
    }),
    (error) => error.code === "local_model_missing" && error.providerAttempts === 0,
  );

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ id: "qwen-new:32b" }, { id: "llama-future" }] }), { status: 200 });
  };
  calls.length = 0;
  const discovered = await discoverLocalModels({
    version: 1, protocol: "openai", baseUrl: "http://192.168.1.20:8080", modelsPath: "/models",
    modelsResponsePath: "data.*.id",
  });
  assert.deepEqual(discovered.models, ["qwen-new:32b", "llama-future"]);
  assert.equal(calls[0].url, "http://192.168.1.20:8080/v1/models");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  await assert.rejects(
    discoverLocalModels({ protocol: "openai", baseUrl: "https://public.example.com" }),
    (error) => error.code === "local_endpoint_not_private",
  );
  await assert.rejects(
    discoverLocalModels({
      protocol: "openai", baseUrl: "http://localhost:11434/v1", modelsPath: "/../admin",
    }),
    (error) => error.code === "invalid_local_endpoint",
  );
  let forbiddenFetches = 0;
  globalThis.fetch = async () => { forbiddenFetches += 1; throw new Error("must not fetch"); };
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "P0", text: "private text" }], {
      ai: { provider: "ollama", model: "x", base_url: "https://attacker.example/v1" },
    }),
    (error) => error.code === "local_endpoint_not_private",
  );
  for (const unsafe of [
    "http://user:password@localhost:11434/v1",
    "http://localhost:11434/v1?redirect=https://attacker.example",
    "http://localhost:11434/v1#unsafe",
  ]) {
    await assert.rejects(
      translateWithLocalOpenAi([{ id: "P0", text: "private text" }], {
        ai: { provider: "ollama", model: "x", base_url: unsafe },
      }),
      (error) => error.code === "invalid_local_endpoint",
    );
  }
  assert.equal(forbiddenFetches, 0, "unsafe endpoints must fail before fetch");

  const chunkedResponse = (chunks, contentType) => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": contentType } });

  // Ollama NDJSON may split a marker across arbitrary network chunks. The
  // adapter buffers the final answer for atomic mapping while exposing stream
  // timing/count metadata and preserving multiline Unicode/braces/quotes.
  const twentyFour = Array.from({ length: 24 }, (_, index) => ({ id: `real-${index}`, text: `源 ${index} {\"x\"}` }));
  const batchBodies = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    batchBodies.push(request);
    const source = String(request.messages.at(-1).content || "");
    const count = [...source.matchAll(/<<TP_P(\d+):/g)]
      .reduce((max, match) => Math.max(max, Number(match[1]) + 1), 0);
    const markerAnswer = Array.from({ length: count }, (_, index) =>
      `<<TP_P${index}:คำแปล ${index} {\"ok\"}>>`,
    ).join("\n");
    const ndjson = [
      { message: { thinking: "reasoning only" }, done: false },
      { message: { content: markerAnswer.slice(0, 13) }, done: false },
      { message: { content: markerAnswer.slice(13) }, done: false },
      { message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 44, eval_count: 88,
        load_duration: 10, prompt_eval_duration: 20, eval_duration: 30 },
    ].map((item) => `${JSON.stringify(item)}\n`).join("");
    return chunkedResponse([ndjson.slice(0, 9), ndjson.slice(9)], "application/x-ndjson");
  };
  const streamed = await translateWithLocalOpenAi(twentyFour, {
    ai: { provider: "ollama", model: "qwen", base_url: "http://localhost:11434",
      local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, canonicalPrompt,
  });
  assert.equal(streamed.translations.length, 24);
  assert.equal(streamed.translations[0].text, 'คำแปล 0 {"ok"}');
  assert.equal(streamed.meta.selectedContract, "tp.translation.compact-records/1");
  assert.equal(streamed.meta.streamMode, "ollama_ndjson");
  assert.ok(streamed.meta.streamChunks >= 1);
  assert.equal(batchBodies.length, 1);
  assert.equal(streamed.meta.batchCount, 1);
  assert.deepEqual(tokenSummary(streamed.meta.usage), { inputTokens: 44, outputTokens: 88, totalTokens: 132, source: "provider" });
  assert.ok(batchBodies.every((body) => body.think === false));

  // Initial translation is one provider generation per image regardless of
  // the image's unit count. A later repair is a distinct invocation and can
  // carry only its failed subset.
  for (const unitCount of [1, 10, 11, 32]) {
    let providerCalls = 0;
    globalThis.fetch = async () => {
      providerCalls += 1;
      const markerAnswer = Array.from({ length: unitCount }, (_, index) => `<<TP_P${index}:แปล ${index}>>`).join("\n");
      return chunkedResponse([
        `${JSON.stringify({ message: { content: markerAnswer }, done: true, done_reason: "stop" })}\n`,
      ], "application/x-ndjson");
    };
    const imageUnits = Array.from({ length: unitCount }, (_, index) => ({ id: `unit-${index}`, text: `source ${index}` }));
    const oneImage = await translateWithLocalOpenAi(imageUnits, {
      ai: { provider: "ollama", model: "qwen", base_url: "http://localhost:11434",
        local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, canonicalPrompt,
    });
    assert.equal(providerCalls, 1, `${unitCount} units in one image must use one provider request`);
    assert.equal(oneImage.translations.length, unitCount);
    assert.equal(oneImage.meta.batchCount, 1);
    assert.equal(oneImage.meta.providerAttempts, 1);
  }

  let repairCalls = 0;
  globalThis.fetch = async () => {
    repairCalls += 1;
    return chunkedResponse([
      `${JSON.stringify({ message: { content: "<<TP_P0:ซ่อมแล้ว>>" }, done: true, done_reason: "stop" })}\n`,
    ], "application/x-ndjson");
  };
  const repairedSubset = await translateWithLocalOpenAi([{ id: "failed-only", text: "source" }], {
    ai: { provider: "ollama", model: "qwen", base_url: "http://localhost:11434",
      local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, canonicalPrompt,
  });
  assert.equal(repairCalls, 1, "a subset repair invocation must use one new provider request");
  assert.deepEqual(repairedSubset.translations, [{ id: "failed-only", text: "ซ่อมแล้ว" }]);

  // OpenAI-compatible SSE has the same marker decoder and can split inside a
  // marker. The [DONE] sentinel is transport-only and never reaches parsing.
  globalThis.fetch = async () => chunkedResponse([
    'data: {"choices":[{"delta":{"content":"<<TP_"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"P0:สวัสดี>>"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ], "text/event-stream");
  const sse = await translateWithLocalOpenAi([{ id: "sse", text: "hello" }], {
    ai: { provider: "local-openai", model: "model", base_url: "http://localhost:1234/v1",
      local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt,
  });
  assert.deepEqual(sse.translations, [{ id: "sse", text: "สวัสดี" }]);
  assert.equal(sse.meta.streamMode, "openai_sse");

  // OpenAI-compatible providers may represent both delta and terminal message
  // content as typed part arrays. Preserve their text losslessly; never coerce
  // objects to the literal string "[object Object]".
  globalThis.fetch = async () => chunkedResponse([
    'data: {"choices":[{"delta":{"content":[{"type":"text","text":"<<TP_P0:"},"คำแปล",{"type":"image_url","image_url":{"url":"ignored"}}]}}]}\r\n\r\n',
    'data: {"choices":[{"message":{"content":[{"type":"text","text":">>"}]},"finish_reason":"stop"}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ], "text/event-stream");
  const sseParts = await translateWithLocalOpenAi([{ id: "sse-parts", text: "hello" }], {
    ai: { provider: "local-openai", model: "model", base_url: "http://localhost:1234/v1",
      local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt,
  });
  assert.deepEqual(sseParts.translations, [{ id: "sse-parts", text: "คำแปล" }]);
  assert.doesNotMatch(JSON.stringify(sseParts), /\[object Object\]/);

  // Malformed provider frames and explicit in-stream provider failures must
  // retain their transport identity instead of collapsing to marker errors.
  globalThis.fetch = async () => chunkedResponse([
    'data: {not-json}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ], "text/event-stream");
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "bad-sse", text: "hello" }], {
      ai: { provider: "local-openai", model: "model", base_url: "http://localhost:1234/v1",
        local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt,
    }),
    (error) => error.code === "provider_protocol_error" &&
      error.diagnostics?.malformedFrameSubtypes?.includes("invalid_sse_json"),
  );
  globalThis.fetch = async () => chunkedResponse([
    `${JSON.stringify({ error: { code: "model_runner_failed", message: "private detail omitted" } })}\n`,
  ], "application/x-ndjson");
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "ollama-error", text: "hello" }], {
      ai: { provider: "ollama", model: "qwen", base_url: "http://localhost:11434",
        local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, canonicalPrompt,
    }),
    (error) => error.code === "provider_protocol_error" &&
      error.diagnostics?.providerErrorCode === "model_runner_failed" &&
      !JSON.stringify(error).includes("private detail omitted"),
  );

  // Cancellation while reading a stream must remain immediate and must not be
  // converted into a model-output error.
  const duringStream = new AbortController();
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"message":{"thinking":"wait"}}\n'));
      init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      queueMicrotask(() => duringStream.abort());
    },
  }), { headers: { "Content-Type": "application/x-ndjson" } });
  const cancelledPromise = translateWithLocalOpenAi([{ id: "cancel", text: "x" }], {
    ai: { provider: "ollama", model: "qwen", base_url: "http://localhost:11434",
      local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, signal: duringStream.signal,
  });
  await assert.rejects(cancelledPromise, (error) => error.code === "cancelled");

  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "P0", text: "cancelled text" }], {
      ai: { provider: "ollama", model: "x", base_url: "http://localhost:11434/v1" },
      signal: alreadyCancelled.signal,
    }),
    (error) => error.code === "cancelled",
  );
  assert.equal(forbiddenFetches, 0, "a pre-cancelled request must never call fetch");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Direct Local AI transport tests passed: direct PC route, arbitrary models, no cloud key, one call, explicit errors.");
