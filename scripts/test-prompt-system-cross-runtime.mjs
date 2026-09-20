import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getCanonicalPrompt } from "../src/background/ai/prompt-cache.js";
import {
  composeCanonicalPrompt,
  exactRequestOutputContract,
  composeTranslatorIdentitySystem,
  composeTranslationUserMessage,
} from "../src/shared/ai/direct-local/prompt.js";

const style = "CROSS-RUNTIME STYLE: ลดคำแทนตัวและรักษาน้ำเสียงต้นฉบับ";
const ids = ["P0", "P1"];
const plan = await getCanonicalPrompt("", "th", { wantMemo: false });
const composed = composeCanonicalPrompt(
  plan, { prompt: style, promptMode: "replace" }, false, false, "th",
);
const extensionSystem = composeTranslatorIdentitySystem(`${composed.sections.language}\n${composed.sections.style}`, "th");

const program = [
  "from backend.ai import prompts",
  `style = ${JSON.stringify(style)}`,
  `ids = ${JSON.stringify(ids)}`,
  "from backend.ai.prompts.builder import build_translator_identity_system",
  "from backend.ai.prompts.styles import select_style",
  "import sys",
  "sys.stdout.buffer.write(build_translator_identity_system(select_style('th', style, 'replace')[0], 'th').encode('utf-8'))",
].join("\n");
const result = spawnSync(process.env.PYTHON || "python", ["-c", program], {
  cwd: new URL("../api", import.meta.url), encoding: "utf8",
});
assert.equal(result.status, 0, result.stderr || "Python prompt composer failed");
assert.equal(extensionSystem, result.stdout,
  "runs:Extension Local and API-backed Cloud/runs:API must use one byte-identical final system contract");
assert.equal(extensionSystem.split(style).length - 1, 1,
  "the selected editable style occurs once in System");
const user = composeTranslationUserMessage({sections:composed.sections,
  requestOutputContract:"OUTPUT",sourceRecords:"<<TP_P0:Hello>>",targetLang:"th"});
assert.equal(user.split(style).length-1, 0, "no duplicated style in User");
assert.equal(user.split("ภาษาปลายทาง: ภาษาไทย").length-1, 0);
assert.equal(extensionSystem.includes("ภาษาปลายทาง: ภาษาไทย"), true);
console.log("Cross-runtime prompt contract passed: byte-identical System, one selected System style and target header.");
