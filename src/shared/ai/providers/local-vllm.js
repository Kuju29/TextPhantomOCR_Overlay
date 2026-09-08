import { createOpenAiCompatibleAdapter } from "./local-openai-compatible.js";
import { defineLocalProvider } from "./local-spec.js";
export const localProvider = defineLocalProvider({
  id: "vllm",
  displayName: "vLLM",
  protocol: "openai",
  baseUrl: "http://localhost:8000/v1",
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
