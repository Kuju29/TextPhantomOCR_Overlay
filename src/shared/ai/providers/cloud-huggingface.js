import { defineCloudProvider } from "./cloud-spec.js";
export const cloudProvider = defineCloudProvider({
  id: "huggingface",
  displayName: "HuggingFace",
  baseUrl: "https://router.huggingface.co/v1",
  defaultModel: "google/gemma-2-2b-it",
  keyUrl: "https://huggingface.co/settings/tokens",
  keyPrefixes: ["hf_"],
  protocol: "openai_chat_completions",
});
