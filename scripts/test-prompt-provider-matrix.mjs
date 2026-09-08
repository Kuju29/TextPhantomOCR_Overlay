import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getCanonicalPrompt } from "../src/background/ai/prompt-cache.js";
import { translateWithLocalOpenAi } from "../src/shared/ai/direct-local/generation.js";
import {
  localAiPreset,
  localProviderCatalog,
  parseLocalAiAdapterJson,
} from "../src/shared/ai/providers/local-registry.js";

const plan = await getCanonicalPrompt("", "th", { wantMemo: false });
const ocrOutputRule = "Correct missing, extra or misread characters only when the supplied text makes the intended reading unambiguous";
assert.equal(plan.pieces.systemPolicy.includes(ocrOutputRule), true,
  "the shared fixed system policy must distinguish mixed OCR input from target-language output");
const style = "Avoid pronouns unless the source makes them indispensable.";
const source = "  OCR source  ";
const expectedSystem = "You are an expert translator and localization editor. The following defines how you translate. Treat it as your own translation style and apply it naturally and consistently.\n\nTRANSLATION STYLE\n" + style;
// Capture the live API invocation boundary, not the legacy build_system_text helper.
const api = JSON.parse(execFileSync(process.env.PYTHON || "python", ["-c", `
import json
from unittest.mock import patch
from backend.ai import markers
from backend.ai.clients.base import ChatResult
from backend.ai.translation import invocation
from backend.ai.translation.contracts import AiConfig
calls=[]
def generate(request):
    calls.append(request)
    return ChatResult("<<TP_P0:คำแปล>>", "test-model", finish_reason="stop",
                      terminal_completed=True, terminal_evidence="stop")
adapter=invocation.provider_registry.require("lmstudio").adapter
with patch.object(type(adapter), "generate", side_effect=generate), patch.object(invocation, "assert_ai_base_url_allowed"):
    invocation._translate_once(markers.apply([${JSON.stringify(source)}]), "th", AiConfig(
        api_key="", provider="lmstudio", model="test-model", base_url="http://localhost:1234/v1",
        prompt_editable=${JSON.stringify(style)}, prompt_mode="replace", char_memory=False))
assert len(calls)==1
print(json.dumps({"system": calls[0].system_text, "user": calls[0].user_parts[0],
                  "schema": calls[0].response_schema}, ensure_ascii=False))
`], { cwd: fileURLToPath(new URL("../api", import.meta.url)), encoding: "utf8",
  env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));
const apiHeader = plan.pieces.targetLanguageInstruction + "\n";
assert.equal(api.system, expectedSystem.replace("TRANSLATION STYLE\n", "TRANSLATION STYLE\n" + apiHeader),
  "API retains its target header inside Style; Local removes that redundant header, but neither loses the style");
assert.equal(api.schema, null, "unknown model uses markers, not an invented schema capability");
const expectedUser = api.user;
assert.match(expectedUser, /^TRANSLATION TASK\nTranslate every source unit into Thai \(ภาษาไทย\)\./);
assert.equal(expectedUser.split("SOURCE TEXT\n")[1], `<<TP_P0:${source}>>`);
assert.match(expectedUser, /Expected IDs: P0\./);
function verifySections(messages, name) {
  assert.equal(messages[0].content, expectedSystem, `${name}: translator identity + exact style`);
  assert.equal(messages[1].content, expectedUser, `${name}: live API and Local task/source/ID parity`);
  assert.equal(messages[0].content.split(style).length - 1, 1);
  assert.equal(messages[1].content.includes(style), false);
  assert.equal(messages[0].content.includes(plan.pieces.sourceInputContract), false);
  assert.equal(messages[1].content.split(plan.pieces.sourceInputContract).length - 1, 1);
  assert.equal(messages[1].content.split("OUTPUT — tp.translation.compact-records/1").length - 1, 1);
  assert.equal(messages[0].content.includes(plan.pieces.systemPolicy), false,
    `${name}: retired verbose system composition must not leak into the live identity`);
}

const originalFetch = globalThis.fetch;
try {
  for (const spec of localProviderCatalog()) {
    const calls = [];
    const wire = new Map();
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body });
      const reply = spec.protocol === "ollama"
        ? { message: { content: "<<TP_P0:คำแปล>>" }, done: true, done_reason: "stop" }
        : { choices: [{ finish_reason: "stop", message: { content: "<<TP_P0:คำแปล>>" } }] };
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    await translateWithLocalOpenAi([{ id: "unit", text: source }], {
      ai: {
        provider: spec.id,
        model: "test-model",
        base_url: spec.baseUrl,
        local_adapter: localAiPreset(spec.id),
        prompt: style,
        promptMode: "replace",
        thinking: "off",
      },
      canonicalPrompt: plan,
      targetLang: "th",
      wireTrace: async (event, value) => wire.set(event, value),
    });
    assert.equal(calls.length, 1, `${spec.id} dispatches exactly once`);
    const messages = calls[0].body.messages;
    assert.equal(messages.length, 2, `${spec.id} has one system and one user message`);
    assert.equal(messages[0].role, "system");
    assert.equal(messages[1].role, "user");
    assert.equal(messages[0].content, expectedSystem);
    assert.equal(messages[1].content, expectedUser);
    assert.equal(wire.get("systemPrompt"), messages[0].content,
      `${spec.id}: trace system is byte-identical to the native provider system message`);
    assert.equal(wire.has("stylePrompt"), false,
      `${spec.id}: no separate style trace exists outside the final wire system`);
    verifySections(messages, spec.id);
  }

  const custom = parseLocalAiAdapterJson(JSON.stringify({
    version: 1,
    protocol: "openai",
    translationContract: "v1",
    baseUrl: "http://localhost:9999/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    modelsResponsePath: "data.*.id",
    chatResponsePath: "choices.0.message.content",
    thinking: null,
  }));
  assert.equal(custom.protocol, "openai", "custom Local mapping remains explicit");
  assert.equal(custom.chatPath, "/chat/completions");

  const customOllama = parseLocalAiAdapterJson(JSON.stringify({
    version: 1,
    protocol: "ollama",
    translationContract: "v1",
    baseUrl: "http://localhost:9998",
    modelsPath: "/api/tags",
    chatPath: "/api/chat",
    modelsResponsePath: "models.*.name",
    chatResponsePath: "message.content",
    thinking: { parameter: "think", off: false, on: true },
  }));
  for (const variant of [
    { name: "custom-openai", provider: "local-openai", adapter: custom },
    { name: "custom-ollama", provider: "", adapter: customOllama },
  ]) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body });
      const reply = variant.adapter.protocol === "ollama"
        ? { message: { content: "<<TP_P0:คำแปล>>" }, done: true, done_reason: "stop" }
        : { choices: [{ finish_reason: "stop", message: { content: "<<TP_P0:คำแปล>>" } }] };
      return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    await translateWithLocalOpenAi([{ id: "unit", text: source }], {
      ai: { provider: variant.provider, model: "custom-model",
        base_url: variant.adapter.baseUrl, local_adapter: variant.adapter,
        prompt: style, promptMode: "replace", thinking: "off" },
      canonicalPrompt: plan, targetLang: "th",
    });
    assert.equal(calls.length, 1, `${variant.name} dispatches exactly once`);
    const messages = calls[0].body.messages;
    assert.equal(messages[0].content, expectedSystem);
    assert.equal(messages[1].content, expectedUser);
    verifySections(messages, variant.name);
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Provider prompt matrix passed: every Direct Local identity preserves one exact system/style contract and the same live API task/source/ID user payload (with documented style-header normalization).");
