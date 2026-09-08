import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { delimiter } from "node:path";
import { localAiPreset, normalizeLocalAiAdapter, parseLocalAiAdapterJson, serializeLocalAiAdapter, localProviderCatalog, localProviderSpec } from "../src/shared/ai/providers/local-registry.js";

const catalog = localProviderCatalog();
assert.equal(catalog.length, 10);
assert.equal(new Set(catalog.map((spec) => spec.id)).size, catalog.length, "provider IDs must be unique");
for (const spec of catalog) {
  assert.ok(spec.displayName && spec.baseUrl && spec.modelsPath && spec.chatPath && spec.auth && spec.capacity);
  assert.equal(typeof spec.create, "function", `${spec.id} owns its protocol adapter binding`);
  assert.equal(localProviderSpec(spec.id), spec, `${spec.id} has one canonical registry object`);
}
for (const spec of catalog.filter((item) => item.id !== "ollama"))
  assert.equal(spec.thinking, null,
    `${spec.id} must not inherit an unverified generic OpenAI-compatible thinking field`);
const reloaded = await import(`../src/shared/ai/providers/local-registry.js?reload=${Date.now()}`);
assert.deepEqual(reloaded.localProviderCatalog().map((spec) => spec.id), catalog.map((spec) => spec.id));
const providerFiles = (await readdir(new URL("../src/shared/ai/providers/", import.meta.url)))
  .filter((name) => /^local-(?!registry|spec|transport-runtime|openai-compatible).*\.js$/.test(name));
assert.equal(providerFiles.length, 10, "every named Local AI provider must have one leaf module");
for (const leaf of providerFiles) {
  const source = await readFile(new URL(`../src/shared/ai/providers/${leaf}`, import.meta.url), "utf8");
  assert.doesNotMatch(source, /defineLocalProvider\(\{[^\n]+\}\)/, `${leaf} must remain maintainable provider-owned metadata`);
}

for (const provider of ["ollama", "lmstudio", "localai", "jan", "textgen", "vllm", "llamacpp"]) {
  const adapter = normalizeLocalAiAdapter(localAiPreset(provider), { provider });
  assert.equal(adapter.protocol, provider === "ollama" ? "ollama" : "openai");
  assert.match(adapter.baseUrl, /^http:\/\/(?:localhost|127\.|10\.|192\.168\.)/);
  assert.equal(adapter.chatResponsePath, provider === "ollama" ? "message.content" : "choices.0.message.content");
  assert.equal(adapter.translationContract, "v2", `${provider} defaults to the source-associated contract`);
}

const migratedOllama = normalizeLocalAiAdapter({
  version: 1, protocol: "openai", baseUrl: "http://localhost:11434/v1",
  modelsPath: "/models", chatPath: "/chat/completions",
  modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content",
}, { provider: "ollama" });
assert.deepEqual(migratedOllama, localAiPreset("ollama"), "legacy Ollama /v1 config migrates to native endpoints");

const nativeOllama = parseLocalAiAdapterJson(JSON.stringify({
  version: 1, protocol: "ollama", baseUrl: "http://127.0.0.1:11434",
  modelsPath: "/api/tags", chatPath: "/api/chat",
  modelsResponsePath: "models.*.name", chatResponsePath: "message.content",
}));
assert.equal(nativeOllama.protocol, "ollama");
assert.equal(nativeOllama.translationContract, "v2");

for (const protocol of ["ollama", "openai"]) {
  const explicitV1 = normalizeLocalAiAdapter({
    version: 1, protocol, translationContract: "v1",
    baseUrl: protocol === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1",
  });
  const roundTripped = parseLocalAiAdapterJson(serializeLocalAiAdapter(explicitV1));
  assert.equal(roundTripped.translationContract, "v1", `${protocol} explicit v1 must survive storage JSON`);
  assert.equal(roundTripped.protocol, protocol);
}
assert.throws(() => normalizeLocalAiAdapter({
  version: 1, protocol: "ollama", translationContract: "legacy-auto", baseUrl: "http://localhost:11434",
}), /translationContract must be v1 or v2/);

