import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getCanonicalPrompt } from "../src/background/ai/prompt-cache.js";
import {
  composeCanonicalPrompt,
  exactRequestOutputContract,
  joinCanonicalSystemSections,
} from "../src/shared/ai/direct-local/prompt.js";

const style = "CROSS-RUNTIME STYLE: ลดคำแทนตัวและรักษาน้ำเสียงต้นฉบับ";
const ids = ["P0", "P1"];
const plan = await getCanonicalPrompt("", "th", { wantMemo: false });
const composed = composeCanonicalPrompt(
  plan, { prompt: style, promptMode: "replace" }, false, false, "th",
);
const extensionSystem = joinCanonicalSystemSections({
  ...composed.sections,
  output: "",
  request: exactRequestOutputContract(ids),
});

const program = [
  "from backend.ai import prompts",
  `style = ${JSON.stringify(style)}`,
  `ids = ${JSON.stringify(ids)}`,
  "sections = prompts.build_system_sections('th', style, prompt_mode='replace', structured_output=False)",
  "sections = prompts.append_request_output_section(sections, ids)",
  "import sys",
  "sys.stdout.buffer.write(prompts.join_system_sections(sections).encode('utf-8'))",
].join("\n");
const result = spawnSync(process.env.PYTHON || "python", ["-c", program], {
  cwd: new URL("../api", import.meta.url), encoding: "utf8",
});
assert.equal(result.status, 0, result.stderr || "Python prompt composer failed");
assert.equal(extensionSystem, result.stdout,
  "runs:Extension Local and API-backed Cloud/runs:API must use one byte-identical final system contract");
assert.equal(extensionSystem.split(style).length - 1, 1,
  "the selected editable style must occur exactly once");
assert.equal(extensionSystem.split(plan.pieces.targetLanguageInstruction).length - 1, 1,
  "the selected target language must occur exactly once");

console.log("Cross-runtime prompt system contract passed: one byte-identical system for both execution owners.");
