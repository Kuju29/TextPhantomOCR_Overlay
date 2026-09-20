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
assert select_style("th", "Target language: Thai\\nUse natural wording", "replace") == ("ภาษาปลายทาง: ภาษาไทย\\nUse natural wording", "saved_custom_replace")
assert select_style("th", lang_style("th"), "replace")[1] == "saved_default"
`], { cwd: apiRoot, encoding: "utf8" });

// Active provider prompt parity: all six source/target directions, not the
// deprecated all-in-System canonical fixture.
const { composeCanonicalPrompt,composeTranslatorIdentitySystem,composeTranslationUserMessage } = await import("../src/shared/ai/direct-local/prompt.js");
const { exactOutputInstruction } = await import("../src/shared/ai/direct-local/output-contract.js");
const { instructionPack } = await import("../src/shared/ai/prompt-language.js");
const directions=['en','ja','th'].flatMap(source=>['en','ja','th'].filter(target=>target!==source).map(target=>({source,target})));
const result=JSON.parse(execFileSync(process.env.PYTHON||'python',['-c',`
import json,sys
from backend.ai.prompts.styles import select_style
from backend.ai.prompts.builder import build_translation_user_message,build_translator_identity_system
out=[]
for c in json.load(sys.stdin):
 style,_=select_style(c['target'],'')
 out.append({'system':build_translator_identity_system(style,c['target']),
  'user':build_translation_user_message(c['target'],'','<<TP_P0:NEUTRAL_SOURCE>>',['P0'],source_lang=c['source'],structured_output=False,style_examples=True,memory_mode='full',series_state='Story context')})
print(json.dumps(out,ensure_ascii=True))
`],{cwd:apiRoot,encoding:'utf8',input:JSON.stringify(directions)}));
for(let i=0;i<directions.length;i++) {
 const {source,target}=directions[i],plan=await getCanonicalPrompt('',target);
 const c=composeCanonicalPrompt(plan,{memory_mode:'full',style_examples:true,series_state:'Story context'},false,false,target);
 const system=composeTranslatorIdentitySystem(`${c.sections.language}\n${c.sections.style}`,target);
 const user=composeTranslationUserMessage({sections:c.sections,requestOutputContract:exactOutputInstruction(['P0'],{kind:'compact_records'},target),sourceRecords:'<<TP_P0:NEUTRAL_SOURCE>>',targetLang:target,sourceLang:source,expectedIds:['P0'],structuredOutput:false});
 assert.equal(system,result[i].system,`${source}->${target}: native system`);
 assert.equal(user,result[i].user,`${source}->${target}: native user`);
 assert(user.endsWith(instructionPack(target).sourceHeading+'\n<<TP_P0:NEUTRAL_SOURCE>>'));
 assert.equal(system.split(c.sections.language).length-1,1);
 assert.equal(user.split(c.sections.language).length-1,0);
}
console.log('PASS all six source/target directions preserve native System/User bytes, source ownership and story context.');
