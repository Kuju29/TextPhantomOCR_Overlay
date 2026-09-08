import { cloudProviderSpec } from "../shared/ai/providers/cloud-registry.js";

export function providerKeyUrl(provider) {
  return cloudProviderSpec(provider)?.keyUrl || "";
}

export function applyProviderKeyLink(link, provider) {
  if (!link) return "";
  const keyUrl = providerKeyUrl(provider);
  link.href = keyUrl || "#";
  link.hidden = !keyUrl;
  return keyUrl;
}
