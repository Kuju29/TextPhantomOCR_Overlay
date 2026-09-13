import { pageContextText } from "../page-context.js";
import { wrongLanguageRepairInstruction } from "../repair-instruction.js";
import { normalizeLanguageCode } from "../../../generated/language-code-aliases.js";
import { FALLBACK_LANGS } from "../../constants.js";

import { TRANSLATOR_IDENTITY_BASE, TASK_GUIDANCE, STYLE_EXAMPLES } from "../../../generated/localization-content.js";
export { TRANSLATOR_IDENTITY_BASE };

export function composeTranslatorIdentitySystem(style) {
  const selectedStyle = String(style || "").trim() ||
    "Write natural, faithful, in-character dialogue in the selected target language.";
  return `${TRANSLATOR_IDENTITY_BASE}\n\nTRANSLATION STYLE\n${selectedStyle}`;
}

export function joinCanonicalSystemSections(sections) {
  const mandatory = [
    sections?.policy,
    sections?.source,
    sections?.output,
  ]
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .join("\n");
  const system = [
    mandatory,
    sections?.request,
    sections?.runtime,
  ]
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const style = [sections?.language, sections?.style]
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .join("\n");
  return `System prompt:\n${system}\n\nStyle prompt:\n${style}`;
}

export function exactRequestOutputContract(expectedIds) {
  const ids = (expectedIds || []).map((value) => String(value || ""));
  if (!ids.length || ids.some((id, index) => id !== `P${index}`)) {
    const error = new Error("Local AI request has invalid output IDs");
    error.code = "local_source_contract_invalid";
    error.requestDispatched = false;
    error.generationAttempts = 0;
    error.providerAttempts = 0;
    throw error;
  }
  return "OUTPUT — tp.translation.compact-records/1\n" +
    `Return every supplied ID exactly once as <<TP_Pn:translated text>>. Expected IDs: ${ids.join(", ")}. ` +
    "Record order is irrelevant because results are matched by ID. Do not add, omit, merge, split or rename records. " +
    "Do not insert manual line breaks inside a payload. Return only the records, with no JSON, markdown, commentary or explanations.";
}

function glossaryText(entries, limit = 40) {
  if (!Array.isArray(entries)) return "";
  const seen = new Set();
  const lines = [];
  for (const entry of [...entries].reverse()) {
    const src = String(entry?.src || "").trim();
    const tgt = String(entry?.tgt || "").trim();
    if (!src || !tgt || src.length < 3 || seen.has(src)) continue;
    seen.add(src);
    lines.push(`  - ${src} → ${tgt}`);
    if (lines.length >= limit) break;
  }
  if (!lines.length) return "";
  return (
    "TRANSLATION MEMORY (names, places, skills, items from earlier pages — use the SAME target wording for the SAME source term). This binds recurring names/terms only; everyday words and interjections are always free to follow the scene:\n" +
    lines.reverse().join("\n")
  );
}

function characterText(characters, limit = 30) {
  if (!Array.isArray(characters)) return "";
  const lines = characters.slice(-limit).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const name = String(item.name || "").trim();
    if (!name) return [];
    const bits = [name];
    for (const key of ["gender", "speech", "note"]) {
      const value = String(item[key] || "").trim();
      if (value) bits.push(`${key}: ${value}`);
    }
    return [`  - ${bits.join(" | ")}`];
  });
  if (!lines.length) return "";
  return (
    "CHARACTER SHEET (accumulated from earlier pages of this series — use as evidence; current explicit source text takes precedence):\n" +
    lines.join("\n") +
    "\nGendered wording requires explicit source evidence or an identified character with known gender. Appearance alone is insufficient. Unknown entries do not override new explicit evidence. Known gender permits suitable wording; it does not require extra pronouns or polite particles. Preserve necessary register and conversational functions according to the target-language style. Use speech and note fields as context, not sentence templates; do not assign an unknown speaker another character's voice."
  );
}