const explicitThinking = parseLocalAiAdapterJson(JSON.stringify({
  version: 1, protocol: "openai", baseUrl: "http://localhost:1234/v1",
  modelsPath: "/models", chatPath: "/chat/completions",
  modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content",
  thinking: { parameter: "reasoning_effort", off: "none", on: "medium" },
}));
assert.deepEqual(explicitThinking.thinking,
  { parameter: "reasoning_effort", off: "none", on: "medium" });
assert.throws(() => parseLocalAiAdapterJson(JSON.stringify({
  version: 1, protocol: "openai", baseUrl: "http://localhost:1234/v1",
  thinking: { parameter: "model", off: "none", on: "medium" },
})));

for (const bad of [
  { version: 1, protocol: "openai", baseUrl: "https://api.example.com/v1" },
  { version: 1, protocol: "openai", baseUrl: "http://user:secret@localhost:8000/v1" },
  { version: 1, protocol: "openai", baseUrl: "http://localhost:8000/v1", headers: { Authorization: "secret" } },
  { version: 1, protocol: "javascript", baseUrl: "http://localhost:8000" },
  { version: 1, protocol: "openai", baseUrl: "http://localhost:8000", chatPath: "/../admin" },
]) assert.throws(() => parseLocalAiAdapterJson(JSON.stringify(bad)));

const popupDom = await readFile(new URL("../src/popup/dom.js", import.meta.url), "utf8");
const popupHtml = await readFile(new URL("../src/popup/popup.html", import.meta.url), "utf8");
assert.match(popupDom, /aiBaseUrl\.readOnly\s*=\s*provider === "customlocal"/,
  "Custom Local must expose JSON as its only editable endpoint authority");
assert.doesNotMatch(popupHtml, /ai-local-unlimited|Remove time\/RPM delays for this local AI/,
  "Local AI must not expose a pacing preference");
assert.doesNotMatch(popupDom, /aiLocalUnlimited/,
  "Local pacing must not depend on popup state");
assert.match(popupDom, /aiLocalCapacityWrap\.style\.display\s*=\s*showAi && local/,
  "Local capacity must stay hidden for cloud providers and non-AI sources");
assert.match(popupHtml, /id="ai-local-capacity-mode"[\s\S]*value="auto"[\s\S]*value="safe"[\s\S]*value="manual"/,
  "Local capacity must expose Auto, Safe and Manual without changing cloud controls");
assert.doesNotMatch(popupDom, /provider === "gemini"/,
  "popup capability rendering must not recognize provider names");
assert.doesNotMatch(popupDom, /cloudProviderSpec\(provider\)\?\.thinkingControl/,
  "a provider-wide protocol flag must not promise that the selected cloud model supports thinking");
assert.match(popupDom, /Thinking control is unavailable until this exact model is verified/,
  "thinking stays hidden until an exact model capability is available");
assert.equal(localProviderSpec("ollama").thinking.parameter, "think",
  "native Ollama must own its supported thinking control");
const directGeneration = await readFile(new URL("../src/shared/ai/direct-local/generation.js", import.meta.url), "utf8");
assert.doesNotMatch(directGeneration, /ollama/i,
  "neutral Local generation must not contain provider identity or provider-specific reasons");
assert.match(await readFile(new URL("../src/shared/ai/providers/local-ollama.js", import.meta.url), "utf8"),
  /incompleteUsageReason[\s\S]*ollama_terminal_drain_timeout/,
  "Ollama must own its terminal-drain usage reason");
const popupUi = await readFile(new URL("../src/popup/controllers/popup-ui-controller.js", import.meta.url), "utf8");
assert.match(popupUi, /localCapability\?\.models\?\.\[model\]\?\.reasoning/,
  "Local thinking visibility must come from the exact discovered model, not only its runtime protocol");
