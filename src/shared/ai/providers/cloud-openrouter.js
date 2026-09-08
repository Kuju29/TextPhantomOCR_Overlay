import { defineCloudProvider } from "./cloud-spec.js";
export const cloudProvider = defineCloudProvider({
  id: "openrouter",
  displayName: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  defaultModel: "openai/o4-mini",
  keyUrl: "https://openrouter.ai/settings/keys",
  keyPrefixes: ["sk-or-"],
  protocol: "openai_chat_completions",
  modelsPath: "/models/user",
  rate: { rpm: 60, burst: 8, note: "free models are much lower" },
});
