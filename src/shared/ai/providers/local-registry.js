import { localProvider as ollama } from "./local-ollama.js";
import { localProvider as lmstudio } from "./local-lmstudio.js";
import { localProvider as jan } from "./local-jan.js";
import { localProvider as textgen } from "./local-textgen.js";
import { localProvider as koboldcpp } from "./local-koboldcpp.js";
import { localProvider as vllm } from "./local-vllm.js";
import { localProvider as llamafile } from "./local-llamafile.js";
import { localProvider as gpt4all } from "./local-gpt4all.js";
import { localProvider as llamacpp } from "./local-llamacpp.js";
import { normalizeAdapter } from "./local-spec.js";
import { createOpenAiCompatibleAdapter, openAiCompatibleCapabilityHints } from "./local-openai-compatible.js";
import { LocalAiError } from "../direct-local/error.js";

const CATALOG = Object.freeze(Object.fromEntries(
  [ollama, lmstudio, jan, textgen, koboldcpp, vllm, llamafile, gpt4all, llamacpp]
    .map((spec) => [spec.id, spec]),
));
const ALIASES = Object.freeze({ local: "ollama", llama: "ollama", "llama.cpp": "llamacpp", "llama-cpp": "llamacpp" });
const PROTOCOLS = Object.freeze({
  ollama,
  openai: Object.freeze({ id: "openai", create: createOpenAiCompatibleAdapter, capabilityHints: openAiCompatibleCapabilityHints }),
});

export const localProviderCatalog = () => Object.values(CATALOG);
// Fixed, reviewed vendor links. Never navigate to an editable local endpoint.
const WEBSITES = Object.freeze({
  ollama: "https://docs.ollama.com/",
  lmstudio: "https://lmstudio.ai/docs/developer/core/server",
  jan: "https://www.jan.ai/docs/desktop/api-server",
  textgen: "https://github.com/oobabooga/text-generation-webui",
  koboldcpp: "https://github.com/LostRuins/koboldcpp",
  vllm: "https://docs.vllm.ai/en/latest/serving/online_serving/",
  llamafile: "https://github.com/mozilla-ai/llamafile",
  gpt4all: "https://docs.gpt4all.io/",
  llamacpp: "https://github.com/ggml-org/llama.cpp",
});
export const localProviderWebsite = (id) => WEBSITES[String(id || "").toLowerCase()] || "";
export const canonicalLocalProviderId = (id) => ALIASES[String(id || "").trim().toLowerCase()] || String(id || "").trim().toLowerCase();
export const isNamedLocalProvider = (id) => Boolean(CATALOG[canonicalLocalProviderId(id)]);
export const localProviderSpec = (id) => CATALOG[canonicalLocalProviderId(id)] || null;
// This describes the optional provider Conversation transport, not the mode
// assigned to a user's translation job. Local jobs use Independent regardless
// of whether a provider also offers a retained response cursor.
export function localProviderContinuationStrategy(id) {
  if (String(id || "").trim().toLowerCase() === "customlocal") return "message_replay";
  const spec = localProviderSpec(id);
  if (!spec) throw new Error(`Unknown Local AI provider: ${id}`);
  return spec.continuationStrategy;
}
export const localProviderTranslationMode = (id) => {
  localProviderContinuationStrategy(id); // Reject unknown Local providers instead of guessing.
  return "independent";
};
export const localAiPreset = (id) => {
  const spec = localProviderSpec(id);
  return spec ? normalizeAdapter(spec) : null;
};
export const normalizeLocalAiAdapter = (value, { provider = "" } = {}) => {
  if (String(provider || "").toLowerCase() === "customlocal" &&
    (!["ollama", "openai"].includes(value?.protocol) ||
      typeof value?.baseUrl !== "string" || !value.baseUrl.trim())) {
    const error = new Error("Custom adapter requires an explicit protocol and baseUrl");
    error.code = "LOCAL_ADAPTER_MISSING";
    throw error;
  }
  const spec = localProviderSpec(provider) || (value?.protocol === "ollama" ? ollama : lmstudio);
  return normalizeAdapter(spec, value);
};
export function savedCustomLocalAdapter(value, endpoint) {
  try {
    const adapter = normalizeLocalAiAdapter(value, { provider: "customlocal" });
    return sameLocalAdapterEndpoint(adapter.baseUrl, endpoint)
      ? adapter : null;
  } catch {
    return null;
  }
}
export function sameLocalAdapterEndpoint(left, right) {
  try {
    const normalized = (value) => new URL(String(value || "").trim()).toString().replace(/\/+$/, "");
    return Boolean(left && right && normalized(left) === normalized(right));
  } catch { return false; }
}
export function parseLocalAiAdapterJson(text) {
  let value;
  try { value = JSON.parse(String(text || "")); } catch { throw new Error("Custom adapter must be valid JSON"); }
  const allowed = new Set(["version", "protocol", "translationContract", "baseUrl", "modelsPath", "chatPath", "modelsResponsePath", "chatResponsePath", "thinking", "includeUsage"]);
  const extra = Object.keys(value && typeof value === "object" ? value : {}).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`Unsupported field: ${extra[0]}`);
  if (Number(value?.version) !== 1) throw new Error("version must be 1");
  if (!["ollama", "openai"].includes(value.protocol) || !String(value.baseUrl || "").trim())
    throw new Error("Custom adapter requires an explicit protocol and baseUrl");
  if ("includeUsage" in value && typeof value.includeUsage !== "boolean")
    throw new Error("includeUsage must be a boolean");
  return normalizeLocalAiAdapter(value);
}
export const serializeLocalAiAdapter = (adapter) => JSON.stringify(normalizeLocalAiAdapter(adapter), null, 2);

export function resolveLocalProviderDefinition(name) {
  const spec = localProviderSpec(name) || PROTOCOLS[name];
  if (!spec) throw new Error(`Unknown Local AI provider: ${name}`);
  return spec;
}
export function resolveLocalProvider(settings = {}, provider = "") {
  const spec = localProviderSpec(provider || settings.provider) || (settings.protocol === "ollama" ? ollama : null);
  if (!spec && (!provider || provider === "local-openai" || settings.protocol === "openai")) return createOpenAiCompatibleAdapter(settings);
  if (!spec) throw new Error("Local AI provider identity is required");
  if (spec.continuationStrategy === "native_response_cursor" && settings.protocol && settings.protocol !== spec.protocol)
    throw new LocalAiError("The selected Local provider's native Conversation protocol does not match its adapter", {
      code: "local_provider_response_contract", attempted: false, retryable: false,
    });
  return spec.create({ ...spec, ...settings });
}