function previousContextText(entries, limit = 6) {
  if (!Array.isArray(entries)) return "";
  const lines = entries.slice(-limit).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const src = String(entry.src || "")
      .trim()
      .replace(/\n/g, " ");
    if (!src) return [];
    const who = String(entry.who || "").trim();
    return [(who ? `  [${who}] ${src}` : `  ${src}`).slice(0, 200)];
  });
  return lines.length
    ? "PREVIOUS PAGE (source text tail, context only — the conversation may continue from here; do NOT translate or output these lines):\n" +
        lines.join("\n")
    : "";
}

function memoryText(ai) {
  const blocks = [];
  const state = String(ai?.series_state || "").trim();
  if (state)
    blocks.push(
      "STORY SO FAR (series bible from reading the whole chapter — background evidence for tone, relationships and scene; current source evidence takes precedence. NEVER restate or translate it in the output):\n" +
        state,
    );
  blocks.push(characterText(ai?.characters));
  blocks.push(glossaryText(ai?.glossary));
  blocks.push(previousContextText(ai?.prev_context));
  blocks.push(pageContextText(ai?.page_context));
  return blocks.filter(Boolean).join("\n\n");
}

const TARGET_NATIVE_NAMES = Object.freeze({
  th: "ภาษาไทย",
  ja: "日本語",
  ko: "한국어",
  "zh-cn": "简体中文",
  "zh-tw": "繁體中文",
  zh: "中文",
  vi: "Tiếng Việt",
  id: "Bahasa Indonesia",
  ms: "Bahasa Melayu",
  hi: "हिन्दी",
  bn: "বাংলা",
  ta: "தமிழ்",
  te: "తెలుగు",
  ar: "العربية",
  fa: "فارسی",
  iw: "עברית",
  he: "עברית",
  ru: "Русский",
  uk: "Українська",
  el: "Ελληνικά",
});

export function targetLanguagePriority(targetLang) {
  const raw = String(targetLang || "").trim();
  if (!raw) {
    return "Translate every source unit into the target language selected by the user.";
  }
  const normalized = normalizeLanguageCode(raw)
    .replace(/\s+/g, " ");
  const entry = FALLBACK_LANGS.find((item) => {
    const code = String(item.code).toLowerCase();
    const name = String(item.name).toLowerCase();
    const native =
      TARGET_NATIVE_NAMES[code] ||
      TARGET_NATIVE_NAMES[code.split("-")[0]] ||
      "";
    return (
      normalized === code ||
      normalized === name ||
      normalized === native.toLowerCase() ||
      normalized === `${name} (${native.toLowerCase()})`
    );
  });
  const code = String(entry?.code || normalized).toLowerCase();
  const name = entry?.name || raw;
  const native =
    TARGET_NATIVE_NAMES[code] || TARGET_NATIVE_NAMES[code.split("-")[0]] || "";
  const label = native && !name.includes(native) ? `${name} (${native})` : name;
  return `Translate every source unit into ${label}.`;
}

export function withoutLeadingTargetLanguageHeader(text) {
  return String(text || "")
    .replace(/^\s*Style prompt\s*:\s*(?:\r?\n)?/i, "")
    .replace(/^\s*Target language:\s*[^\r\n]*(?:\r?\n)?/i, "")
    .trim();
}

export function normalizePromptMode(_value) {
  // Legacy/missing modes are normalized during activation. The editable prompt
  // is always composed as one replace-style block on the provider wire.
  return "replace";
}

const REQUIRED_CANONICAL_PIECES = Object.freeze([
  "systemPolicy", "editableStyle", "targetLanguageInstruction",
  "sourceInputContract", "imageHint",
  "markerOutputContract", "structuredOutputContract",
  "seriesNotesHeading",
]);

export function assertCanonicalPromptPlan(plan) {
  const missing = REQUIRED_CANONICAL_PIECES.filter(
    (key) => typeof plan?.pieces?.[key] !== "string" || !plan.pieces[key].trim(),
  );
  if (missing.length) {
    const error = new Error(`AI canonical prompt has missing or empty pieces: ${missing.join(", ")}`);
    error.code = "canonical_prompt_contract_invalid";
    error.requestDispatched = false;
    error.generationAttempts = 0;
    error.providerAttempts = 0;
    throw error;
  }
  return plan;
}

