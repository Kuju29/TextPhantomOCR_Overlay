import { instructionPack, formatInstruction } from "../prompt-language.js";
import { sourceContextText } from "../source-context.js";
import { pageContextText } from "../page-context.js";
import { wrongLanguageRepairInstruction } from "../repair-instruction.js";
import { normalizeLanguageCode } from "../../../generated/language-code-aliases.js";
import { FALLBACK_LANGS } from "../../constants.js";

import { TRANSLATOR_IDENTITY_BASE, TASK_GUIDANCE, STYLE_EXAMPLES } from "../../../generated/localization-content.js";
export { TRANSLATOR_IDENTITY_BASE };

export function composeTranslatorIdentitySystem(style, lang = "en") {
  const selected = String(style || "").trim();
  if (!selected) throw new Error("AI translation style is empty");
  const pack = instructionPack(lang);
  return `${pack.identity}\n\n${pack.styleHeading}\n${selected}`;
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
    `Return every supplied ID exactly once as <<TP_Pn:translated text>>. Keep both << and >> delimiters; the payload after ":" must be a non-empty translation. Expected IDs: ${ids.join(", ")}. ` +
    "Record order is irrelevant because results are matched by ID. Do not add, omit, merge, split or rename records. " +
    "Do not insert manual line breaks inside a payload. Return only the records, with no JSON, markdown, commentary or explanations.";
}

function glossaryText(entries, limit = 40, lang = "en") {
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
  return instructionPack(lang).glossary + lines.reverse().join("\n");
}

function characterText(characters, limit = 30, lang = "en") {
  if (!Array.isArray(characters)) return "";
  const lines = characters.slice(-limit).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const name = String(item.name || "").trim();
    if (!name) return [];
    const bits = [name];
    for (const key of ["gender", "speech", "note"]) {
      const value = String(item[key] || "").trim();
      if (value) bits.push(`${instructionPack(lang)[key]}: ${value}`);
    }
    return [`  - ${bits.join(" | ")}`];
  });
  if (!lines.length) return "";
  return instructionPack(lang).characters + lines.join("\n") + instructionPack(lang).characterRules;
}

function previousContextText(entries, limit = 6, lang = "en") {
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
  return lines.length ? instructionPack(lang).previous + lines.join("\n") : "";
}

function memoryText(ai, sourceUnits = null, lang = "en", wireIds = null) {
  const mode = ai?.memory_mode, full = mode == null || mode === "full";
  const terms = full || mode === "terms", pack = instructionPack(lang), blocks = [];
  const state = full ? String(ai?.series_state || "").trim() : "";
  if (state) blocks.push(pack.series + state);
  if (full) blocks.push(characterText(ai?.characters, 30, lang));
  if (terms) blocks.push(glossaryText(ai?.glossary, 40, lang));
  if (full && ai?.speakers && typeof ai.speakers === "object") {
    const lines = Object.keys(ai.speakers).sort((a,b) => (Number(a)||0)-(Number(b)||0)).slice(0,50)
      .filter(key => String(ai.speakers[key] || "").trim())
      .map(key => `  <<TP_P${key}>> = ${String(ai.speakers[key]).trim()}`);
    if (lines.length) blocks.push(pack.speakers + lines.join("\n"));
  }
  if (full) blocks.push(previousContextText(ai?.prev_context, 6, lang));
  blocks.push(pageContextText(ai?.page_context, lang));
  blocks.push(sourceContextText(ai?.source_context, sourceUnits, lang, wireIds));
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
  if (code === "th") return "แปลข้อความต้นฉบับทุกหน่วยเป็นภาษาไทย";
  if (code === "ja") return "原文の各単位を日本語に翻訳する。";
  const name = entry?.name || raw;
  const native =
    TARGET_NATIVE_NAMES[code] || TARGET_NATIVE_NAMES[code.split("-")[0]] || "";
  const label = native && !name.includes(native) ? `${name} (${native})` : name;
  return `Translate every source unit into ${label}.`;
}

