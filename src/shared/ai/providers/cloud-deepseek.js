import { defineCloudProvider } from "./cloud-spec.js";
export const cloudProvider = defineCloudProvider({
  id: "deepseek",
  displayName: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  defaultModel: "deepseek-v4-flash",
  keyUrl: "https://platform.deepseek.com/api_keys",
  protocol: "openai_chat_completions",
  skStyleKey: true,
  rate: { rpm: 60, burst: 8 },
});
