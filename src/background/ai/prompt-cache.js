import { normalizeLanguageCode } from "../../generated/language-code-aliases.js";
import { createLogger } from "../../shared/logger.js";
import { API_PATHS } from "../../shared/constants.js";
import { BUNDLED_CANONICAL_PROMPT_PLANS } from "../../generated/canonical-prompt-plans.js";

const log = createLogger("SW.ai.prompt-cache");
const promptCache = new Map();
const promptAuditCache = new Map();
export const CANONICAL_PROMPT_VERSION = "translation-plan-2";
const REQUIRED_PIECES = Object.freeze([
  "systemPolicy",
  "editableStyle",
  "targetLanguageInstruction",
  "sourceInputContract",
  "imageHint",
  "markerOutputContract",
  "structuredOutputContract",
  "seriesNotesHeading",
]);
const EXTENSION_OWNED_PIECES = new Set([
  "systemPolicy",
  "targetLanguageInstruction",
  "sourceInputContract",
  "imageHint",
  "markerOutputContract",
  "structuredOutputContract",
  "seriesNotesHeading",
]);

export class PromptContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "PromptContractError";
    this.code = "canonical_prompt_contract_invalid";
    this.generationAttempts = 0;
    this.providerAttempts = 0;
    this.requestDispatched = false;
  }
}

function normalizedLanguage(lang) {
  const raw = normalizeLanguageCode(lang);
  return raw || "en";
}

function bundledPlan(lang) {
  return BUNDLED_CANONICAL_PROMPT_PLANS[normalizedLanguage(lang)] || null;
}

function compatiblePlan(supplied, fallback = null) {
  const source = supplied && typeof supplied === "object" ? supplied : {};
  const sourcePieces = source.pieces && typeof source.pieces === "object"
    ? source.pieces : {};
  const fallbackPieces = fallback?.pieces && typeof fallback.pieces === "object"
    ? fallback.pieces : {};
  const pieces = {};
  const fallbackKeys = [];
  const protectedKeys = [];
  for (const key of REQUIRED_PIECES) {
    const candidate = typeof sourcePieces[key] === "string"
      ? sourcePieces[key].trim() : "";
    const replacement = typeof fallbackPieces[key] === "string"
      ? fallbackPieces[key].trim() : "";
    const extensionOwned = Boolean(replacement && EXTENSION_OWNED_PIECES.has(key));
    pieces[key] = extensionOwned ? replacement : candidate || replacement;
    if (!candidate && replacement) fallbackKeys.push(key);
    if (extensionOwned && candidate && candidate !== replacement) protectedKeys.push(key);
  }
  const missing = REQUIRED_PIECES.filter((key) => !pieces[key]);
  if (missing.length) {
    throw new PromptContractError(
      `AI prompt contract has no safe value for: ${missing.join(", ")}`,
    );
  }
  const sourceVersion = String(source.version || "missing");
  return {
    version: CANONICAL_PROMPT_VERSION,
    sourceVersion,
    compositionOrder: Array.isArray(source.compositionOrder)
      ? [...source.compositionOrder]
      : Array.isArray(fallback?.compositionOrder)
        ? [...fallback.compositionOrder]
        : [...REQUIRED_PIECES],
    editableStylePolicy: {
      control: "optional_replace",
      supportedModes: ["replace"],
      migrationDefault: "replace",
      emptyBehavior: "built_in",
    },
    pieces,
    // Hashes are diagnostic metadata only. Runtime safety comes from keeping
    // source/output contracts extension-owned and filling stale/missing pieces
    // from the bundled plan instead of rejecting the user's editable style.
    hashes: { ...(fallback?.hashes || {}), ...(source.hashes || {}) },
    hash: String(source.hash || fallback?.hash || ""),
    compatibility: {
      normalized: sourceVersion !== CANONICAL_PROMPT_VERSION ||
        fallbackKeys.length > 0 || protectedKeys.length > 0,
      fallbackPieces: fallbackKeys,
      protectedPieces: protectedKeys,
      ignoredUnexpectedPieces: Object.keys(sourcePieces).filter(
        (key) => !REQUIRED_PIECES.includes(key),
      ),
    },
  };
}

export async function validateCanonicalPrompt(data, { fallback = null } = {}) {
  return structuredClone(compatiblePlan(data?.canonicalPrompt, fallback));
}

