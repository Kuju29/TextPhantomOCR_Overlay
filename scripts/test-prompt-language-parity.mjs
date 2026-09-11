import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { targetLanguagePriority } from "../src/shared/ai/direct-local/generation.js";
import { FALLBACK_LANGS } from "../src/shared/constants.js";

const apiRoot = fileURLToPath(new URL("../api/", import.meta.url));

const languages = [...new Set(FALLBACK_LANGS.flatMap(({ code, name }) => [code, name]))];
languages.push("jp", " JP ", "ja", "ภาษาไทย", "Thai (ภาษาไทย)", "日本語", "Japanese (日本語)", "한국어", "Korean (한국어)",
  "简体中文", "Chinese (Simplified) (简体中文)", "繁體中文", "Chinese (Traditional) (繁體中文)", "x-private-lang", "");
const python = [
  "import json, sys",
  "from backend.ai.prompts import target_language_priority",
  "print(json.dumps({code: target_language_priority(code) for code in sys.argv[1:]}, ensure_ascii=True))",
].join(";");

function readPythonPriorities(extraEnv = {}) {
  return JSON.parse(execFileSync(process.env.PYTHON || "python", ["-c", python, ...languages], {
    cwd: apiRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  }));
}

const api = readPythonPriorities();
const apiCp874 = readPythonPriorities({ PYTHONIOENCODING: "cp874" });

assert.deepEqual(apiCp874, api, "ASCII-safe Python JSON must survive a CP874 stdout unchanged");

for (const code of languages) {
  assert.equal(targetLanguagePriority(code), api[code], `JS/Python target instruction drifted for ${code}`);
}

for (const code of ["ภาษาไทย", "日本語", "한국어", "简体中文", "繁體中文"]) {
  assert.equal(apiCp874[code], api[code], `CP874 JSON round-trip changed Unicode value for ${code}`);
}

const thai = targetLanguagePriority("th");
assert.equal(targetLanguagePriority("Thai"), thai);
assert.equal(targetLanguagePriority("ภาษาไทย"), thai);
assert.equal(targetLanguagePriority("Thai (ภาษาไทย)"), thai);
assert.doesNotMatch(targetLanguagePriority("x-private-lang"), /Unknown/);
assert.doesNotMatch(targetLanguagePriority(""), /Unknown|into English/);

console.log("Target-language prompt parity passed for every UI language, display/native aliases and safe unknowns.");

assert.equal(targetLanguagePriority("jp"), targetLanguagePriority("ja"));
const { normalizeLanguageCode } = await import("../src/generated/language-code-aliases.js");
const { getCanonicalPrompt } = await import("../src/background/ai/prompt-cache.js");
assert.equal(normalizeLanguageCode(" JP "), "ja", "source and target codes share canonical alias");
assert.deepEqual(await getCanonicalPrompt("", "jp"), await getCanonicalPrompt("", "ja"));
const normalizedSource = execFileSync(process.env.PYTHON || "python", ["-c",
  "from backend.lens.languages import normalize; from backend.ai.prompts.styles import lang_style; assert normalize(' JP ') == 'ja'; assert lang_style('jp') == lang_style('ja'); print('ok')"], { cwd: apiRoot, encoding: "utf8" });
assert.equal(normalizedSource.trim(), "ok");

execFileSync(process.env.PYTHON || "python", ["-c", `
from backend.ai.prompts.styles import lang_style, select_style
try:
    select_style("th", "Target language: Thai\\n  ", "replace")
except ValueError:
    pass
else:
    raise AssertionError("header-only style accepted")
assert select_style("th", "Target language: Thai\\nUse natural wording", "replace") == ("Target language: Thai (ภาษาไทย).\\nUse natural wording", "saved_custom_replace")
assert select_style("th", lang_style("th"), "replace")[1] == "saved_default"
`], { cwd: apiRoot, encoding: "utf8" });

