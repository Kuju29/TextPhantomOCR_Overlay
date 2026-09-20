import { instructionPack, formatInstruction } from "./prompt-language.js";
export function wrongLanguageRepairInstruction(targetInstruction, reason = "", lang = "en") {
  return reason === "wrong_target_script" ? formatInstruction(instructionPack(lang).repair, {target: targetInstruction}) : "";
}
