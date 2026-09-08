import { defineCloudProvider } from "./cloud-spec.js";
export const cloudProvider = defineCloudProvider({
  id: "openai",
  displayName: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-5.6-luna",
  keyUrl: "https://platform.openai.com/api-keys",
  keyPrefixes: ["sk-"],
  protocol: "openai_chat_completions",
  skStyleKey: true,
  rate: { rpm: 60, burst: 8 },
});
