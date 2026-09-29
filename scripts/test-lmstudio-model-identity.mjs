import assert from "node:assert/strict";
import { translateWithLocalOpenAi } from "../src/shared/ai/direct-local/generation.js";
import { getCanonicalPrompt } from "../src/background/ai/prompt-cache.js";
import { localAiPreset, resolveLocalProvider } from "../src/shared/ai/providers/local-registry.js";

const savedFetch = globalThis.fetch;
const canonicalPrompt = await getCanonicalPrompt("Use natural Thai.", "th", { wantMemo: false });
const request = (provider = "lmstudio", model = "selected") =>
  translateWithLocalOpenAi([{ id: "P0", text: "Hello" }], {
    ai: { provider, model, base_url: "http://localhost:1234/v1",
      local_adapter: { ...localAiPreset(provider), baseUrl: "http://localhost:1234/v1" },
      model_capabilities:provider === "lmstudio"
        ? {reasoning:{supported:true,supported_efforts:['off','on'],mandatory:false}}
        : {reasoning:{supported:false,control:'none'}},
      prompt: "Use natural Thai.", promptMode: "replace",
      thinking: provider === "lmstudio" ? "off" : "default",
      translation_mode: "independent", style_examples: false },
    canonicalPrompt, targetLang: "th", sourceLang: "en",
  });
const sse = (model) => `event: chat.start\ndata: ${JSON.stringify({ type:'chat.start',model_instance_id:model })}\n\n`;
const nativeEnd = model => `event: message.delta\ndata: ${JSON.stringify({type:'message.delta',content:'<<TP_P0:สวัสดี>>'})}\n\n`+
  `event: chat.end\ndata: ${JSON.stringify({type:'chat.end',result:{model_instance_id:model,
    output:[{type:'message',content:'<<TP_P0:สวัสดี>>'}],stats:{input_tokens:25,total_output_tokens:5,reasoning_output_tokens:0}}})}\n\n`;
const openAiSse = model => `data: ${JSON.stringify({model,choices:[{delta:{content:'<<TP_P0:สวัสดี>>'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`;

try {
  let cancelled = false, requested = "";
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/api\/v1\/chat$/);
    requested = JSON.parse(init.body).model;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(sse("other-model"))); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await assert.rejects(request(), error => {
    assert.equal(error.code, "local_model_identity_mismatch");
    assert.equal(error.providerResponded, true);
    assert.equal(error.generationAttempts, 1);
    assert.equal(error.retryable, false);
    assert.equal(error.diagnostics.requestedModel, "selected");
    assert.equal(error.diagnostics.reportedModel, "other-model");
    assert.match(error.message, /load and select the same model/i);
    return true;
  });
  assert.equal(requested, "selected", "the request must retain the selected model");
  assert.equal(cancelled, true, "reject the first wrong-model frame without waiting for an answer");
  const adapter = resolveLocalProvider(localAiPreset("lmstudio"), "lmstudio");
  const injectedModel = `other${"X".repeat(500)}\r\nsecret`;
  assert.throws(() => adapter.assertResponseModel({type:'chat.start',model_instance_id: injectedModel }, "selected"), error => {
    assert.equal(error.code, "local_model_identity_mismatch");
    assert.ok(error.message.length < 380);
    assert.ok(error.diagnostics.reportedModel.length <= 160);
    assert.doesNotMatch(error.message, /secret|\r|\n/);
    return true;
  });

  globalThis.fetch = async () => new Response(JSON.stringify({
    model_instance_id: "other-model", output: [{type:'message',content:'<<TP_P0:สวัสดี>>'}],
  }), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(request(), error => error.code === "local_model_identity_mismatch" &&
    error.diagnostics.reportedModel === "other-model", "non-stream fallback must reject too");

  globalThis.fetch = async () => new Response(`${sse("selected")}${nativeEnd("selected")}`,
    { status: 200, headers: { "content-type": "text/event-stream" } });
  const matching = await request();
  assert.deepEqual(matching.translations, [{ id: "P0", text: "สวัสดี" }]);

  // Other OpenAI-compatible services can return a canonical name for a
  // configured alias; this guard belongs only to LM Studio until evidenced.
  globalThis.fetch = async () => new Response(openAiSse('alias-target'),
    { status: 200, headers: { "content-type": "text/event-stream" } });
  const otherProvider = await request("jan");
  assert.deepEqual(otherProvider.translations, [{ id: "P0", text: "สวัสดี" }]);
} finally {
  globalThis.fetch = savedFetch;
}

console.log("PASS LM Studio checks returned model before accepting translation; other providers retain their contract.");
