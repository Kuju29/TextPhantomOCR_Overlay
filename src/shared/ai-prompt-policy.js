/** Editable-prompt policy shared by UI, activation and transports. */
export const AI_PROMPT_MODE = "replace";

export function normalizeAiPrompt(text) {
  return String(text ?? "").trim();
}

export function normalizeAiPromptMode(_value) {
  // Replace is the only wire composition mode. Legacy/missing values are a
  // storage migration concern, not a reason to block translation.
  return AI_PROMPT_MODE;
}

