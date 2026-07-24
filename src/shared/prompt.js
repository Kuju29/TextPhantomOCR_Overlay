/**
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
 * AI prompt helpers.
 *
 * Editable per-language style prompts are stored under a `lang::model` key so
 * the user can tune the wording independently for each target language and
 * model.  This module owns the key format, normalisation and migration of the
 * legacy (lang-only) storage shape — plus a browser-like per-key edit HISTORY
 * (back / forward) shared by the popup editor and the Prompt Studio.
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

// --- Prompt edit history (browser-like back / forward) ----------------------
// Stored in chrome.storage.local under `aiPromptHistory`:
//   { [lang::model]: { stack: string[], idx: number } }
// `idx` points at the CURRENT version. Going back moves idx left; committing
// a new version truncates everything to the right of idx (like a browser
// history branch) and appends. Persisted so history survives popup closes.

export const AI_PROMPT_HISTORY_MAX = 30;

async function readPromptHistoryMap() {
  const it = await getStorage(["aiPromptHistory"]);
  return it.aiPromptHistory && typeof it.aiPromptHistory === "object" ? it.aiPromptHistory : {};
}

function normHistoryEntry(rec) {
  const stack = Array.isArray(rec?.stack) ? rec.stack.map((s) => String(s ?? "")) : [];
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
  const dirty = currentText != null && stack.length > 0 && String(currentText) !== stack[idx];
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
  return { text: entry.stack[idx], canBack: idx > 0, canForward: idx < entry.stack.length - 1 };
}
