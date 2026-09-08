import { defineCloudProvider } from "./cloud-spec.js";
export const cloudProvider = defineCloudProvider({
  id: "featherless",
  displayName: "Featherless",
  baseUrl: "https://api.featherless.ai/v1",
  defaultModel: "Qwen/Qwen2.5-7B-Instruct",
  keyUrl: "https://featherless.ai/account/api-keys",
  protocol: "openai_chat_completions",
  skStyleKey: true,
  rate: { rpm: 30, burst: 6 },
});
