/** Single editable-prompt policy shared by UI, activation and transports. */
export const AI_PROMPT_MODE = "replace";
export const AI_PROMPT_POLICY_VERSION = "fixed_replace-1";

export function requireAiPrompt(text) {
  const value = String(text ?? "").trim();
  if (value) return value;
  const error = new Error(
    "[AI option > Set prompt] is empty. Click Reload, then save before translating.",
  );
  error.code = "AI_PROMPT_REQUIRED";
  error.requestDispatched = false;
  error.generationAttempts = 0;
  error.providerAttempts = 0;
  throw error;
}
