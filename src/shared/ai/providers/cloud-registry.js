import { cloudProvider as gemini } from "./cloud-gemini.js";
import { cloudProvider as openai } from "./cloud-openai.js";
import { cloudProvider as openrouter } from "./cloud-openrouter.js";
import { cloudProvider as anthropic } from "./cloud-anthropic.js";
import { cloudProvider as groq } from "./cloud-groq.js";
import { cloudProvider as deepseek } from "./cloud-deepseek.js";
import { cloudProvider as together } from "./cloud-together.js";
import { cloudProvider as huggingface } from "./cloud-huggingface.js";
import { cloudProvider as featherless } from "./cloud-featherless.js";

const CATALOG = Object.freeze(Object.fromEntries(
  [gemini, openai, openrouter, anthropic, groq, deepseek, together, huggingface, featherless]
    .map((spec) => [spec.id, spec]),
));
const ALIASES = Object.freeze(Object.fromEntries(
  Object.values(CATALOG).flatMap((spec) => spec.aliases.map((alias) => [alias, spec.id])),
));

export const cloudProviderCatalog = () => Object.values(CATALOG);
export const canonicalCloudProviderId = (id) => ALIASES[String(id || "").trim().toLowerCase()] || String(id || "").trim().toLowerCase();
export const cloudProviderSpec = (id) => CATALOG[canonicalCloudProviderId(id)] || null;
export const cloudRatePresets = () => Object.fromEntries(cloudProviderCatalog().filter((spec) => spec.rate).map((spec) => [spec.id, spec.rate]));
export const cloudKeyPrefixes = () => [...new Set(cloudProviderCatalog().flatMap((spec) => spec.keyPrefixes))];
export function cloudProviderFromKey(key) {
  const value = String(key || "");
  return cloudProviderCatalog()
    .flatMap((spec) => spec.keyPrefixes.map((prefix) => ({ spec, prefix })))
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find(({ prefix }) => value.startsWith(prefix))?.spec.id || "";
}