export async function getSystemPrompt(base, lang, { wantMemo = false } = {}) {
  const key = `${base}|${lang}|memo=${wantMemo ? 1 : 0}`;
  if (promptCache.has(key)) return structuredClone(promptCache.get(key));
  const fallback = bundledPlan(lang);
  if (!fallback)
    throw new PromptContractError(`No bundled AI prompt for language: ${normalizedLanguage(lang)}`);
  try {
    const url = `${base.replace(/\/+$/, "")}${API_PATHS.AI_PROMPT_DEFAULT}?lang=${encodeURIComponent(lang)}&want_memo=${wantMemo ? "1" : "0"}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const promptPlan = await validateCanonicalPrompt(data, { fallback });
    const remoteFallback = !data?.canonicalPrompt ||
      (promptPlan.compatibility?.fallbackPieces || []).length > 0;
    const remoteFallbackReason = !data?.canonicalPrompt
      ? "remote_contract_missing"
      : remoteFallback ? "remote_contract_incomplete" : "";
    if (remoteFallback) {
      promptPlan.compatibility = {
        ...(promptPlan.compatibility || {}),
        remoteFallback: true,
        remoteFallbackReason,
      };
    }
    promptCache.set(key, promptPlan);
    promptAuditCache.set(key, {
      promptVersion: String(data?.promptVersion || ""),
      promptHash: String(data?.promptHash || ""),
      promptChars: Number(data?.promptChars || 0),
      promptSource: remoteFallback
        ? "bundled_fallback" : String(data?.promptSource || "built_in"),
      promptFallback: remoteFallback,
      promptFallbackReason: remoteFallbackReason,
      systemPromptHash: String(data?.systemPromptHash || ""),
      systemPromptChars: Number(data?.systemPromptChars || 0),
      canonicalPromptVersion: String(promptPlan.version || ""),
      canonicalPromptSourceVersion: String(promptPlan.sourceVersion || ""),
      canonicalPromptHash: String(data?.canonicalPrompt?.hash || ""),
      canonicalPromptNormalized: Boolean(promptPlan.compatibility?.normalized),
    });
    return structuredClone(promptPlan);
  } catch (error) {
    log.warn("using bundled AI prompt after remote prompt metadata failed", {
      lang,
      error: error?.message || String(error),
    });
    const promptPlan = await validateCanonicalPrompt(
      { canonicalPrompt: fallback }, { fallback },
    );
    const fallbackReason = error instanceof PromptContractError
      ? "remote_contract_invalid" : "remote_prompt_unavailable";
    promptPlan.compatibility = {
      ...(promptPlan.compatibility || {}),
      remoteFallback: true,
      remoteFallbackReason: fallbackReason,
    };
    promptCache.set(key, promptPlan);
    promptAuditCache.set(key, {
      promptSource: "bundled_fallback",
      promptFallback: true,
      promptFallbackReason: fallbackReason,
      promptFallbackErrorCode: String(error?.code || error?.name || "remote_prompt_error"),
      canonicalPromptVersion: promptPlan.version,
      canonicalPromptSourceVersion: promptPlan.sourceVersion,
      canonicalPromptHash: promptPlan.hash,
      canonicalPromptNormalized: true,
    });
    return structuredClone(promptPlan);
  }
}

// Direct-local is browser-owned and always starts from the bundled contract.
export async function getCanonicalPrompt(_base, lang, { wantMemo = false } = {}) {
  if (wantMemo) throw new PromptContractError("Bundled Local AI prompt does not support memo output");
  const code = normalizedLanguage(lang);
  const supplied = bundledPlan(code);
  if (!supplied) throw new PromptContractError(`No bundled Local AI prompt for language: ${code}`);
  const promptPlan = await validateCanonicalPrompt(
    { canonicalPrompt: supplied }, { fallback: supplied },
  );
  const key = `bundled|${code}|memo=0`;
  promptAuditCache.set(key, {
    promptSource: "bundled_canonical",
    canonicalPromptVersion: promptPlan.version,
    canonicalPromptSourceVersion: promptPlan.sourceVersion,
    canonicalPromptHash: promptPlan.hash,
    canonicalPromptNormalized: Boolean(promptPlan.compatibility?.normalized),
  });
  return promptPlan;
}

export function forgetPrompts() {
  promptCache.clear();
  promptAuditCache.clear();
}

export function getPromptAudit(base, lang, { wantMemo = false } = {}) {
  return {
    ...(promptAuditCache.get(`bundled|${normalizedLanguage(lang)}|memo=${wantMemo ? 1 : 0}`) ||
      promptAuditCache.get(`${base}|${lang}|memo=${wantMemo ? 1 : 0}`) || {}),
  };
}