export function withoutLeadingTargetLanguageHeader(text) {
  return String(text || "")
    .replace(/^\s*(?:Style prompt|สไตล์การแปล|翻訳方針)\s*:\s*(?:\r?\n)?/i, "")
    .replace(/^\s*(?:Target language|ภาษาปลายทาง|訳先言語):\s*[^\r\n]*(?:\r?\n)?/i, "")
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
  sourceUnits = null,
  wireIds = null,
) {
  assertCanonicalPromptPlan(plan);
  const pieces = plan?.pieces || {};
  const override = String(ai?.prompt || "").trim();
  normalizePromptMode(ai?.promptMode ?? ai?.prompt_mode);
  const builtIn = String(pieces.editableStyle || "").trim();
  const localizedDefault = value => {
    const code = normalizeLanguageCode(targetLang);
    if (!["th", "ja"].includes(code)) return value;
    return value.replaceAll("CHARACTER SHEET", code === "th" ? "ข้อมูลตัวละคร" : "人物情報")
      .replaceAll("SERIES MEMORY", code === "th" ? "ความจำเรื่อง" : "物語の記憶");
  };
  const savedDefault = !override || withoutLeadingTargetLanguageHeader(localizedDefault(override)) === withoutLeadingTargetLanguageHeader(builtIn);
  const effectiveStyle = savedDefault ? builtIn : override;
  const styleText = withoutLeadingTargetLanguageHeader(effectiveStyle) ||
    withoutLeadingTargetLanguageHeader(builtIn) ||
    "Write natural, faithful, in-character dialogue in the selected target language.";
  // The current UI selection is authoritative. A stale server/bundled target
  // header must never reject a valid custom style or translate to another language.
  const code = normalizeLanguageCode(targetLang);
  const pack = instructionPack(targetLang);
  const selectedLanguage = code === "th" ? "ภาษาปลายทาง: ภาษาไทย" : code === "ja" ? "訳先言語: 日本語" :
    targetLanguagePriority(targetLang).replace(/^Translate every source unit into\s+/i, "Target language: ");
  const canonical = true;
  const runtime = [];
  if (hasImage) runtime.push(pack.image);
  runtime.push(memoryText(ai, sourceUnits, targetLang, wireIds));
  const sections = {
    style: styleText,
    useStyleExamples: ai?.style_examples !== false,
    savedDefault,
    policy: String(pieces.systemPolicy || "").trim(),
    language: selectedLanguage,
    source: pack[structuredOutput ? "schemaInput" : "markerInput"],
    output: String(
      structuredOutput
        ? pieces.structuredOutputContract
        : pieces.markerOutputContract,
    ).trim(),
    runtime: runtime.filter(Boolean).join("\n\n"),
  };
  return {
    system: composeTranslatorIdentitySystem(`${sections.language}\n${sections.style}`, targetLang),
    sections,
    structured: canonical && structuredOutput,
    canonical,
  };
}

export function conversationRecordContract(targetLang, structuredOutput=false) {
  const code=normalizeLanguageCode(targetLang);
  if(structuredOutput){
    if(code==="th") return "INPUT/OUTPUT — tp.translation.image-records/1\nข้อความล่าสุดใช้ ID I<ภาพ>_P<หน่วย> ซึ่งระบุตำแหน่ง ไม่ใช่ผู้พูด ตอบเฉพาะ ID ในข้อความผู้ใช้ล่าสุดให้ครบครั้งเดียวด้วยคีย์เดิมใน JSON schema ค่าของแต่ละคีย์ต้องเป็นคำแปลเท่านั้น ห้ามคงข้อความต้นฉบับเป็นค่า และห้ามมีข้อความนอก JSON ห้ามตอบ ID เก่าซ้ำ";
    if(code==="ja") return "INPUT/OUTPUT — tp.translation.image-records/1\n最新入力は I<画像>_P<単位>。IDは位置で話者ではない。最新ユーザーメッセージのIDだけを同じJSONキーで一度ずつ返す。各キーの値には訳文だけを入れ、原文を値として残したりJSONの外に訳文や説明を書いたりしない。過去IDを再回答しない。";
    return "INPUT/OUTPUT — tp.translation.image-records/1\nLatest IDs are I<image>_P<unit>; they identify source locations, not speakers. Return only latest-user IDs exactly once using the same JSON keys. Each value must contain the translation only: never keep source text as the value or place translation/commentary outside the JSON. Previous turns are context only; do not repeat old IDs.";
  }
  if(code==="th") return "INPUT/OUTPUT — tp.translation.image-records/1\nรายการงานจริงใช้ <<I<ภาพ>_P<หน่วย>:ข้อความต้นฉบับ>> โดย I ระบุภาพและ P ระบุหน่วยในภาพ ไม่ใช่ผู้พูด ตอบเฉพาะ ID รูปแบบ I<เลข>_P<เลข> ที่อยู่ในข้อความผู้ใช้ล่าสุดให้ครบครั้งเดียวเป็น <<I<ภาพ>_P<หน่วย>:คำแปล>> ด้วย ID เดิม ข้อความหลังเครื่องหมาย : ภายใน marker ต้องเป็นคำแปลที่ไม่ว่าง และต้องคงเครื่องหมาย << กับ >> ให้ครบ ต้องแทนที่ข้อความต้นฉบับด้วยคำแปล ห้ามคงข้อความต้นฉบับไว้ใน marker แล้ววางคำแปลไว้นอก marker และห้ามมีข้อความใดนอก marker นอกจากช่องว่าง ห้ามตอบ ID เก่าซ้ำหรือเพิ่มคำอธิบาย";
  if(code==="ja") return "INPUT/OUTPUT — tp.translation.image-records/1\n実際の翻訳対象は <<I<画像>_P<単位>:原文>>。Iは画像、Pは画像内単位を示し、話者IDではない。最新ユーザーメッセージ内の I<数字>_P<数字> だけを同じIDの <<I<画像>_P<単位>:訳文>> で一度ずつ返す。コロンの後には空でない訳文だけを入れ、<< と >> を必ず保持する。原文をmarker内に残して訳文をmarker外へ書かない。marker外は空白以外を出力しない。過去IDを再回答しない。";
  return "INPUT/OUTPUT — tp.translation.image-records/1\nReal translation records use <<I<image>_P<unit>:source text>>. I identifies the image and P the unit; IDs are not speakers. Return only I<number>_P<number> IDs from the latest user message exactly once as <<I<image>_P<unit>:translated text>>. The text after ':' inside each marker must be a non-empty translation. Keep both << and >> delimiters and replace the source text with the translation. Never keep source text inside a marker and put its translation outside; output no non-whitespace text outside markers. Previous turns are context only.";
}

