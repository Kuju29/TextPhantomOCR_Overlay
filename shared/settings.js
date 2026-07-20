/**
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
 * Reading the user's stored settings.
 *
 * Two readers are exported because the service worker and the content script
 * need different slices:
 * - `readCoreSettings` — mode/lang/sources/aiKey (used by the content script).
 * - `readFullSettings` — also resolves the editable AI prompt + concurrency
 *   (used by the service worker when dispatching a job).
 */

import { getStorage, setStorage } from "./storage.js";
import { DEFAULT_LANG, DEFAULT_MODE, DEFAULT_SOURCE, DEFAULT_MAX_CONCURRENCY } from "./constants.js";
import {
  makePromptKey,
  migratePromptMap,
  normalizeAiModel,
  normalizePrompt,
} from "./prompt.js";

/** @returns {"lens_images"|"lens_text"} */
export function normalizeMode(value) {
  const v = String(value || "").trim();
  return v === "lens_images" || v === "lens_text" ? v : DEFAULT_MODE;
}

export function normalizeLang(value) {
  return String(value || "").trim() || DEFAULT_LANG;
}

export function normalizeSource(value) {
  return String(value || "").trim().toLowerCase() || DEFAULT_SOURCE;
}

/**
 * Lightweight settings slice used by the content script.
 * @returns {Promise<{mode:string, lang:string, sources:string, aiKey:string}>}
 */
export async function readCoreSettings() {
  const it = await getStorage(["mode", "lang", "sources", "aiKey"]);
  return {
    mode: normalizeMode(it.mode),
    lang: typeof it.lang === "string" && it.lang ? it.lang : DEFAULT_LANG,
    sources: typeof it.sources === "string" ? it.sources : DEFAULT_SOURCE,
    aiKey: typeof it.aiKey === "string" ? it.aiKey : "",
  };
}

/**
 * Full settings slice used by the service worker, including the resolved
 * editable AI prompt for the current language/model.
 *
 * Side effect: migrates the legacy prompt map shape and persists it back when
 * it changed (matching the original behaviour).
 *
 * @returns {Promise<{mode:string, lang:string, sources:string, maxConcurrency:number,
 *   aiKey:string, aiModel:string, aiPrompt:string}>}
 */
export async function readFullSettings() {
  const it = await getStorage([
    "mode",
    "lang",
    "sources",
    "maxConcurrency",
    "aiKey",
    "aiModel",
    "aiProvider",
    "aiBaseUrl",
    "aiGlossary",
    "aiCharMemory",
    "aiSendImage",
    "aiPageImage",
    "aiThinking",
    "aiPromptByLang",
    "aiPrompt",
  ]);

  const lang = typeof it.lang === "string" ? it.lang : DEFAULT_LANG;
  const aiModel = normalizeAiModel(typeof it.aiModel === "string" ? it.aiModel : "auto");

  const migration = migratePromptMap(
    it.aiPromptByLang && typeof it.aiPromptByLang === "object" ? it.aiPromptByLang : {},
  );
  const map = migration.map;
  let changed = migration.changed;

  // Resolve the prompt for (lang, model), falling back to (lang, auto), then
  // to the legacy single `aiPrompt` field.
  const key = makePromptKey(lang, aiModel);
  const autoKey = makePromptKey(lang, "auto");
  let aiPrompt = Object.prototype.hasOwnProperty.call(map, key) ? String(map[key] || "") : "";

  if (!aiPrompt && Object.prototype.hasOwnProperty.call(map, autoKey)) {
    aiPrompt = String(map[autoKey] || "");
    if (key !== autoKey) {
      map[key] = aiPrompt;
      changed = true;
    }
  }
  if (!aiPrompt && typeof it.aiPrompt === "string" && it.aiPrompt) {
    aiPrompt = it.aiPrompt;
    map[key] = aiPrompt;
    changed = true;
  }

  aiPrompt = normalizePrompt(aiPrompt);
  if (changed) {
    map[key] = aiPrompt;
    await setStorage({ aiPromptByLang: map, aiPrompt: "" });
  }

  return {
    mode: typeof it.mode === "string" ? it.mode : "lens_images",
    lang,
    sources: typeof it.sources === "string" ? it.sources : DEFAULT_SOURCE,
    maxConcurrency: Number.isFinite(Number(it.maxConcurrency)) ? Number(it.maxConcurrency) : DEFAULT_MAX_CONCURRENCY,
    aiKey: typeof it.aiKey === "string" ? it.aiKey : "",
    aiModel,
    aiProvider: typeof it.aiProvider === "string" ? it.aiProvider : "auto",
    aiBaseUrl: typeof it.aiBaseUrl === "string" ? it.aiBaseUrl : "",
    aiGlossary: Array.isArray(it.aiGlossary) ? it.aiGlossary : [],
    aiCharMemory: it.aiCharMemory !== false, // default ON
    // Page-image toggle: "always" (send every page) or "off" (text only).
    // Default "off"; migrates the older boolean `aiSendImage`.
    aiPageImage:
      it.aiPageImage === "always" || (it.aiPageImage == null && it.aiSendImage)
        ? "always"
        : "off",
    // Reasoning control (Gemini): "default" = think normally, "off" = fastest.
    aiThinking: it.aiThinking === "off" ? "off" : "default",
    aiPrompt,
  };
}
