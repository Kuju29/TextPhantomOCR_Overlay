import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUNDLED_CANONICAL_PROMPT_PLANS as plans } from '../src/generated/canonical-prompt-plans.js';
import { composeCanonicalPrompt, composeTranslatorIdentitySystem, composeTranslationUserMessage } from '../src/shared/ai/direct-local/prompt.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync('python3', ['-c', `
import json,sys
sys.path.insert(0,'api')
from backend.ai.prompts.builder import build_translation_user_message,build_translator_identity_system,exact_request_output_contract
from backend.ai.prompts.styles import select_style,lang_style
out=[]
for lang in ['th','en','ja']:
 for structured in [False,True]:
  for mode in ['builtin','custom','prefixed_default']:
   override='' if mode=='builtin' else 'CUSTOM STYLE SENTINEL' if mode=='custom' else 'Style prompt:\\n'+lang_style(lang)
   for repair in ['', 'wrong_target_script']:
    source='P0:Hello' if structured else '<<TP_P0:Hello>>'
    style,_=select_style(lang,override)
    out.append(dict(lang=lang,structured=structured,override=override,mode=mode,repair=repair,source=source,system=build_translator_identity_system(style),user=build_translation_user_message(lang,override,source,['P0'],structured_output=structured,repair_reason=repair,prev_context=[{'src':'Previous line'}],page_context=[{'id':'neighbor','text':'…ต่อเนื่อง 😀'}]),contract=exact_request_output_contract(['P0'],structured_output=structured)))
print(json.dumps(out,ensure_ascii=False))
`], {cwd:root,encoding:'utf8'});
assert.equal(result.status,0,result.stderr);
const rows=JSON.parse(result.stdout);
for (const r of rows) {
 const c=composeCanonicalPrompt(plans[r.lang],{prompt:r.override,prev_context:[{src:'Previous line'}],page_context:[{id:'neighbor',text:'…ต่อเนื่อง 😀'}]},false,r.structured,r.lang);
 const system=composeTranslatorIdentitySystem(`${c.sections.language}\n${c.sections.style}`);
 const user=composeTranslationUserMessage({sections:{...c.sections,source:r.structured?'INPUT — tp.translation.schema-object/1\nEach source record is Pn:source text.':c.sections.source},requestOutputContract:r.contract,sourceRecords:r.source,targetLang:r.lang,repairReason:r.repair,expectedIds:['P0'],structuredOutput:r.structured});
 assert.equal(system,r.system,`${r.lang}/${r.mode}: system parity`);
 assert.equal(user,r.user,`${r.lang}/${r.mode}/${r.structured}: user parity`);
 assert.ok(user.endsWith('SOURCE TEXT\n'+r.source));
 assert.ok(!system.includes('Example A source:'));
 assert.equal(user.includes('STYLE EXAMPLES'),r.mode!=='custom');
 if(r.mode!=='custom') {
  assert.ok(user.indexOf('STYLE EXAMPLES')<user.indexOf('CONTEXT —'));
  assert.ok(user.indexOf('CONTEXT —')<user.indexOf('OUTPUT —'));
  const examples=user.split('STYLE EXAMPLES')[1].split('CONTEXT —')[0];
  assert.ok(!examples.includes('P0:')&&!examples.includes('"P0"'),'example IDs must not collide');
  assert.equal(examples.includes('<<TP_'),!r.structured);
 }
}
console.log(`PASS ${rows.length} API/Local System+User byte-parity cases; three targets, both formats, custom/default/prefixed styles, context and repair.`);

// Exercise the actual Local provider request with built-in examples enabled.
const {translateWithLocalOpenAi}=await import('../src/shared/ai/direct-local/generation.js');
const {SCHEMA_OBJECT_CONTRACT}=await import('../src/shared/ai/direct-local/output-contract.js');
const originalFetch=globalThis.fetch;
try {
 for(const lang of ['th','en','ja']) for(const structured of [false,true]) {
  const answer={th:'สวัสดี',en:'Hello',ja:'こんにちは'}[lang];let captured;let calls=0;
  globalThis.fetch=async (_url,init)=>{
   calls++;captured=JSON.parse(init.body);
   return new Response(JSON.stringify({model:'fixture',message:{role:'assistant',content:structured?JSON.stringify({P0:answer}):`<<TP_P0:${answer}>>`},done:true,done_reason:'stop'}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  await translateWithLocalOpenAi([{id:'original-id',text:'Hello'}],{targetLang:lang,canonicalPrompt:plans[lang],ai:{provider:'ollama',model:'fixture',local_adapter:{protocol:'ollama',baseUrl:'http://localhost:11434'},prompt:'',model_capabilities:{structuredOutput:{supported:structured,contract:SCHEMA_OBJECT_CONTRACT,source:'fixture'}}}});
  assert.equal(calls,1);
  const user=captured.messages[1].content;
  assert.match(user,/STYLE EXAMPLES/);
  assert.ok(user.endsWith('SOURCE TEXT\n'+(structured?'P0:Hello':'<<TP_P0:Hello>>')));
  const example=user.split('STYLE EXAMPLES')[1].split('INPUT —')[0];
  assert.equal(example.includes('<<TP_'),!structured);
  assert.ok(!example.includes('P0:')&&!example.includes('"P0"'));
  if(structured) assert.deepEqual(captured.format.required,['P0']);
 }
} finally {globalThis.fetch=originalFetch;}
console.log('PASS 6 actual Local dispatch captures: built-in examples, target language, active format, source last, one provider call.');
