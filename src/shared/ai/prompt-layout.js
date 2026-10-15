import { buildStaticUserPrefix, buildStyleExamples, CONVERSATION_STYLE_EXAMPLE_LIMIT } from "./direct-local/prompt.js";
import { instructionLocale } from "./prompt-language.js";
import { LOCALIZATION_POLICY_VERSION } from "../../generated/localization-content.js";
import { normalizeLanguageCode } from "../../generated/language-code-aliases.js";
import {formatIndependentStoryExamples, humanExampleCount, independentExampleEvidence} from "./independent/examples.js";

async function digest(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function promptLayout(system, user, {targetLang, sourceLang="", structured=false,
  examples=false, memoryMode, selectedStyle, conversationRecords=false, independentExamples=null}={}) {
  const style = String(selectedStyle || "").trim();
  const prefix = buildStaticUserPrefix(targetLang, sourceLang, structured, examples, style, conversationRecords, independentExamples);
  const basePersistentPrefix = buildStaticUserPrefix(targetLang, sourceLang, structured, false, style, conversationRecords);
  // Conversation replays its first provider-visible User anchor byte-for-byte.
  const persistentPrefix = conversationRecords ? prefix : basePersistentPrefix;
  if (!user.startsWith(prefix + "\n\n")) throw new Error("prompt_static_prefix_mismatch");
  const actualExamples = examples !== true || independentExamples?.source === 'none' ? ''
    : independentExamples?.source === 'story' ? formatIndependentStoryExamples(independentExamples,targetLang)
    : buildStyleExamples(targetLang,[],structured,sourceLang,
      conversationRecords ? CONVERSATION_STYLE_EXAMPLE_LIMIT
        : independentExamples?.source === 'human' ? humanExampleCount(independentExamples) : undefined);
  // Example dialogue can quote the selected style. Count owned instructions,
  // while retaining the complete transmitted prefix for hashes and budgeting.
  const instructionPrefix = actualExamples ? prefix.replace('\n\n' + actualExamples,'') : prefix;
  const systemStyleCopies = system.split(style).length - 1;
  const userStyleCopies = instructionPrefix.split(style).length - 1;
  if (systemStyleCopies !== 1 || userStyleCopies !== 0) throw new Error("prompt_style_delivery_mismatch");
  const [styleSha256, systemSha256, userStaticSha256, userPersistentStaticSha256, staticPrefixSha256] = await Promise.all([
    digest(style), digest(system), digest(prefix), digest(persistentPrefix), digest(system+"\0"+prefix),
  ]);
  return {schema:"tp.prompt_layout/1", policyVersion:LOCALIZATION_POLICY_VERSION,
    styleRole:"system", systemStyleCopies, userStyleCopies, styleChars:Array.from(style).length, styleSha256,
    instructionLocale:instructionLocale(targetLang), targetLang:normalizeLanguageCode(targetLang), sourceLang:normalizeLanguageCode(sourceLang),
    examplesEnabled:examples===true && independentExamples?.source !== 'none',
    examplesIncluded:!!actualExamples,
    ...(independentExamples ? { independentExamples:independentExampleEvidence(independentExamples,actualExamples) } : {}),
    memoryMode:["off","terms","full"].includes(memoryMode)?memoryMode:"legacy_filtered",
    systemChars:Array.from(system).length, userStaticChars:Array.from(prefix).length,
    userPersistentStaticChars:Array.from(persistentPrefix).length,
    bootstrapExamplesChars:independentExamples?.source === 'story' ? 0 : Array.from(actualExamples).length,
    dynamicChars:Array.from(user).length-Array.from(prefix).length,
    systemSha256, userStaticSha256, userPersistentStaticSha256, staticPrefixSha256,
    countUnit:"unicode_characters", styleCountScope:"instruction_blocks", cacheHit:null, cacheSupport:"unknown"};
}