// Exercise real cloud/local composition in all six source/target directions.
// These are wiring checks, not a model-quality benchmark.
const { readFileSync } = await import("node:fs");
const { composeCanonicalPrompt } = await import("../src/shared/ai/direct-local/prompt.js");
const { exactRequestOutputContract, joinCanonicalSystemSections } = await import("../src/shared/ai/direct-local/prompt.js");
const { BUNDLED_CANONICAL_PROMPT_PLANS } = await import("../src/generated/canonical-prompt-plans.js");
const evaluation = JSON.parse(readFileSync(new URL("./fixtures/neutral-translation-six-directions.json", import.meta.url), "utf8"));
const cloudCases = JSON.parse(execFileSync(process.env.PYTHON || "python", ["-c", `
import json, sys
from backend.ai import prompts
from backend.ai.prompts.builder import build_user_parts
from backend.ai.prompts.styles import lang_style
cases = json.load(sys.stdin)
results = []
for c in cases:
    sections = prompts.build_system_sections(c["target"], lang_style(c["target"]), want_memo=False, series_state="An ordinary school day.", characters=[{"name": "Mina", "gender": "unknown", "speech": "calm"}], structured_output=False)
    sections = prompts.append_request_output_section(sections, ["P0"], structured_output=False)
    results.append({"system": prompts.join_system_sections(sections), "user": build_user_parts(c["text"])[0]})
print(json.dumps(results, ensure_ascii=True))
`], {
  cwd: apiRoot, encoding: "utf8",
  input: JSON.stringify(evaluation.directions.map(({ source, target }) => ({
    target, text: `<<TP_P0:${evaluation.cases[1].sources[source]}>>`,
  }))),
}));
const normalizeSpace = (text) => text.replace(/\s+/gu, " ").trim();
for (const [index, { source, target }] of evaluation.directions.entries()) {
  const plan = BUNDLED_CANONICAL_PROMPT_PLANS[target];
  const local = composeCanonicalPrompt(plan, { prompt: plan.pieces.editableStyle, promptMode: "replace", series_state: "An ordinary school day.", characters: [{ name: "Mina", gender: "unknown", speech: "calm" }] }, false, false, target);
  const localSystem = joinCanonicalSystemSections({
    ...local.sections, output: "", request: exactRequestOutputContract(["P0"]),
  });
  const cloud = cloudCases[index];
  assert.equal(normalizeSpace(localSystem), normalizeSpace(cloud.system), `${source}>${target}: complete cloud/local instructions differ`);
  assert.equal(cloud.user, `<<TP_P0:${evaluation.cases[1].sources[source]}>>`,
    "cloud user payload contains literal OCR records only");
  assert.match(local.sections.language, /^Target language: /, "target selection belongs only to Style prompt");
  assert.equal(localSystem.indexOf(local.sections.language) > localSystem.indexOf("Style prompt:"), true,
    "target selection must be inside Style prompt, not System prompt");
  assert.match(local.sections.source, /Each source record is <<TP_Pn:source text>>/);
  assert.match(local.sections.policy, /Correct missing, extra or misread characters/);
  assert.doesNotMatch(local.sections.policy, /rules below control output structure only/);
  assert.match(localSystem, /OUTPUT — tp\.translation\.compact-records\/1/);
  assert.match(localSystem, /Return every supplied ID exactly once/);
}
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.th.pieces.editableStyle, /Omit obvious subjects and person-pronouns/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.th.pieces.editableStyle, /CHARACTER SHEET and SERIES MEMORY/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.th.pieces.editableStyle, /Distinguish obligation, ability, permission, desire, resolve and prediction/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.th.pieces.editableStyle, /คำเรียกที่คั่นด้วยจังหวะหรือเครื่องหมายวรรคตอนยังเป็นคำเรียกขาน/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.th.pieces.editableStyle, /ใช้บริบทคลี่คลายความกำกวมได้ แต่ห้ามแทนที่ความหมายที่ชัดเจนของต้นฉบับ/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.th.pieces.editableStyle, /Never move, merge, duplicate or discard meaning across IDs/);
assert.doesNotMatch(BUNDLED_CANONICAL_PROMPT_PLANS.th.pieces.editableStyle, /Silently check meaning|MICRO-EXAMPLES/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.en.pieces.editableStyle, /unnecessary “you”/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.en.pieces.editableStyle, /Distinguish obligation, ability, permission, desire, resolve and prediction/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.en.pieces.editableStyle, /Keep vocatives as addresses/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.en.pieces.editableStyle, /Context may resolve ambiguity, but never override clear source meaning/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.en.pieces.editableStyle, /Never move, merge, duplicate or discard meaning across IDs/);
assert.doesNotMatch(BUNDLED_CANONICAL_PROMPT_PLANS.en.pieces.editableStyle, /Silently check meaning|MICRO-EXAMPLES/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.ja.pieces.editableStyle, /省ける主語や代名詞は省き/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.ja.pieces.editableStyle, /義務・能力・許可・願望・決意・予測を区別し/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.ja.pieces.editableStyle, /間や句読点で区切られた呼称は呼びかけのまま保ち/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.ja.pieces.editableStyle, /文脈で曖昧さを解消してよいが、明確な原文の意味を上書きしない/);
assert.match(BUNDLED_CANONICAL_PROMPT_PLANS.ja.pieces.editableStyle, /意味を別IDへ移動・結合・複製したり、省いたりしない/);
assert.doesNotMatch(BUNDLED_CANONICAL_PROMPT_PLANS.ja.pieces.editableStyle, /Silently check meaning|MICRO-EXAMPLES/);

// Python is the canonical byte reference for the final provider boundary.
const boundaryFixture = JSON.parse(execFileSync(process.env.PYTHON || "python", ["-c", `
import json
from backend.ai import prompts
source = "<<TP_P0:原文หนึ่ง>>\\n<<TP_P1:原文สอง>>"
print(json.dumps(prompts.canonical_boundary_fixture(
    "th", prompts.lang_style("th"), ("P0", "P1"), source,
    prompt_mode="replace", structured_output=False, want_memo=False,
), ensure_ascii=True))
`], { cwd: apiRoot, encoding: "utf8" }));
const boundaryPlan = BUNDLED_CANONICAL_PROMPT_PLANS.th;
const boundaryLocal = composeCanonicalPrompt(boundaryPlan, {
  prompt: boundaryPlan.pieces.editableStyle, promptMode: "replace",
}, false, false, "th");
const boundarySystem = joinCanonicalSystemSections({
  ...boundaryLocal.sections,
  output: "",
  request: exactRequestOutputContract(["P0", "P1"]),
});
assert.equal(boundarySystem, boundaryFixture.system,
  "Direct Local final system bytes must equal the API canonical fixture");
assert.equal(boundaryFixture.user, "<<TP_P0:原文หนึ่ง>>\n<<TP_P1:原文สอง>>",
  "canonical provider user bytes must be literal TP OCR records");
console.log("Six-direction cloud/local prompt composition and source/target ownership passed.");
