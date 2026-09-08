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

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function validateCanonicalPrompt(data) {
  const supplied = data?.canonicalPrompt;
  const pieces = supplied?.pieces;
  if (!supplied || typeof supplied !== "object")
    throw new PromptContractError("AI prompt response is missing canonicalPrompt");
  if (supplied.version !== CANONICAL_PROMPT_VERSION)
    throw new PromptContractError(
      `Unsupported AI prompt contract version: ${String(supplied.version || "missing")}`,
    );
  if (!pieces || typeof pieces !== "object")
    throw new PromptContractError("AI prompt contract is missing pieces");
  const missing = REQUIRED_PIECES.filter(
    (key) => typeof pieces[key] !== "string" || !pieces[key].trim(),
  );
  if (missing.length)
    throw new PromptContractError(
      `AI prompt contract has missing or empty pieces: ${missing.join(", ")}`,
    );
  const pieceKeys = Object.keys(pieces).sort();
  const expectedPieceKeys = [...REQUIRED_PIECES].sort();
  if (pieceKeys.join("\n") !== expectedPieceKeys.join("\n"))
    throw new PromptContractError("AI prompt contract has unexpected prompt pieces");
  const hashes = supplied.hashes;
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes) ||
      Object.keys(hashes).sort().join("\n") !== pieceKeys.join("\n"))
    throw new PromptContractError("AI prompt contract has missing or unexpected piece hashes");
  for (const key of pieceKeys) {
    const advertised = String(hashes[key] || "");
    const actual = await sha256(pieces[key]);
    if (advertised !== actual)
      throw new PromptContractError(`AI prompt contract hash mismatch for piece: ${key}`);
  }
  const aggregate = pieceKeys.map((key) => `${key}:${hashes[key]}`).join("\n");
  if (String(supplied.hash || "") !== await sha256(aggregate))
    throw new PromptContractError("AI prompt contract aggregate hash mismatch");
  const policy = supplied.editableStylePolicy;
  if (
    policy?.control !== "fixed_replace" ||
    !Array.isArray(policy?.supportedModes) ||
    policy.supportedModes.length !== 1 ||
    policy.supportedModes[0] !== "replace"
  )
    throw new PromptContractError("AI prompt contract has an invalid editableStylePolicy");
  return structuredClone(supplied);
}

export async function getSystemPrompt(base, lang, { wantMemo = false } = {}) {
  const key = `${base}|${lang}|memo=${wantMemo ? 1 : 0}`;
  if (promptCache.has(key)) return structuredClone(promptCache.get(key));
  try {
    const url = `${base.replace(/\/+$/, "")}${API_PATHS.AI_PROMPT_DEFAULT}?lang=${encodeURIComponent(lang)}&want_memo=${wantMemo ? "1" : "0"}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const promptPlan = await validateCanonicalPrompt(data);
    promptCache.set(key, promptPlan);
    promptAuditCache.set(key, {
      promptVersion: String(data?.promptVersion || ""),
      promptHash: String(data?.promptHash || ""),
      promptChars: Number(data?.promptChars || 0),
      promptSource: String(data?.promptSource || "built_in"),
      systemPromptHash: String(data?.systemPromptHash || ""),
      systemPromptChars: Number(data?.systemPromptChars || 0),
      canonicalPromptVersion: String(promptPlan.version || ""),
      canonicalPromptHash: String(data?.canonicalPrompt?.hash || ""),
    });
    return structuredClone(promptPlan);
  } catch (error) {
    log.warn("could not load the canonical AI prompt contract", {
      lang,
      error: error?.message || String(error),
    });
    if (error instanceof PromptContractError) throw error;
    throw new PromptContractError(
      `Could not load canonical AI prompt contract: ${error?.message || String(error)}`,
    );
  }
}

function normalizedLanguage(lang) {
  const raw = normalizeLanguageCode(lang);
  return raw || "en";
}

// Direct-local is browser-owned. It never probes the API and never substitutes
// a remote plan when the bundled plan is absent or corrupt.
export async function getCanonicalPrompt(_base, lang, { wantMemo = false } = {}) {
  if (wantMemo) throw new PromptContractError("Bundled Local AI prompt does not support memo output");
  const code = normalizedLanguage(lang);
  const supplied = BUNDLED_CANONICAL_PROMPT_PLANS[code];
  if (!supplied) throw new PromptContractError(`No bundled Local AI prompt for language: ${code}`);
  const promptPlan = await validateCanonicalPrompt({ canonicalPrompt: supplied });
  const key = `bundled|${code}|memo=0`;
  promptAuditCache.set(key, {
    promptSource: "bundled_canonical",
    canonicalPromptVersion: promptPlan.version,
    canonicalPromptHash: promptPlan.hash,
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
