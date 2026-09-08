/**
 *
 * AI prompt helpers.
 *
 * Editable per-language style prompts are stored under a `lang::model` key so
 * the user can tune the wording independently for each target language and
 * model.  This module owns the key format, normalisation and migration of the
 * legacy (lang-only) storage shape — plus a browser-like per-key edit HISTORY
 * (back / forward) shared by the popup editor and the Prompt Studio.
 */

import { getStorage, setStorage } from "./storage.js";
import {
  AI_PROFILE_PROMPT_HISTORY_BUDGET,
  AI_PROFILE_PROMPT_HISTORY_KEY,
  AI_PROFILE_PROMPT_HISTORY_PER_KEY,
} from "./ai-profile-schema.js";

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
  // Prompts are keyed by LANGUAGE ONLY. The model used to be part of the key,
  // which made a saved prompt "disappear" whenever the resolved model changed
  // (or could not be resolved while offline). The model argument is accepted so
  // existing call sites keep working, but it is intentionally ignored.
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

function utf8Bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Pure global-LRU compaction; prompt text only, no credential fields. */
export function compactProfilePromptHistory(
  input,
  byteBudget = AI_PROFILE_PROMPT_HISTORY_BUDGET,
) {
  const entries = Object.entries(
    input && typeof input === "object" ? input : {},
  )
    .map(([key, value]) => {
      const stack = Array.isArray(value?.stack)
        ? value.stack
            .slice(-AI_PROFILE_PROMPT_HISTORY_PER_KEY)
            .map((item) => normalizePrompt(item))
        : [];
      const clean = stack.filter(Boolean);
      return [
        key,
        {
          stack: clean,
          idx: clean.length
            ? Math.min(Math.max(Number(value?.idx) || 0, 0), clean.length - 1)
            : -1,
          touchedAt: Number.isFinite(Number(value?.touchedAt))
            ? Number(value.touchedAt)
            : 0,
        },
      ];
    })
    .filter(([, value]) => value.stack.length)
    .sort((a, b) => b[1].touchedAt - a[1].touchedAt);
  const output = {};
  for (const [key, value] of entries) {
    output[key] = value;
    while (utf8Bytes(output) > byteBudget && output[key]?.stack.length) {
      output[key].stack.shift();
      output[key].idx = Math.max(-1, output[key].idx - 1);
    }
    if (!output[key].stack.length) delete output[key];
  }
  return output;
}

export async function profilePromptHistoryPush(key, text, now = Date.now()) {
  const stored = await getStorage([AI_PROFILE_PROMPT_HISTORY_KEY]);
  const map =
    stored[AI_PROFILE_PROMPT_HISTORY_KEY] &&
    typeof stored[AI_PROFILE_PROMPT_HISTORY_KEY] === "object"
      ? stored[AI_PROFILE_PROMPT_HISTORY_KEY]
      : {};
  const current =
    map[key] && typeof map[key] === "object"
      ? map[key]
      : { stack: [], idx: -1 };
  const value = normalizePrompt(text);
  const stack = Array.isArray(current.stack)
    ? current.stack.slice(0, Number(current.idx) + 1)
    : [];
  if (!stack.length || stack[stack.length - 1] !== value) stack.push(value);
  map[key] = { stack, idx: stack.length - 1, touchedAt: now };
  const compacted = compactProfilePromptHistory(map);
  await setStorage({ [AI_PROFILE_PROMPT_HISTORY_KEY]: compacted });
  return compacted[key] || null;
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

// Prompt edit history (browser-like back / forward)
// Stored in chrome.storage.local under `aiPromptHistory`:
//   { [lang::model]: { stack: string[], idx: number } }
// `idx` points at the CURRENT version. Going back moves idx left; committing
// a new version truncates everything to the right of idx (like a browser
// history branch) and appends. Persisted so history survives popup closes.

export const AI_PROMPT_HISTORY_MAX = 30;

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