assert.match(popupUi, /resolvedModel !== model/,
  "Cloud thinking visibility must reject a stale capability from another model");
const { reasoningCapabilityForSelection } = await import(new URL(
  "../src/popup/controllers/popup-ui-controller.js", import.meta.url));
const optionalReasoning = { supported: true, mandatory: false };
assert.equal(reasoningCapabilityForSelection({
  local: false, provider: "openrouter", model: "model-b", credential: "key-b",
  resolvedCredential: "key-b", resolved: {
    provider: "openrouter", model: "model-a",
    model_capabilities: { reasoning: optionalReasoning },
  },
}), null, "a late capability for model A must never enable Thinking for model B");
assert.equal(reasoningCapabilityForSelection({
  local: false, provider: "openrouter", model: "model-a", credential: "key-b",
  resolvedCredential: "key-a", resolved: {
    provider: "openrouter", model: "model-a",
    model_capabilities: { reasoning: optionalReasoning },
  },
}), null, "capabilities are account-scoped and must not cross API-key changes");
assert.deepEqual(reasoningCapabilityForSelection({
  local: true, provider: "ollama", model: "qwen", localCapability: {
    models: { qwen: { reasoning: optionalReasoning } },
  },
}), optionalReasoning, "Local Thinking is enabled only by the selected discovered model");
const selectedCapability = { provider: "ollama", baseUrl: "http://localhost:11434", protocol: "ollama",
  models: { selected: { reasoning: { supported: true, control: "boolean" } } } };
for (const selection of [
  { provider: "ollama", model: "other", baseUrl: "http://localhost:11434" },
  { provider: "ollama", model: "selected", baseUrl: "http://localhost:11435" },
  { provider: "lmstudio", model: "selected", baseUrl: "http://localhost:11434" },
]) assert.equal(reasoningCapabilityForSelection({ local: true, localCapability: selectedCapability, ...selection }), null,
  "model/provider/endpoint changes cannot reuse stale thinking support");
const { createPopupUiController } = await import(new URL(
  "../src/popup/controllers/popup-ui-controller.js", import.meta.url));
const thinkingEls = {
  aiProvider: { value: "ollama" }, aiBaseUrl: { value: "http://localhost:11434" }, aiModel: { value: "selected" },
  mode: { value: "lens_text" }, sources: { value: "ai" }, aiThinkingWrap: { style: {} },
  aiThinking: { value: "off", options: ["off", "on"].map((value) => ({ value })) }, aiThinkingHint: {},
};
const thinkingState = { localAiCapability: selectedCapability };
const thinkingUi = createPopupUiController({ els: thinkingEls, state: thinkingState, isLocalProvider: () => true,
  toggleDom: () => {}, updatePromptWarning: () => {}, validateAiKey: () => {}, validateLangSource: () => {} });
thinkingUi.toggle();
assert.equal(thinkingEls.aiThinking.disabled, false);
assert.equal(thinkingEls.aiThinkingWrap.style.display, "");
selectedCapability.models.selected.reasoning = { supported: false, control: "none" };
thinkingUi.toggle();
assert.equal(thinkingEls.aiThinkingWrap.style.display, "none",
  "models without thinking support must not show a fake binary control");
selectedCapability.models.selected.reasoning = { supported: true, mandatory: true, control: "levels" };
thinkingUi.toggle();
assert.equal(thinkingEls.aiThinkingWrap.style.display, "none",
  "level-only reasoning must not be misrepresented as On/Off");
thinkingEls.aiModel.value = "other";
thinkingUi.toggle();
assert.equal(thinkingEls.aiThinkingWrap.style.display, "none",
  "unknown model capability stays hidden until exact verification");

