import { defineCloudProvider } from "./cloud-spec.js";
export const cloudProvider = defineCloudProvider({
  id: "together",
  displayName: "Together",
  baseUrl: "https://api.together.xyz/v1",
  defaultModel: "openai/gpt-oss-20b",
  keyUrl: "https://api.together.ai/settings/api-keys",
  protocol: "openai_chat_completions",
  skStyleKey: true,
  rate: { rpm: 60, burst: 8 },
});
