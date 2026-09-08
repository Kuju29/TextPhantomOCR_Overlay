import { defineCloudProvider } from "./cloud-spec.js";
export const cloudProvider = defineCloudProvider({
  id: "groq",
  displayName: "Groq",
  baseUrl: "https://api.groq.com/openai/v1",
  defaultModel: "openai/gpt-oss-20b",
  keyUrl: "https://console.groq.com/keys",
  keyPrefixes: ["gsk_"],
  protocol: "openai_chat_completions",
  rate: { rpm: 30, burst: 6 },
});
