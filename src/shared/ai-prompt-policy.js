/** Editable-prompt policy shared by UI, activation and transports. */
export const AI_PROMPT_MODE = "replace";
export const AI_PROMPT_POLICY_VERSION = "optional_replace-2";

export function normalizeAiPrompt(text) {
  return String(text ?? "").trim();
}

export function normalizeAiPromptMode(_value) {
  // Replace is the only wire composition mode. Legacy/missing values are a
  // storage migration concern, not a reason to block translation.
  return AI_PROMPT_MODE;
}

// Compatibility name retained for existing imports. An empty editable prompt
// now means "use the built-in style" rather than a fatal pre-dispatch error.
export const requireAiPrompt = normalizeAiPrompt;
