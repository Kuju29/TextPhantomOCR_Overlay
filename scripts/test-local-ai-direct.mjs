import assert from "node:assert/strict";
import { assertNoDuplicateJsonKeys, discoverLocalModels, shouldUseDirectLocalAi, translateWithLocalOpenAi } from "../src/shared/local-ai-adapter.js";

assert.equal(shouldUseDirectLocalAi("extension", "ollama", "http://localhost:11434"), true);
assert.equal(shouldUseDirectLocalAi("api", "ollama", "http://localhost:11434"), false,
  "runs:API must remain API-owned even for a local provider");
assert.equal(shouldUseDirectLocalAi("extension", "gemini", "https://api.example.com"), false,
  "cloud AI in runs:Extension keeps the TextPhantom API route");

const originalFetch = globalThis.fetch;
const calls = [];
const canonicalPrompt = {
  version: "translation-plan-1",
  pieces: {
    systemBase: "SYSTEM BASE",
    editableStyle: "Target language: Thai\nBUILT-IN STYLE",
    imageHint: "IMAGE HINT",
    markerOutputContract: "MARKER CONTRACT",
    structuredOutputContract: "STRUCTURED CONTRACT",
    sourcePrefix: "Source (translate this):\n",
    seriesNotesHeading: "SERIES NOTES HEADING",
  },
};
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({
    choices: [{ message: { content: "<<TP_P0>>\nสวัสดี\n\n<<TP_P1>>\nโลก" } }],
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
  });
  assert.equal(calls.length, 1, "one image must make exactly one model request");
  assert.equal(calls[0].url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.credentials, "omit");
  assert.doesNotMatch(calls[0].init.body, /CLOUD-KEY-MUST-NOT-LEAK/);
  assert.equal(calls[0].body.model, "qwen2.5:14b-instruct-q4_K_M", "arbitrary Ollama model ids are preserved");
  assert.equal("temperature" in calls[0].body, false, "Local requests must use model defaults instead of forced sampling controls");
  assert.equal("options" in calls[0].body, false, "Ollama options must not be forced globally across arbitrary models");
  assert.deepEqual(answer.translations, [
    { id: "bubble-a", text: "สวัสดี" },
    { id: "bubble-b", text: "โลก" },
  ]);
  assert.equal(answer.meta.automaticTransportRetry, false);

  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ message: { content: JSON.stringify({
      translations: [{ id: "P0", text: "ทดสอบ" }], memo: "",
    }) } }), { status: 200 });
  };
  await translateWithLocalOpenAi([{ id: "style", text: "hello" }], {
    ai: {
      model: "qwen", base_url: "http://localhost:11434", prompt: "Target language: Thai\nMY COMPLETE STYLE",
      local_adapter: { version: 1, protocol: "ollama", baseUrl: "http://localhost:11434" },
    },
    canonicalPrompt,
  });
  assert.match(calls[0].body.messages[0].content, /SYSTEM BASE\n\nTarget language: Thai\nMY COMPLETE STYLE/);
  assert.doesNotMatch(calls[0].body.messages[0].content, /BUILT-IN STYLE|USER TRANSLATION NOTES/,
    "a full editable style replaces the built-in style exactly as on Cloud");
  assert.match(calls[0].body.messages[0].content, /STRUCTURED CONTRACT$/);
  assert.equal(calls[0].body.format.additionalProperties, false);
  assert.deepEqual(calls[0].body.format.required, ["translations", "memo"],
    "native Ollama receives its supported strict JSON schema format");
  assert.match(calls[0].body.messages[1].content, /^Source \(translate this\):\n<<TP_P0>>/);

  calls.length = 0;
  await translateWithLocalOpenAi([{ id: "style-edge", text: "hello" }], {
    ai: { model: "qwen", base_url: "http://localhost:11434", prompt: "Target languages: Thai edge policy" },
    canonicalPrompt,
  });
  assert.match(calls[0].body.messages[0].content, /SYSTEM BASE\n\nTarget languages: Thai edge policy/);
  assert.doesNotMatch(calls[0].body.messages[0].content, /BUILT-IN STYLE|SERIES NOTES HEADING/,
    "Local uses Python's exact startsWith target-language predicate without a word boundary");

  calls.length = 0;
  await translateWithLocalOpenAi([{ id: "notes", text: "hello" }], {
    ai: {
      model: "qwen", base_url: "http://localhost:11434", prompt: "Use the established nickname.",
      series_state: "The group reached town.",
      characters: [{ name: "Rey", gender: "unknown", speech: "blunt", note: "captain" }],
      glossary: [{ src: "Hi", tgt: "หวัดดี" }, { src: "Black Tower", tgt: "หอคอยดำ" }],
      prev_context: [{ src: "Where are we?", who: "Rey" }],
    },
    canonicalPrompt,
  });
  assert.match(calls[0].body.messages[0].content,
    /Target language: Thai\nBUILT-IN STYLE\n\nSERIES NOTES HEADING\nUse the established nickname\./,
    "short user guidance uses the same built-in-plus-series-notes policy as Cloud");
  assert.doesNotMatch(calls[0].body.messages[0].content, /USER TRANSLATION NOTES/);
  assert.match(calls[0].body.messages[0].content, /STORY SO FAR[\s\S]*CHARACTER SHEET[\s\S]*TRANSLATION MEMORY[\s\S]*PREVIOUS PAGE[\s\S]*STRUCTURED CONTRACT$/,
    "Local context uses Cloud semantic order before the transport-specific output contract");
  assert.doesNotMatch(calls[0].body.messages[0].content, /Hi → หวัดดี/,
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
      choices: [{ message: { content: JSON.stringify(invalid) } }],
    }), { status: 200 });
    await assert.rejects(
      translateWithLocalOpenAi([{ id: "a", text: "A" }, { id: "b", text: "B" }], {
        ai: { model: "qwen", base_url: "http://localhost:11434" }, canonicalPrompt,
      }),
      (error) => error.code === "invalid_model_output" && error.generationAttempts === 1,
      `structured Local output must reject ${invalid.name} wire entries without fallback`,
    );
  }
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: "<<TP_P0>>\nข้อความ" } }],
  }), { status: 200 });
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "a", text: "A" }], {
      ai: { model: "qwen", base_url: "http://localhost:11434" }, canonicalPrompt,
    }),
    (error) => error.code === "invalid_model_output",
    "canonical structured output must not silently fall back to marker parsing",
  );

  const rawDuplicateReplies = [
    '{"translations":[],"translations":[],"memo":""}',
    '{"translations":[{"id":"P0","id":"P0","text":"a"}],"memo":""}',
    '{"translations":[{"id":"P0","text":"a","text":"b"}],"memo":""}',
  ];
  for (const rawReply of rawDuplicateReplies) {
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: rawReply } }],
    }), { status: 200 });
    await assert.rejects(
      translateWithLocalOpenAi([{ id: "a", text: "A" }], {
        ai: { model: "qwen", base_url: "http://localhost:11434" }, canonicalPrompt,
      }),
      (error) => error.code === "invalid_model_output" && /duplicate key/.test(error.message),
      "duplicate raw JSON keys must be caught before JSON.parse overwrites them",
    );
  }
  assert.doesNotThrow(() => assertNoDuplicateJsonKeys(
    '{"outer":[{"id":"P0","text":"escaped \\\"id\\\":\\\"fake\\\""},{"id":"P1","nested":[1,{"id":"inner"}]}]}'
  ), "escaped key-looking text and keys in separate nested objects are not duplicate-key false positives");

  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '```json\n{"translations":[{"id":"P0","text":"ข้อความ"}],"memo":""}\n```' } }],
  }), { status: 200 });
  const fenced = await translateWithLocalOpenAi([{ id: "real", text: "source" }], {
    ai: { model: "qwen", base_url: "http://localhost:11434" }, canonicalPrompt,
  });
  assert.deepEqual(fenced.translations, [{ id: "real", text: "ข้อความ" }],
    "exactly one whole-response JSON fence is unwrapped like Cloud without prose guessing");

  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ message: { content: JSON.stringify({
      translations: [{ id: "P0", text: "ทดสอบ" }], memo: "",
    }) } }), { status: 200 });
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
      choices: [{ message: { content: '<<TP_P0>>\nทดสอบ' } }],
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
    message: { content: [{ type: "text", text: '<<TP_P0>>\nส่วนคำตอบ' }] }, done_reason: "stop",
  }), { status: 200 });
  const parts = await translateWithLocalOpenAi([{ id: "parts", text: "answer" }], {
    ai: { model: "qwen", base_url: "http://localhost:11434", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } },
  });
  assert.equal(parts.translations[0].text, "ส่วนคำตอบ", "native content parts must be joined as final output");

  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { content: "", thinking: "internal reasoning only" }, done_reason: "length",
  }), { status: 200 });
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "P0", text: "x" }], {
      ai: { model: "qwen", base_url: "http://localhost:11434", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } },
    }),
    (error) => error.code === "local_ai_thinking_no_answer" && /reasoning was produced/.test(error.message) && /length/.test(error.message),
    "thinking must be diagnostic only and never become translated text",
  );

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 });
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "P0", text: "x" }], {
      ai: { model: "missing", base_url: "http://localhost:11434" },
    }),
    (error) => error.code === "local_model_not_found" && error.retryable === false && error.generationAttempts === 1,
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
