/**
 *
 * STATUS: ACTIVE — in use in the current flow.
 * Reading the user's stored settings.
 *
 * Two readers are exported because the service worker and the content script
 * need different slices:
 * - `readCoreSettings` — mode/lang/sources/aiKey (used by the content script).
 * - `readFullSettings` — also resolves the editable AI prompt + concurrency
 *   (used by the service worker when dispatching a job).
 */

import { getStorage, setStorage } from "./storage.js";
import {
  DEFAULT_LANG,
  DEFAULT_MODE,
  DEFAULT_SOURCE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_RELAYOUT_TRANSLATED,
  DEFAULT_RATE_LIMIT_ENABLED,
  DEFAULT_RATE_RPM,
  DEFAULT_RATE_BURST,
  DEFAULT_UPLOAD_FORMAT,
  DEFAULT_UPLOAD_QUALITY,
  UPLOAD_FORMATS,
} from "./constants.js";
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
 * Read a stored boolean that has a non-false default.
 *
 * `Boolean(undefined)` is false, so a plain truthiness check would silently
 * turn every default-on switch off for users who have never touched it. Only an
 * explicit `false` counts as off.
 * @param {unknown} value
 * @param {boolean} fallback
 */
function readBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Read a stored non-negative number. Anything unparseable falls back to the
 * default rather than becoming NaN (which would serialize to null in the
 * payload and read as "not set" on the server).
 * @param {unknown} value
 * @param {number} fallback
 */
function readCount(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Canvas upload encoding. See DEFAULT_UPLOAD_FORMAT in constants.js for why
 * the default moved off PNG.
 */
export function normalizeUploadFormat(value) {
  const v = String(value || "").trim().toLowerCase();
  return UPLOAD_FORMATS.includes(v) ? v : DEFAULT_UPLOAD_FORMAT;
}

/** Quality is a 0-1 canvas fraction; anything outside that is not a quality. */
export function normalizeUploadQuality(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_UPLOAD_QUALITY;
}

/**
 * Lightweight settings slice used by the content script.
 * @returns {Promise<{mode:string, lang:string, sources:string, aiKey:string,
 *   uploadFormat:string, uploadQuality:number}>}
 */
export async function readCoreSettings() {
  const it = await getStorage(["mode", "lang", "sources", "aiKey", "uploadFormat", "uploadQuality"]);
  return {
    mode: normalizeMode(it.mode),
    lang: typeof it.lang === "string" && it.lang ? it.lang : DEFAULT_LANG,
    sources: typeof it.sources === "string" ? it.sources : DEFAULT_SOURCE,
    aiKey: typeof it.aiKey === "string" ? it.aiKey : "",
    uploadFormat: normalizeUploadFormat(it.uploadFormat),
    uploadQuality: normalizeUploadQuality(it.uploadQuality),
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
    "aiMemoryMode",
    "aiSendImage",
    "aiPageImage",
    "aiThinking",
    "aiPromptByLang",
    "aiPrompt",
    "relayoutTranslated",
    "rateLimitEnabled",
    "rateRpm",
    "rateBurst",
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
    // Single source of truth for the default: normalizeMode() falls back to
    // DEFAULT_MODE, so every settings reader agrees (no silent lens_images vs
    // lens_text divergence between readCoreSettings and readFullSettings).
    mode: normalizeMode(it.mode),
    lang,
    sources: typeof it.sources === "string" ? it.sources : DEFAULT_SOURCE,
    maxConcurrency: Number.isFinite(Number(it.maxConcurrency)) ? Number(it.maxConcurrency) : DEFAULT_MAX_CONCURRENCY,
    aiKey: typeof it.aiKey === "string" ? it.aiKey : "",
    aiModel,
    aiProvider: typeof it.aiProvider === "string" ? it.aiProvider : "auto",
    aiBaseUrl: typeof it.aiBaseUrl === "string" ? it.aiBaseUrl : "",
    aiGlossary: Array.isArray(it.aiGlossary) ? it.aiGlossary : [],
    aiCharMemory: it.aiCharMemory === true, // legacy boolean (Full == true)
    // Series-memory mode: "off" (default) | "terms" (glossary only) | "full"
    // (glossary + character sheet). Migrates the old boolean when unset.
    aiMemoryMode: ["off", "terms", "full"].includes(it.aiMemoryMode)
      ? it.aiMemoryMode
      : it.aiCharMemory === true
        ? "full"
        : "off",
    // Page-image toggle: "always" (send every page) or "off" (text only).
    // Default "off"; migrates the older boolean `aiSendImage`.
    aiPageImage:
      it.aiPageImage === "always" || (it.aiPageImage == null && it.aiSendImage)
        ? "always"
        : "off",
    // Reasoning control (Gemini): "default" = think normally, "off" = fastest.
    aiThinking: it.aiThinking === "off" ? "off" : "default",
    aiPrompt,
    // Orientation relayout for the Translated overlay. Default ON.
    relayoutTranslated: readBool(it.relayoutTranslated, DEFAULT_RELAYOUT_TRANSLATED),
    // AI rate-limit pacing. 0 for rpm/burst = use the server's provider policy.
    rateLimitEnabled: readBool(it.rateLimitEnabled, DEFAULT_RATE_LIMIT_ENABLED),
    rateRpm: readCount(it.rateRpm, DEFAULT_RATE_RPM),
    rateBurst: readCount(it.rateBurst, DEFAULT_RATE_BURST),
  };
}
