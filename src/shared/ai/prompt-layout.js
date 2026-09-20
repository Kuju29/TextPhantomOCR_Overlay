import { buildStaticUserPrefix, buildStyleExamples } from "./direct-local/prompt.js";
import { instructionLocale } from "./prompt-language.js";
import { LOCALIZATION_POLICY_VERSION } from "../../generated/localization-content.js";
import { normalizeLanguageCode } from "../../generated/language-code-aliases.js";

async function digest(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function promptLayout(system, user, {targetLang, sourceLang="", structured=false,
  examples=true, memoryMode, selectedStyle, conversationRecords=false}={}) {
  const style = String(selectedStyle || "").trim();
  const prefix = buildStaticUserPrefix(targetLang, sourceLang, structured, examples, style, conversationRecords);
  const basePersistentPrefix = buildStaticUserPrefix(targetLang, sourceLang, structured, false, style, conversationRecords);
  // Conversation replays its first provider-visible User anchor byte-for-byte;
  // therefore its entire static prefix, including human examples, is persistent.
  const persistentPrefix = conversationRecords ? prefix : basePersistentPrefix;
  if (!user.startsWith(prefix + "\n\n")) throw new Error("prompt_static_prefix_mismatch");
  // Instruction occurrences only: OCR may legitimately contain arbitrary text.
  const systemStyleCopies = system.split(style).length - 1;
  const userStyleCopies = prefix.split(style).length - 1;
  if (systemStyleCopies !== 1 || userStyleCopies !== 0) throw new Error("prompt_style_delivery_mismatch");
  const [styleSha256, systemSha256, userStaticSha256, userPersistentStaticSha256, staticPrefixSha256] = await Promise.all([
    digest(style), digest(system), digest(prefix), digest(persistentPrefix), digest(system+"\0"+prefix),
  ]);
  return {schema:"tp.prompt_layout/1", policyVersion:LOCALIZATION_POLICY_VERSION,
    styleRole:"system", systemStyleCopies, userStyleCopies, styleChars:Array.from(style).length, styleSha256,
    instructionLocale:instructionLocale(targetLang), targetLang:normalizeLanguageCode(targetLang), sourceLang:normalizeLanguageCode(sourceLang),
    examplesEnabled:examples!==false, examplesIncluded:examples!==false&&!!buildStyleExamples(targetLang,[],structured,sourceLang),
    memoryMode:["off","terms","full"].includes(memoryMode)?memoryMode:"legacy_filtered",
    systemChars:Array.from(system).length, userStaticChars:Array.from(prefix).length,
    userPersistentStaticChars:Array.from(persistentPrefix).length,
    bootstrapExamplesChars: examples!==false
      ? Array.from(buildStyleExamples(targetLang,[],structured,sourceLang)||"").length : 0,
    dynamicChars:Array.from(user).length-Array.from(prefix).length,
    systemSha256, userStaticSha256, userPersistentStaticSha256, staticPrefixSha256,
    countUnit:"unicode_characters", styleCountScope:"instruction_blocks", cacheHit:null, cacheSupport:"unknown"};
}
