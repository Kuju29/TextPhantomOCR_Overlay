import { createOpenAiCompatibleAdapter } from "./local-openai-compatible.js";
import { defineLocalProvider } from "./local-spec.js";
export const localProvider = defineLocalProvider({
  id: "jan",
  displayName: "Jan",
  protocol: "openai",
  baseUrl: "http://localhost:1337/v1",
  modelsPath: "/models",
  chatPath: "/chat/completions",
  modelsResponsePath: "data.*.id",
  chatResponsePath: "choices.0.message.content",
  auth: "none",
  thinking: null,
  capacity: "runtime",
  create: createOpenAiCompatibleAdapter,
});
