import { defineCloudProvider } from "./cloud-spec.js";
export const cloudProvider = defineCloudProvider({
  id: "gemini",
  displayName: "Google Gemini",
  baseUrl: "",
  defaultModel: "gemini-3.6-flash",
  keyUrl: "https://aistudio.google.com/app/apikey",
  keyPrefixes: ["AIza"],
  protocol: "gemini_generate_content",
  modelsPath: "/v1beta/models",
  thinkingControl: true,
  rate: { rpm: 12, burst: 4, note: "free tier is ~15/min" },
});
