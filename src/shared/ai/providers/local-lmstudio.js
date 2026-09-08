import { createOpenAiCompatibleAdapter } from "./local-openai-compatible.js";
import { defineLocalProvider } from "./local-spec.js";
export const localProvider = defineLocalProvider({
  id: "lmstudio",
  displayName: "LM Studio",
  protocol: "openai",
  baseUrl: "http://localhost:1234/v1",
  modelsPath: "/models",
  chatPath: "/chat/completions",
  modelsResponsePath: "data.*.id",
  chatResponsePath: "choices.0.message.content",
  auth: "none",
  includeUsage: true,
  thinking: null,
  capacity: "runtime",
  create: createOpenAiCompatibleAdapter,
});
