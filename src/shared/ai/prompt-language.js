import { INSTRUCTION_PACKS } from "../../generated/instruction-packs.js";
import { normalizeLanguageCode } from "../../generated/language-code-aliases.js";
export function instructionLocale(lang) {
  const code = normalizeLanguageCode(lang);
  return Object.hasOwn(INSTRUCTION_PACKS, code) ? code : "en";
}
export const instructionPack = lang => INSTRUCTION_PACKS[instructionLocale(lang)];
export const formatInstruction = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
