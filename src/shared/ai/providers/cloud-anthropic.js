import { defineCloudProvider } from "./cloud-spec.js";
export const cloudProvider = defineCloudProvider({
  id: "anthropic",
  displayName: "Anthropic",
  baseUrl: "https://api.anthropic.com",
  defaultModel: "claude-sonnet-5",
  keyUrl: "https://platform.claude.com/settings/keys",
  keyPrefixes: ["sk-ant-"],
  protocol: "anthropic_messages",
  modelsPath: "/v1/models",
  rate: { rpm: 50, burst: 8 },
});