const geminiReasoning = { supported: true, mandatory: false, default_enabled: true, dynamic: true, control: "toggle" };
const cloudThinkingEls = {
  aiProvider: { value: "gemini" }, aiBaseUrl: { value: "" }, aiModel: { value: "gemini-2.5-flash" },
  aiKey: { value: "AIza-fixture" }, mode: { value: "lens_text" }, sources: { value: "ai" },
  aiThinkingWrap: { style: {} }, aiThinking: { value: "off", options: ["off", "on"].map((value) => ({ value })) },
  aiThinkingHint: {},
};
const cloudThinkingState = { lastAiResolve: { provider: "gemini", model: "gemini-2.5-flash",
  model_capabilities: { reasoning: geminiReasoning } }, lastResolvedKey: "AIza-fixture" };
const cloudThinkingUi = createPopupUiController({ els: cloudThinkingEls, state: cloudThinkingState, isLocalProvider: () => false,
  toggleDom: () => {}, updatePromptWarning: () => {}, validateAiKey: () => {}, validateLangSource: () => {} });
cloudThinkingUi.toggle();
assert.equal(cloudThinkingEls.aiThinkingWrap.style.display, "",
  "Gemini 2.5 Flash must expose AI thinking after exact-model capability discovery");
assert.equal(cloudThinkingEls.aiThinking.disabled, false);
assert.match(cloudThinkingEls.aiThinkingHint.textContent, /Off by default.*Turn it On/i);
cloudThinkingState.lastAiResolve.model_capabilities.reasoning = { supported: true, mandatory: true, default_enabled: true, dynamic: true, control: "toggle" };
cloudThinkingUi.toggle();
assert.equal(cloudThinkingEls.aiThinking.options.find((option) => option.value === "off").disabled, true,
  "a mandatory-thinking model must not present Off as a usable choice");
cloudThinkingState.lastAiResolve.model_capabilities.reasoning = { supported: true, mandatory: true, default_enabled: true, dynamic: true, control: "levels" };
cloudThinkingUi.toggle();
assert.equal(cloudThinkingEls.aiThinkingWrap.style.display, "none",
  "level-only Cloud reasoning must not expose the binary Thinking selector");
assert.match(popupHtml, /Thinking off \(recommended for translation\)/,
  "Local translation guidance must default thinking off");
const thinkingSelectHtml = popupHtml.match(/<select id="ai-thinking"[\s\S]*?<\/select>/i)?.[0] || "";
assert.doesNotMatch(thinkingSelectHtml, /option value="(?:default|auto)"/i,
  "Thinking Auto/Default must not be present in the Thinking selector");
assert.match(popupHtml, /For vision models\. Uses more time and memory/,
  "page-image guidance stays short and capability-focused");
assert.match(popupHtml, /Reconnect after changing models\. Use a model your PC can handle, or translation may fail or hang\./,
  "Local UI must warn that a model change needs reconnect and hardware-fit matters");
