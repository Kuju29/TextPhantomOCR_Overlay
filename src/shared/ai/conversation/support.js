// Negotiate the new route; never silently turn a conversation into independent work.
export function requireConversationApi(ai, capabilities) {
  if (ai?.translation_mode !== "conversation" || (capabilities?.aiConversation === "tp.conversation/1" && (!ai.conversation?.origins || capabilities?.aiConversationBatch === "tp.conversation_batch/1"))) return;
  throw Object.assign(new Error("This API does not support conversation translation. Update the API or select Independent."), {
    code: "ai_conversation_unsupported", category: "configuration", origin: "api", stage: "ai_routing",
    retryable: false, providerAttempts: 0, generationAttempts: 0, requestDispatched: false,
  });
}
