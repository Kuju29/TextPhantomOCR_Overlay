import {
  localProviderCatalog,
  localProviderSpec,
} from "../../shared/ai/providers/local-registry.js";
import {
  cloudKeyPrefixes,
  cloudProviderFromKey,
  cloudProviderSpec,
} from "../../shared/ai/providers/cloud-registry.js";

export const KNOWN_KEY_PREFIXES = cloudKeyPrefixes();
export const SK_STYLE_PROVIDERS = {
  has: (id) => cloudProviderSpec(id)?.skStyleKey === true,
};

export const defaultEndpointFor = (provider) =>
  localProviderSpec(provider)?.baseUrl ||
  cloudProviderSpec(provider)?.baseUrl ||
  "";

export const isKnownLocalEndpoint = (value) =>
  localProviderCatalog().some(
    (spec) => spec.baseUrl === String(value || "").trim(),
  );

export function formatLocalBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
}

export function protocolLabel(protocol) {
  const value = String(protocol || "");
  if (value === "gemini_generate_content") return "Gemini generateContent";
  if (value === "anthropic_messages") return "Anthropic Messages";
  if (value === "openai_chat_completions")
    return "OpenAI-compatible Chat Completions";
  return value || "unknown transport";
}

export function providerFromKey(key) {
  return cloudProviderFromKey(key);
}

export const providerLabel = (id) =>
  localProviderSpec(id)?.displayName ||
  cloudProviderSpec(id)?.displayName ||
  id;
