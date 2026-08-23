import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { localAiPreset, normalizeLocalAiAdapter, parseLocalAiAdapterJson } from "../src/shared/local-ai-config.js";

for (const provider of ["ollama", "lmstudio", "localai", "jan", "textgen", "vllm", "llamacpp"]) {
  const adapter = normalizeLocalAiAdapter(localAiPreset(provider), { provider });
  assert.equal(adapter.protocol, "openai");
  assert.match(adapter.baseUrl, /^http:\/\/(?:localhost|127\.|10\.|192\.168\.)/);
  assert.equal(adapter.chatResponsePath, "choices.0.message.content");
}

const nativeOllama = parseLocalAiAdapterJson(JSON.stringify({
  version: 1, protocol: "ollama", baseUrl: "http://127.0.0.1:11434",
  modelsPath: "/api/tags", chatPath: "/api/chat",
  modelsResponsePath: "models.*.name", chatResponsePath: "message.content",
}));
assert.equal(nativeOllama.protocol, "ollama");

for (const bad of [
  { version: 1, protocol: "openai", baseUrl: "https://api.example.com/v1" },
  { version: 1, protocol: "openai", baseUrl: "http://user:secret@localhost:8000/v1" },
  { version: 1, protocol: "openai", baseUrl: "http://localhost:8000/v1", headers: { Authorization: "secret" } },
  { version: 1, protocol: "javascript", baseUrl: "http://localhost:8000" },
  { version: 1, protocol: "openai", baseUrl: "http://localhost:8000", chatPath: "/../admin" },
]) assert.throws(() => parseLocalAiAdapterJson(JSON.stringify(bad)));

const apiProviderConfig = await readFile(new URL("../api/backend/ai/config.py", import.meta.url), "utf8");
const popupDom = await readFile(new URL("../src/popup/dom.js", import.meta.url), "utf8");
const popupHtml = await readFile(new URL("../src/popup/popup.html", import.meta.url), "utf8");
assert.match(popupDom, /aiBaseUrl\.readOnly\s*=\s*provider === "customlocal"/,
  "Custom Local must expose JSON as its only editable endpoint authority");
assert.ok(
  popupHtml.indexOf('id="ai-model-wrap"') < popupHtml.indexOf('id="ai-local-unlimited-wrap"') &&
    popupHtml.indexOf('id="ai-local-unlimited-wrap"') < popupHtml.indexOf('id="ai-thinking-wrap"'),
  "Local AI unlimited must sit directly under Model, before the next AI section",
);
assert.match(popupDom, /aiLocalUnlimitedWrap\.style\.display\s*=\s*showAi && local/,
  "Local AI unlimited must stay hidden for cloud providers and non-AI sources");
assert.match(popupDom, /canConfigureAi && provider === "gemini"/,
  "AI thinking must be visible only where Gemini thinkingConfig is implemented");
assert.match(popupHtml, /Extension \+ Local AI it goes directly to your PC/,
  "page-image guidance must describe the real direct Local route");
assert.match(popupDom, /insertBefore\(el, els\.aiLocalUnlimitedWrap\)/,
  "Model validation must render before Local AI pacing controls");
assert.match(popupHtml, /The URL chooses the Local AI server; the Model chooses which installed model/,
  "Local UI must explain why both endpoint and model are required");
const popupSource = await readFile(new URL("../src/popup/popup.js", import.meta.url), "utf8");
assert.match(popupSource, /aiLocalModelId\.value = savedExactLocalModel\(\)/,
  "saved exact Local model ID must be restored when the popup reopens");
assert.match(popupSource, /setFieldMessage\(els\.aiModelWrap, "info", `✓ \$\{models\.length\} model\(s\) loaded/,
  "a successful explicit connection must replace a stale Model warning");
assert.match(popupSource, /provider !== previousProvider \? \{ aiModel: "auto" \}/,
  "changing providers must not reuse a model ID from the previous runtime");
const providerChange = popupSource.slice(
  popupSource.indexOf('els.aiProvider?.addEventListener("change"'),
  popupSource.indexOf('els.aiBaseUrl?.addEventListener("input"'),
);
assert.ok(
  providerChange.indexOf("state.aiMetaSeq += 1") < providerChange.indexOf("await getStorage"),
  "provider change must invalidate an in-flight old-provider discovery before its first await",
);
assert.ok(
  providerChange.indexOf("clearTimeout(aiDebounce)") < providerChange.indexOf("await getStorage"),
  "provider change must cancel a pending old-model save before its first await",
);
assert.match(apiProviderConfig, /"llamacpp":\s*\{"model"/,
  "the built-in llama.cpp choice must have an API-engine default");
assert.match(apiProviderConfig, /LOCAL_PROVIDERS[\s\S]*?"llamacpp"/,
  "llama.cpp must stay keyless on the API engine too");
assert.match(apiProviderConfig, /PROVIDER_PROTOCOLS[\s\S]*?"llamacpp":\s*"openai_chat_completions"/,
  "llama.cpp must stay wired to the API OpenAI-compatible client");

console.log("Local AI config test passed: presets and custom JSON stay local, declarative and credential-free.");
