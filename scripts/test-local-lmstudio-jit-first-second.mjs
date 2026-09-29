import assert from "node:assert/strict";
import { ensureLocalAiBatchReady } from "../src/background/local-ai-preflight.js";
import { getCanonicalPrompt } from "../src/background/ai/prompt-cache.js";
import { appendPreparedMessages } from "../src/shared/ai/conversation/prompt.js";
import { translateWithLocalOpenAi } from "../src/shared/ai/direct-local/generation.js";
import { localAiPreset } from "../src/shared/ai/providers/local-registry.js";

const originalFetch = globalThis.fetch;
const model = "google/gemma-4-e4b";
const adapter = localAiPreset("lmstudio");
const endpoint = adapter.baseUrl;
const requests = [];
const readCounts = { compat: 0, native: 0 };
const turns = [];
const store = {};
let loaded = false;
let currentUser = "";
const events = (kind, value) => `event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...value })}\n\n`;
const conversationContext = {
  async prepare(input) {
    const history = turns.flatMap(turn => [
      { role: "user", text: turn.user, imageDataUri: "" },
      { role: "assistant", text: turn.answer },
    ]);
    currentUser = turns.length ? "<<I2_P0:Second source>>" : input.user;
    return {
      current: currentUser, history, image: "", layout: input.layout,
      evidence: { prefixSha256: "jit-fixture" }, origins: [],
      providerConversation: { enabled: true, historyTurns: turns.length,
        previousResponseId: turns.at(-1)?.responseId || "" },
    };
  },
  messages: appendPreparedMessages,
  capture(answer, responseId) { turns.push({ user: currentUser, answer, responseId }); },
};
try {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith("/api/v1/models")) {
      readCounts.native++;
      return Response.json({ models: [{ type: "llm", key: model,
        max_context_length: 32_768,
        loaded_instances: loaded ? [{ id: model, config: { context_length: 16_384 } }] : [],
        capabilities: { reasoning: { allowed_options: ["off", "on"], default: "on" } },
      }] });
    }
    if (path.endsWith("/v1/models")) {
      readCounts.compat++;
      return Response.json({ data: [{ id: model }] });
    }
    assert.equal(path, "http://localhost:1234/api/v1/chat");
    const body = JSON.parse(init.body);
    requests.push(body);
    const first = requests.length === 1;
    assert.equal(body.model, model);
    assert.equal(body.reasoning, "off", "Lowest uses the native model's verified Off option");
    assert.equal(body.store, true);
    if (first) assert.ok(Number.isSafeInteger(body.context_length) &&
      body.context_length >= 4096 && body.context_length < 16_384,
      "small cold request asks only for enough context, below the old fixed 16K allocation");
    else assert.equal(body.context_length, undefined,
      "the loaded instance owns the continuation context");
    assert.equal(body.previous_response_id, first ? undefined : "resp_jit_first");
    assert.equal(Boolean(body.system_prompt), first, "system prompt is sent only for a new thread");
    const answer = first ? "<<I1_P0:คำแปลหนึ่ง>>" : "<<I2_P0:คำแปลสอง>>";
    const responseId = first ? "resp_jit_first" : "resp_jit_second";
    loaded = true;
    return new Response(
      events("chat.start", { model_instance_id: model }) +
      (first ? events("model_load.start", { model_instance_id: model }) +
        events("model_load.end", { model_instance_id: model, load_time_seconds: 2 }) : "") +
      events("message.delta", { content: answer }) +
      events("chat.end", { result: { model_instance_id: model,
        output: [{ type: "message", content: answer }], response_id: responseId,
        stats: { input_tokens: first ? 1700 : 155, total_output_tokens: 24,
          reasoning_output_tokens: 0 } } }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };

  const settings = { aiProvider: "lmstudio", aiBaseUrl: endpoint, aiModel: model,
    aiLocalThinking: "minimum", localAiAdapter: adapter };
  const check = () => ensureLocalAiBatchReady(settings, {
    get: async () => store, set: async patch => Object.assign(store, patch), emitTrace: () => {},
  });
  const prompt = await getCanonicalPrompt("", "th", { wantMemo: false });
  const send = (id, source, capabilities) => translateWithLocalOpenAi([{ id, text: source }], {
    ai: { provider: "lmstudio", model, base_url: endpoint, local_adapter: adapter,
      prompt: "", translation_mode: "conversation", thinking: "minimum",
      model_capabilities: capabilities },
    canonicalPrompt: prompt, targetLang: "th", sourceLang: "en", conversationContext,
  });

  const cold = await check();
  assert.equal(cold.audit.availabilityStatus, "jit_loadable");
  assert.equal(cold.settings.aiModelCapabilities.limits.source, "lmstudio_native_jit_request");
  assert.equal(cold.settings.aiModelCapabilities.limits.runtimeContextTokens, undefined);
  assert.equal(requests.length, 0, "Connect/preflight performs no throw-away chat");
  const first = await send("I1_P0", "First source", cold.settings.aiModelCapabilities);
  assert.equal(first.translations[0].text, "คำแปลหนึ่ง");
  assert.equal(first.meta.contextPlan.contextVerified, false,
    "the first request records its context as requested, not pre-verified");

  const warm = await check();
  assert.equal(warm.audit.availabilityStatus, "passed");
  assert.equal(warm.settings.aiModelCapabilities.limits.runtimeContextTokens, 16_384,
    "second request uses the native loaded instance's measured window");
  const second = await send("I2_P0", "Second source", warm.settings.aiModelCapabilities);
  assert.equal(second.translations[0].text, "คำแปลสอง");
  assert.equal(requests.length, 2);
  assert.ok(readCounts.compat >= 2 && readCounts.native >= 2,
    "both requests were preceded by live native catalogue reads");
  assert.equal(requests[1].input, "<<I2_P0:Second source>>",
    "continuation sends only the current user text and a retained response ID");
} finally {
  globalThis.fetch = originalFetch;
}
console.log("PASS LM Studio cold JIT first real chat, exact instance, bounded context, refreshed second stateful request");