export function buildStaticUserPrefix(targetLang, sourceLang = "", structuredOutput = false, enabled = true, selectedStyle, conversationRecords = false) {
  const pack = instructionPack(targetLang);
  const style = String(selectedStyle || "").trim();
  if (!style) throw new Error("AI translation style is empty");
  const blocks = [`${pack.taskHeading}\n${targetLanguagePriority(targetLang)}`, `${pack.dataHeading}\n${pack.task}`];
  if (!conversationRecords) blocks.push(pack[structuredOutput ? "schemaInput" : "markerInput"]);
  if (enabled) {
    const examples = buildStyleExamples(targetLang, [], structuredOutput, sourceLang);
    if (examples) blocks.push(examples);
  }
  // Conversation owns one stable image/unit marker contract. Keep this final in
  // the immutable first User anchor so small/local models see the live ID rule
  // immediately before SOURCE. Legacy/Independent
  // retains its established marker-before-examples byte layout.
  if (conversationRecords) blocks.push(conversationRecordContract(targetLang, structuredOutput));
  return blocks.join("\n\n");
}

export function composeTranslationUserMessage({ sections, requestOutputContract, sourceRecords, targetLang, repairReason = "", expectedIds = [], structuredOutput = false, sourceLang = "", conversationRecords = false }) {
  const pack = instructionPack(targetLang);
  const style = [sections?.language, sections?.style].filter(Boolean).join("\n");
  const blocks = [buildStaticUserPrefix(targetLang, sourceLang, structuredOutput, sections?.useStyleExamples !== false, style, conversationRecords)];
  const runtime = String(sections?.runtime || "").trim();
  if (runtime) blocks.push(`${pack.contextHeading}\n${runtime}`);
  const output = String(requestOutputContract || "").trim();
  if (output && !conversationRecords) blocks.push(output);
  const repair = wrongLanguageRepairInstruction(targetLanguagePriority(targetLang), repairReason, targetLang);
  if (repair) blocks.push(repair);
  blocks.push(`${pack.sourceHeading}\n${String(sourceRecords || "")}`);
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

export function buildStyleExamples(lang, expectedIds, structuredOutput, sourceLang = "") {
  const target = normalizeLanguageCode(lang);
  if (!["en", "ja", "th"].includes(target)) return "";
  const pack = instructionPack(lang);
  const blocks = [pack.examplesHeading];
  for (const row of STYLE_EXAMPLES) {
    blocks.push([row.id, `EN: ${row.en}`, `JA: ${row.ja}`, `TH: ${row.th}`].join("\n"));
  }
  return blocks.join("\n\n");
}
