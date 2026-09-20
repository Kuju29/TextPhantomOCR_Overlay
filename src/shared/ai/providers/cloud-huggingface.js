import { defineCloudProvider } from "./cloud-spec.js";
export const cloudProvider = defineCloudProvider({
  id: "huggingface",
  displayName: "HuggingFace",
  baseUrl: "https://router.huggingface.co/v1",
  defaultModel: "google/gemma-2-2b-it",
  keyUrl: "https://huggingface.co/settings/tokens",
  keyPrefixes: ["hf_"],
  protocol: "openai_chat_completions",
  // HF's response may echo the unnamespaced model with lowercase spelling.
  // Bind this narrow alias to the provider receipt of this exact request; never
  // strip arbitrary namespaces globally or alter display/usage model names.
  workloadModelIdentity({ requestedModel, reportedModel, receipt }) {
    const requested = String(requestedModel || "").trim();
    const reported = String(reportedModel || "").trim();
    if (receipt?.source !== "provider" || receipt?.provider !== "huggingface" ||
        receipt?.requestedModel !== requested || !/^[^/]+\/[^/]+$/.test(requested) ||
        reported.includes("/")) return reported;
    return requested.split("/")[1].toLowerCase() === reported.toLowerCase()
      ? requested : reported;
  },
});