export function composeCanonicalPrompt(
  plan,
  ai,
  hasImage,
  structuredOutput = true,
  targetLang = "",
) {
  assertCanonicalPromptPlan(plan);
  const pieces = plan?.pieces || {};
  const override = String(ai?.prompt || "").trim();
  normalizePromptMode(ai?.promptMode ?? ai?.prompt_mode);
  const builtIn = String(pieces.editableStyle || "").trim();
  const effectiveStyle = override || builtIn;
  const styleText = withoutLeadingTargetLanguageHeader(effectiveStyle) ||
    withoutLeadingTargetLanguageHeader(builtIn) ||
    "Write natural, faithful, in-character dialogue in the selected target language.";
  // The current UI selection is authoritative. A stale server/bundled target
  // header must never reject a valid custom style or translate to another language.
  const selectedLanguage = targetLanguagePriority(targetLang)
    .replace(/^Translate every source unit into\s+/i, "Target language: ");
  const canonical = true;
  const runtime = [];
  if (hasImage) runtime.push(String(pieces.imageHint || "").trim());
  runtime.push(memoryText(ai));
  const sections = {
    style: styleText,
    useStyleExamples: !override || withoutLeadingTargetLanguageHeader(override) === withoutLeadingTargetLanguageHeader(builtIn),
    policy: String(pieces.systemPolicy || "").trim(),
    language: selectedLanguage,
    source: String(pieces.sourceInputContract || "").trim(),
    output: String(
      structuredOutput
        ? pieces.structuredOutputContract
        : pieces.markerOutputContract,
    ).trim(),
    runtime: runtime.filter(Boolean).join("\n\n"),
  };
  return {
    system: joinCanonicalSystemSections(sections),
    sections,
    structured: canonical && structuredOutput,
    canonical,
  };
}

export function composeTranslationUserMessage({ sections, requestOutputContract, sourceRecords, targetLang, repairReason = "", expectedIds = [], structuredOutput = false }) {
  const blocks = [
    `TRANSLATION TASK\n${targetLanguagePriority(targetLang)}\nUse the translation style defined in your translator identity.\n${TASK_GUIDANCE}`,
  ];
  if (sections?.useStyleExamples) {
    const examples = buildStyleExamples(targetLang, expectedIds, structuredOutput);
    if (examples) blocks.push(examples);
  }
  const runtime = String(sections?.runtime || "").trim();
  if (runtime) blocks.push(`CONTEXT — READ ONLY, DO NOT TRANSLATE\n${runtime}`);
  const source = String(sections?.source || "").trim();
  if (source) blocks.push(source);
  const output = String(requestOutputContract || "").trim();
  if (output) blocks.push(output);
  const repair = wrongLanguageRepairInstruction(targetLanguagePriority(targetLang), repairReason);
  if (repair) blocks.push(repair);
  blocks.push(`SOURCE TEXT\n${String(sourceRecords || "")}`);
  return blocks.filter(Boolean).join("\n\n");
}

async function sha256Text(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const promptAuditSessionKey = (() => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
})();

export async function sessionPromptFingerprint(value) {
  return sha256Text(`${promptAuditSessionKey}\0${String(value || "")}`);
}

function buildStyleExamples(lang, expectedIds, structuredOutput) {
  const groups = STYLE_EXAMPLES[normalizeLanguageCode(lang)];
  if (!groups) return "";
  let nextId = Math.max(-1, ...expectedIds.map(id => Number(id.slice(1)))) + 1;
  const blocks = ["STYLE EXAMPLES — separate from the current scene; do not return these IDs. Edited illustrations of translation choices. Do not import their people, gender, setting or mood into SOURCE."];
  for (const group of groups) {
    const ids = group.source.map((_, i) => `P${nextId+i}`);
    nextId += ids.length;
    const source = group.source.map((value,i) => structuredOutput ? `${ids[i]}:${value}` : `<<TP_${ids[i]}:${value}>>`).join("\n");
    const output = structuredOutput ? JSON.stringify(Object.fromEntries(ids.map((key,i) => [key,group.target[i]]))) : ids.map((key,i) => `<<TP_${key}:${group.target[i]}>>`).join("\n");
    blocks.push(`Example ${group.label} context: ${group.context}\nExample ${group.label} source:\n${source}\nExample ${group.label} output:\n${output}`);
  }
  return blocks.join("\n\n");
}
