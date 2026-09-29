import assert from "node:assert/strict";
import { localAiPreset, localProviderCatalog } from "../src/shared/ai/providers/local-registry.js";
import { discoverLocalModels } from "../src/shared/ai/direct-local/model-discovery.js";
import { ensureLocalAiBatchReady, clearLocalAiPreflightInflightForTest } from "../src/background/local-ai-preflight.js";
import { translateWithLocalOpenAi } from "../src/shared/ai/direct-local/generation.js";
import { getCanonicalPrompt } from "../src/background/ai/prompt-cache.js";

const originalFetch = globalThis.fetch;
const canonicalPrompt = await getCanonicalPrompt("Use natural Thai.", "th", { wantMemo: false });
const json = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" },
});
const storage = () => {
  const values = {};
  return {
    get: async (keys) => Object.fromEntries(keys.map((key) => [key, values[key]])),
    set: async (patch) => Object.assign(values, structuredClone(patch)),
  };
};

try {
  for (const spec of localProviderCatalog().filter((item) => item.id !== "ollama")) {
    const adapter = localAiPreset(spec.id);
    let gets = 0, posts = 0, body;
    globalThis.fetch = async (url, init = {}) => {
      const address = String(url);
      if ((init.method || "GET") === "GET") {
        gets++;
        if (address.endsWith("/api/v1/models")) {
          assert.equal(spec.id, "lmstudio", "native model types are LM Studio-specific");
          return json({ models: [{ key: "chat-a", type: "llm",
            capabilities:{reasoning:{allowed_options:['low','medium'],default:'medium'}},
            loaded_instances: [{id:'chat-a',config:{context_length:8192}}] },
            { key: "embed-a", type: "embedding", loaded_instances: [] }] });
        }
        assert.ok(address.endsWith("/models"));
        return json({ data: [{ id: "chat-a" }, { id: "embed-a" },
          ...(spec.id === "lmstudio" ? [{ id: "draft-a" }] : [])] });
      }
      posts++;
      assert.ok(address.endsWith(spec.id === 'lmstudio' ? '/api/v1/chat' : "/chat/completions"));
      body = JSON.parse(init.body);
      if(spec.id === 'lmstudio') return json({model_instance_id:'chat-a',
        output:[{type:'message',content:'<<TP_P0:สวัสดี>>'}],
        stats:{input_tokens:25,total_output_tokens:5,reasoning_output_tokens:0}});
      return json({ choices: [{ message: { content: "<<TP_P0:สวัสดี>>" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 25, completion_tokens: 5, total_tokens: 30 } });
    };
    const discovered = await discoverLocalModels(adapter, {
      provider: spec.id, model: "chat-a", verifySelected: true,
    });
    assert.equal(discovered.selectedModelVerification.status, "passed", spec.id);
    assert.equal(discovered.capability.models["chat-a"].generation.supported, null,
      `${spec.id}: listing is not proof of chat generation`);
    assert.equal(posts, 0, `${spec.id}: discovery cannot generate`);
    if (spec.id === "lmstudio") {
      assert.deepEqual(discovered.models, ["chat-a"], "LM Studio must omit a known embedding model");
      assert.deepEqual(discovered.selectableModels, ["chat-a"],
        "a draft-only OpenAI-list ID absent from native loaded LLMs is not selectable");
      const embedding = await discoverLocalModels(adapter, {
        provider: spec.id, model: "embed-a", verifySelected: true,
      });
      assert.equal(embedding.selectedModelVerification.status, "unsupported_model");
      const drafter = await discoverLocalModels(adapter, {
        provider: spec.id, model: "draft-a", verifySelected: true,
      });
      assert.equal(drafter.selectedModelVerification.status, "unsupported_model");
      assert.equal(posts, 0);
    }
    clearLocalAiPreflightInflightForTest();
    const store = storage();
    const ready = await ensureLocalAiBatchReady({
      aiProvider: spec.id, aiBaseUrl: adapter.baseUrl, aiModel: "chat-a",
      localAiAdapter: adapter, aiLocalThinking: spec.id === "lmstudio" ? "minimum" : "default",
    }, { get: store.get, set: store.set, emitTrace: () => {} });
    assert.equal(ready.audit.status, "passed", spec.id);
    assert.equal(ready.settings.aiModelCapabilities.generation.supported, null, spec.id);
    assert.equal(posts, 0, `${spec.id}: preflight cannot generate`);
    const request = {
      ai: { provider: spec.id, base_url: adapter.baseUrl, model: "chat-a",
        local_adapter: adapter, model_capabilities: ready.settings.aiModelCapabilities,
        prompt: "Use natural Thai.", promptMode: "replace",
        thinking: spec.id === "lmstudio" ? "minimum" : "default" },
      canonicalPrompt, targetLang: "th", sourceLang: "en",
    };
    if(spec.id !== "lmstudio") {
      await assert.rejects(
        translateWithLocalOpenAi([{ id: "P0", text: "Hello" }], {
          ...request, ai: {...request.ai, thinking:"off"},
        }),
        error => error?.code === "local_model_thinking_unsupported",
      );
      assert.equal(posts, 0, `${spec.id}: unverified Off must not dispatch`);
    }
    const answer = await translateWithLocalOpenAi([{ id: "P0", text: "Hello" }], request);
    assert.equal(answer.translations[0].text, "สวัสดี", spec.id);
    assert.equal(posts, 1, `${spec.id}: first real translation must issue one chat request`);
    if(spec.id === 'lmstudio') {
      assert.equal(body.reasoning,'low',
        'Lowest available resolves from this model metadata and does not force Thinking off');
      assert.equal(body.store,false);
      assert.ok(body.system_prompt && body.input);
    } else assert.ok(body.messages.some((message) => message.role === "system"));
    assert.ok(gets >= 2, `${spec.id}: discovery and preflight used actual metadata`);
  }
} finally { globalThis.fetch = originalFetch; }
console.log("Local 8-provider discovery → preflight → first translation passed with simulated endpoints.");
