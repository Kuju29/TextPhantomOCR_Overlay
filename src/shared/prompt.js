/**
 * AI prompt helpers: per-language editable style prompts (key format,
 * normalisation, migration of older storage shapes) plus a browser-like
 * per-key edit history shared by the popup editor and the Prompt Studio.
 */

import { getStorage, setStorage } from "./storage.js";

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
export function makePromptKey(lang, _model) {
  // Prompts are keyed by LANGUAGE ONLY: a model in the key made a saved prompt
  // vanish whenever the resolved model changed. `_model` is ignored.
  return String(lang || "").trim() || "en";
}

/** Collision-free key for the opt-in Provider + Model prompt store. */
export function makeProfilePromptKey(providerIdentity, model, lang) {
  const parts = [providerIdentity, model, lang].map((part) =>
    String(part || "").trim(),
  );
  const labels = ["provider", "model", "language"];
  for (let index = 0; index < parts.length; index += 1) {
    if (
      !parts[index] ||
      ["__proto__", "prototype", "constructor"].includes(parts[index])
    ) {
      throw new TypeError(`Invalid reserved ${labels[index]} key`);
    }
  }
  return parts
    .map((part) => encodeURIComponent(String(part || "").trim()))
    .join("::");
}



/**
 * Normalise prompt text: CRLF → LF, trimmed, clamped to `maxChars`.
 * @param {string} text
 * @param {number} [maxChars]
 */
export function normalizePrompt(text, maxChars = AI_PROMPT_MAX_CHARS) {
  let s = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (s.length > maxChars) s = s.slice(0, maxChars).trimEnd();
  return s;
}

/**
 * Migrate a stored prompt map to language-only keys (older `lang::model` keys
 * collapse to `lang`).
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
    if (!normalized) {
      if (value) changed = true; // dropped an empty/whitespace entry
      continue;
    }
    // Collapse any legacy "lang::model" key down to "lang" (language only).
    const lang = makePromptKey(String(key).split("::")[0]);
    if (lang !== key) changed = true;
    if (!Object.prototype.hasOwnProperty.call(map, lang)) {
      map[lang] = normalized;
      if (normalized !== value) changed = true;
    } else {
      // A duplicate model-specific entry for the same language — keep the first
      // (non-empty) one, drop the rest.
      changed = true;
    }
  }
  return { map, changed };
}

// Prompt edit history (browser-like back / forward), persisted in
// chrome.storage.local `aiPromptHistory`: { [promptKey]: { stack, idx } }.
// `idx` is the CURRENT version; committing a new version truncates everything
// right of idx and appends.

const AI_PROMPT_HISTORY_MAX = 30;

async function readPromptHistoryMap() {
  const it = await getStorage(["aiPromptHistory"]);
  return it.aiPromptHistory && typeof it.aiPromptHistory === "object"
    ? it.aiPromptHistory
    : {};
}

function normHistoryEntry(rec) {
  const stack = Array.isArray(rec?.stack)
    ? rec.stack.map((s) => String(s ?? ""))
    : [];
  let idx = Number.isInteger(rec?.idx) ? rec.idx : stack.length - 1;
  if (idx < 0 || idx > stack.length - 1) idx = stack.length - 1;
  return { stack, idx };
}

/**
 * Commit `text` as the current version for `key` (no-op when identical to
 * the current version). Truncates any forward branch.
 * @param {string} key @param {string} text
 */
export async function promptHistoryPush(key, text) {
  const k = String(key || "").trim();
  if (!k) return;
  const value = String(text ?? "");
  const map = await readPromptHistoryMap();
  const { stack, idx } = normHistoryEntry(map[k]);
  if (stack.length && stack[idx] === value) return;
  const next = stack.slice(0, idx + 1);
  next.push(value);
  while (next.length > AI_PROMPT_HISTORY_MAX) next.shift();
  map[k] = { stack: next, idx: next.length - 1 };
  await setStorage({ aiPromptHistory: map });
}

/**
 * Whether back / forward are possible. Pass the editor's current text so an
 * uncommitted edit counts as "one step ahead" (back returns to the last
 * committed version; forward is blocked until the edit is committed).
 * @param {string} key @param {string|null} [currentText]
 * @returns {Promise<{canBack: boolean, canForward: boolean, size: number}>}
 */
export async function promptHistoryState(key, currentText = null) {
  const { stack, idx } = normHistoryEntry(
    (await readPromptHistoryMap())[String(key || "").trim()],
  );
  const dirty =
    currentText != null &&
    stack.length > 0 &&
    String(currentText) !== stack[idx];
  return {
    canBack: stack.length > 0 && (idx > 0 || dirty),
    canForward: !dirty && idx < stack.length - 1,
    size: stack.length,
  };
}

/**
 * Step back one version. An uncommitted `currentText` is committed first
 * (so Forward can return to it), exactly like navigating away in a browser.
 * @param {string} key @param {string} currentText
 * @returns {Promise<{text: string, canBack: boolean, canForward: boolean} | null>}
 */
export async function promptHistoryBack(key, currentText) {
  const k = String(key || "").trim();
  if (!k) return null;
  const map = await readPromptHistoryMap();
  let { stack, idx } = normHistoryEntry(map[k]);
  const current = String(currentText ?? "");
  if (!stack.length || stack[idx] !== current) {
    stack = stack.slice(0, idx + 1);
    stack.push(current);
    while (stack.length > AI_PROMPT_HISTORY_MAX) stack.shift();
    idx = stack.length - 1;
  }
  if (idx <= 0) {
    map[k] = { stack, idx };
    await setStorage({ aiPromptHistory: map });
    return null;
  }
  idx -= 1;
  map[k] = { stack, idx };
  await setStorage({ aiPromptHistory: map });
  return { text: stack[idx], canBack: idx > 0, canForward: true };
}

/**
 * Step forward one version (only possible right after going back).
 * @param {string} key
 * @returns {Promise<{text: string, canBack: boolean, canForward: boolean} | null>}
 */
export async function promptHistoryForward(key) {
  const k = String(key || "").trim();
  if (!k) return null;
  const map = await readPromptHistoryMap();
  const entry = normHistoryEntry(map[k]);
  if (!entry.stack.length || entry.idx >= entry.stack.length - 1) return null;
  const idx = entry.idx + 1;
  map[k] = { stack: entry.stack, idx };
  await setStorage({ aiPromptHistory: map });
  return {
    text: entry.stack[idx],
    canBack: idx > 0,
    canForward: idx < entry.stack.length - 1,
  };
}
