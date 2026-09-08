import { localProvider as ollama } from "./local-ollama.js";
import { localProvider as lmstudio } from "./local-lmstudio.js";
import { localProvider as localai } from "./local-localai.js";
import { localProvider as jan } from "./local-jan.js";
import { localProvider as textgen } from "./local-textgen.js";
import { localProvider as koboldcpp } from "./local-koboldcpp.js";
import { localProvider as vllm } from "./local-vllm.js";
import { localProvider as llamafile } from "./local-llamafile.js";
import { localProvider as gpt4all } from "./local-gpt4all.js";
import { localProvider as llamacpp } from "./local-llamacpp.js";
import { normalizeAdapter } from "./local-spec.js";
import { createOpenAiCompatibleAdapter, openAiCompatibleCapabilityHints } from "./local-openai-compatible.js";

const CATALOG = Object.freeze(Object.fromEntries(
  [ollama, lmstudio, localai, jan, textgen, koboldcpp, vllm, llamafile, gpt4all, llamacpp]
    .map((spec) => [spec.id, spec]),
));
const ALIASES = Object.freeze({ local: "ollama", llama: "ollama", "llama.cpp": "llamacpp", "llama-cpp": "llamacpp" });
const PROTOCOLS = Object.freeze({
  ollama,
  openai: Object.freeze({ id: "openai", create: createOpenAiCompatibleAdapter, capabilityHints: openAiCompatibleCapabilityHints }),
});

export const localProviderCatalog = () => Object.values(CATALOG);
export const canonicalLocalProviderId = (id) => ALIASES[String(id || "").trim().toLowerCase()] || String(id || "").trim().toLowerCase();
export const isNamedLocalProvider = (id) => Boolean(CATALOG[canonicalLocalProviderId(id)]);
export const localProviderSpec = (id) => CATALOG[canonicalLocalProviderId(id)] || null;
export const localAiPreset = (id) => {
  const spec = localProviderSpec(id);
  return spec ? normalizeAdapter(spec) : null;
};
export const normalizeLocalAiAdapter = (value, { provider = "" } = {}) => {
  const spec = localProviderSpec(provider) || (value?.protocol === "ollama" ? ollama : lmstudio);
  return normalizeAdapter(spec, value);
};
export function parseLocalAiAdapterJson(text) {
  let value;
  try { value = JSON.parse(String(text || "")); } catch { throw new Error("Custom adapter must be valid JSON"); }
  const allowed = new Set(["version", "protocol", "translationContract", "baseUrl", "modelsPath", "chatPath", "modelsResponsePath", "chatResponsePath", "thinking", "includeUsage"]);
  const extra = Object.keys(value && typeof value === "object" ? value : {}).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`Unsupported field: ${extra[0]}`);
  if (Number(value?.version) !== 1) throw new Error("version must be 1");
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
  return spec.create({ ...spec, ...settings });
}
