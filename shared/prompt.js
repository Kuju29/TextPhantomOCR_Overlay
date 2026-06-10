/**
 * AI prompt helpers.
 *
 * Editable per-language style prompts are stored under a `lang::model` key so
 * the user can tune the wording independently for each target language and
 * model.  This module owns the key format, normalisation and migration of the
 * legacy (lang-only) storage shape.
 */

// Generous cap so the full-page Prompt Studio can hold long, detailed style
// prompts (the small popup textarea is just a quick-edit view of the same
// value). This is a UI/storage limit only.
export const AI_PROMPT_MAX_CHARS = 20000;

/** Normalise a model name; empty becomes "auto". */
export function normalizeAiModel(model) {
  const m = String(model || "").trim();
  return m || "auto";
}

/** Build the storage key for a (language, model) prompt entry. */
export function makePromptKey(lang, model) {
  const l = String(lang || "").trim() || "en";
  return `${l}::${normalizeAiModel(model)}`;
}

/**
 * Normalise prompt text: CRLF → LF, trimmed, clamped to `maxChars`.
 * @param {string} text
 * @param {number} [maxChars]
 */
export function normalizePrompt(text, maxChars = AI_PROMPT_MAX_CHARS) {
  let s = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (s.length > maxChars) s = s.slice(0, maxChars).trimEnd();
  return s;
}

/**
 * Migrate a stored prompt map to the `lang::model` key shape.
 * Legacy entries keyed by language only are re-keyed to `lang::auto`.
 * @param {Record<string,string>} input
 * @returns {{map: Record<string,string>, changed: boolean}}
 */
export function migratePromptMap(input) {
  if (!input || typeof input !== "object") return { map: {}, changed: false };
  const map = {};
  let changed = false;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    const normalized = normalizePrompt(value);
    if (!normalized && !value) continue;
    if (key.includes("::")) {
      map[key] = normalized;
      if (normalized !== value) changed = true;
    } else {
      map[makePromptKey(key, "auto")] = normalized;
      changed = true;
    }
  }
  return { map, changed };
}
