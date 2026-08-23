import assert from "node:assert/strict";
import { discoverLocalModels, shouldUseDirectLocalAi, translateWithLocalOpenAi } from "../src/shared/local-ai-adapter.js";

assert.equal(shouldUseDirectLocalAi("extension", "ollama", "http://localhost:11434"), true);
assert.equal(shouldUseDirectLocalAi("api", "ollama", "http://localhost:11434"), false,
  "runs:API must remain API-owned even for a local provider");
assert.equal(shouldUseDirectLocalAi("extension", "gemini", "https://api.example.com"), false,
  "cloud AI in runs:Extension keeps the TextPhantom API route");

const originalFetch = globalThis.fetch;
const calls = [];
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
  const native = await translateWithLocalOpenAi([{ id: "real-id", text: "test" }], {
    ai: {
      model: "any/new-model:latest",
      base_url: "http://localhost:11434",
      api_key: "OTHER-CLOUD-KEY",
      local_adapter: { version: 1, protocol: "ollama", baseUrl: "http://localhost:11434" },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:11434/api/chat");
  assert.doesNotMatch(calls[0].init.body, /OTHER-CLOUD-KEY/);
  assert.deepEqual(native.translations, [{ id: "real-id", text: "ทดสอบ" }]);

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