const popupSource = await readFile(new URL("../src/popup/popup.js", import.meta.url), "utf8");
const popupEvents = await readFile(new URL("../src/popup/controllers/popup-event-controller.js", import.meta.url), "utf8");
const localConnection = await readFile(new URL("../src/popup/controllers/local-connection-controller.js", import.meta.url), "utf8");
const localCapacity = await readFile(new URL("../src/popup/controllers/local-capacity-controller.js", import.meta.url), "utf8");
assert.match(popupEvents, /try\s*\{[\s\S]*await pendingEdits[\s\S]*transition = profileController\.beginProviderTransition/,
  "pending edits and Provider transition creation must share the popup error boundary");
assert.match(popupEvents, /setProviderTransitionPending\(true\)[\s\S]*finally\s*\{[\s\S]*setProviderTransitionPending\(false\)/,
  "translation/provider controls must remain disabled until transition settlement");
const settingsSource = await readFile(new URL("../src/shared/settings.js", import.meta.url), "utf8");
assert.match(localConnection, /const saved = savedModel\(\)[\s\S]*aiLocalModelId\.value = saved/,
  "saved exact Local model ID must be restored when the popup reopens");
assert.match(localConnection, /selectedModelVerification[\s\S]*?verification\.status === "passed"/,
  "a successful explicit connection must require a verified selected model");
assert.match(localConnection, /state\.localAiCapability\s*=\s*[\s\S]*?response\.capability/,
  "Local discovery capability must be retained for the selected-model hint");
assert.doesNotMatch(popupSource, /\bisLocalProvider\(/,
  "popup must use its imported local-provider predicate instead of an undefined helper");
assert.match(localCapacity, /aiLocalCapabilityHint: value/,
  "the exact selected runtime/model capability must survive popup closure");
assert.match(settingsSource, /"aiLocalCapabilityHint"/,
  "the service worker settings reader must load the persisted capability hint");
assert.match(localCapacity, /max \$\{Math\.max\(1, Number\(hint\.recommendedMax\) \|\| 1\)\}/,
  "the runtime/model recommendation must be visible without silently changing Manual capacity");
assert.match(localCapacity, /const clear[\s\S]*aiLocalCapabilityHint: null/,
  "provider and endpoint changes must be able to clear stale in-memory and stored capability hints");
assert.match(localConnection, /sequence !== state\.localConnectSeq[\s\S]*identity\(\) !== requestIdentity/,
  "Connect must reject a response from an obsolete provider or endpoint");
const connectHandler = localConnection.slice(localConnection.indexOf("const connect = async"), localConnection.indexOf("const saveCustomAdapter"));
assert.match(connectHandler, /state\.localAiCapability\s*=\s*[\s\S]*?response\.capability/,
  "the explicit Connect path must retain returned runtime capability");
assert.match(connectHandler, /await persistCapacity\(\)/,
  "the explicit Connect path must persist the selected model hint");
const exactModelHandler = localConnection.slice(localConnection.indexOf("const selectExactModel"), localConnection.indexOf("const bind ="));
assert.match(exactModelHandler, /renderCapacity\(\)/,
  "typing an exact Local model must update its visible capacity hint");
assert.match(exactModelHandler, /persistCapacity\(\)/,
  "typing an exact Local model must persist its matching capacity hint");
assert.match(popupEvents, /provider !== previousProvider[\s\S]*?state\.desiredAiModel = "auto"/,
  "changing providers must not reuse a model ID from the previous runtime");
const providerChange = popupEvents.slice(
  popupEvents.indexOf('els.aiProvider?.addEventListener("change"'),
  popupEvents.indexOf('els.aiBaseUrl?.addEventListener("input"'),
);
assert.ok(
  providerChange.indexOf("state.aiMetaSeq += 1") < providerChange.indexOf("await transition.commit"),
  "provider change must invalidate an in-flight old-provider discovery before its first await",
);
assert.ok(
  providerChange.indexOf("state.pendingAiSave = false") < providerChange.indexOf("await transition.commit"),
  "provider change must cancel a pending old-model save before its first await",
);
assert.ok(
  providerChange.indexOf("toggleUi();") < providerChange.indexOf("await transition.commit"),
  "provider-dependent controls must render before persistence begins",
);
assert.match(providerChange, /setProviderTransitionPending\(true\)[\s\S]*await transition\.commit[\s\S]*setProviderTransitionPending\(false\)/,
  "translation and provider controls must stay blocked throughout a pending switch");
const apiRoot = fileURLToPath(new URL("../api/", import.meta.url));
const registryProbe = [
  "import json",
  "import backend.ai.providers",
  "from backend.ai.provider_bootstrap import ensure_provider_registry",
  "from backend.ai.provider_registry import provider_registry",
  "ensure_provider_registry()",
  "spec = provider_registry.require('llamacpp')",
  "peer = provider_registry.require('lmstudio')",
  "policy = spec.adapter.policy",
  "print(json.dumps({'provider': spec.provider_id, 'model': spec.default_model, 'base_url': spec.default_base_url, 'local': spec.local, 'key_prefixes': list(spec.key_prefixes), 'protocol': spec.protocol, 'adapter': type(spec.adapter).__name__, 'distinct_adapter': spec.adapter is not peer.adapter, 'policy_provider': policy.provider_id, 'policy_aliases': list(policy.aliases), 'policy_model': policy.default_model, 'policy_base_url': policy.default_base_url, 'auth_optional': policy.auth_optional, 'thinking_field': policy.thinking_field, 'output_token_ceiling': policy.output_token_ceiling, 'append_path': policy.append_path, 'completion_path': policy.completion_path, 'discovery_path': policy.discovery_path}, sort_keys=True))",
].join(";");
const llamaCppSpec = JSON.parse(execFileSync(process.env.PYTHON || "python", ["-c", registryProbe], {
  cwd: apiRoot,
  encoding: "utf8",
}));
execFileSync(process.env.PYTHON || "python", [
  fileURLToPath(new URL("./test-ai-thinking-reporting.py", import.meta.url)),
], { cwd: apiRoot, env: { ...process.env, PYTHONPATH: [apiRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter) }, stdio: "inherit" });
assert.equal(llamaCppSpec.provider, "llamacpp",
  "llama.cpp must be registered under its canonical provider ID");
assert.equal(llamaCppSpec.model, "local-model",
  "the built-in llama.cpp choice must have an API-engine default model");
assert.equal(llamaCppSpec.base_url, "http://localhost:8080/v1",
  "llama.cpp must retain its provider-owned local endpoint");
assert.equal(llamaCppSpec.local, true,
  "llama.cpp must remain classified as a Local AI provider");
assert.deepEqual(llamaCppSpec.key_prefixes, [],
  "llama.cpp must stay keyless on the API engine too");
assert.equal(llamaCppSpec.protocol, "openai_chat_completions",
  "llama.cpp must stay wired to the API OpenAI-compatible protocol");
assert.equal(llamaCppSpec.adapter, "LocalOpenAIChatAdapter",
  "llama.cpp must use the policy-bound local OpenAI-chat adapter");
assert.equal(llamaCppSpec.distinct_adapter, true,
  "llama.cpp must own a distinct adapter instance rather than sharing another provider's adapter");
assert.equal(llamaCppSpec.policy_provider, "llamacpp");
assert.deepEqual(llamaCppSpec.policy_aliases, ["llama.cpp", "llama-cpp"]);
assert.equal(llamaCppSpec.policy_model, "local-model");
assert.equal(llamaCppSpec.policy_base_url, "http://localhost:8080/v1");
assert.equal(llamaCppSpec.auth_optional, false);
assert.equal(llamaCppSpec.thinking_field, null,
  "OpenAI-compatible does not imply llama.cpp accepts a generic think field");
assert.equal(llamaCppSpec.output_token_ceiling, 8192);
assert.equal(llamaCppSpec.append_path, "/v1");
assert.equal(llamaCppSpec.completion_path, "/chat/completions");
assert.equal(llamaCppSpec.discovery_path, "/models");
const llamaCppProviderSource = await readFile(
  new URL("../api/backend/ai/providers/local_llamacpp.py", import.meta.url), "utf8",
);
assert.match(llamaCppProviderSource, /POLICY = LocalOpenAIChatPolicy\(/,
  "llama.cpp behavior must remain declared in its leaf provider module");
const neutralLocalRuntime = await readFile(
  new URL("../api/backend/ai/providers/local_openai_runtime.py", import.meta.url), "utf8",
);
for (const providerId of ["llamacpp", "lmstudio", "localai", "jan", "textgen", "vllm"]) {
  assert.doesNotMatch(neutralLocalRuntime, new RegExp(`[\"']${providerId}[\"']`),
    `neutral Local OpenAI runtime must not contain ${providerId} policy`);
}

console.log("Local AI config test passed: presets and custom JSON stay local, declarative and credential-free.");
