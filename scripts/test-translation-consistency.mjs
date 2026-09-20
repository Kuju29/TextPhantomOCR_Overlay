import assert from 'node:assert/strict';
import { instructionPack } from '../src/shared/ai/prompt-language.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUNDLED_CANONICAL_PROMPT_PLANS as plans } from '../src/generated/canonical-prompt-plans.js';
import { composeCanonicalPrompt, composeTranslatorIdentitySystem, composeTranslationUserMessage } from '../src/shared/ai/direct-local/prompt.js';
import { captureSourceEvidence, repairSourceContext } from '../src/background/repair/source-evidence.js';
import { normalizeSourceContext, sourceContextText } from '../src/shared/ai/source-context.js';
import { createPromptInputEstimator } from '../src/shared/ai/workload/prompt-input.js';
import { estimateRequest, initialProfile, textWeight } from '../src/shared/ai/workload/model.js';
import { exactOutputInstruction, translationObjectSchema, SCHEMA_OBJECT_CONTRACT } from '../src/shared/ai/direct-local/output-contract.js';
import { translateWithLocalOpenAi } from '../src/shared/ai/direct-local/generation.js';
import { buildOllamaGeneration } from '../src/shared/ai/providers/local-ollama.js';
const root = fileURLToPath(new URL('../', import.meta.url));

function page(pageId) {
  const units = Array.from({length: 10}, (_, i) => ({id:`g${i}`,text:`${pageId} source ${i} 😀`,sourceHash:`${pageId}:${i}`,translatable:true}));
  const p = {pageId,units,sourceEvidence:[],accepted:[{id:'g0',text:'DO NOT USE THIS ANSWER AS STYLE'}]};
  captureSourceEvidence(p, {operationId:'initial-a',ids:['g0','g1','g2','g3'],contextIds:['g4','g5','g6','g7','g8','g9']});
  return p;
}
const first=page('first'), second=page('second'), pages=new Map([[first.pageId,first],[second.pageId,second]]);
const row = (p,index,id) => ({...p.units[index],unitId:`g${index}`,id,pageId:p.pageId});
const targets=[row(first,1,'R7'),row(second,2,'R8')];
const evidence=repairSourceContext(pages,targets);
assert.equal(evidence.length,2);
assert.equal(evidence[0].units.length,9,'preserve the entire original view, not six neighbors of a now-single target');
assert.ok(evidence[0].units.every(r=>r.text.startsWith('first')));
assert.ok(evidence[1].units.every(r=>r.text.startsWith('second')));
assert.ok(!JSON.stringify(evidence).includes('DO NOT USE THIS ANSWER'));
assert.deepEqual(normalizeSourceContext(evidence,targets).map(g=>g.targetIds),[['P0'],['P1']]);
assert.equal(JSON.stringify(evidence),JSON.stringify(repairSourceContext(structuredClone(pages),targets)),'worker restart retains evidence');
assert.throws(()=>repairSourceContext(pages,[{...targets[0],text:'changed'}]),/repair_source_evidence_conflict/);
const before=JSON.stringify(first.sourceEvidence);
captureSourceEvidence(first,{operationId:'initial-a',ids:['g0','g1','g2','g3'],contextIds:['g4','g5','g6','g7','g8','g9']});
assert.equal(JSON.stringify(first.sourceEvidence),before);
assert.throws(()=>captureSourceEvidence(first,{operationId:'initial-a',ids:['g0'],contextIds:[]}),/source_evidence_conflict/);
assert.throws(()=>sourceContextText([{targetIds:['P0'],units:[{id:'x',text:'x'.repeat(4001)}]}]),/invalid_source_context_unit/);
assert.throws(()=>sourceContextText([{targetIds:['P0'],units:Array.from({length:16},(_,i)=>({id:`x${i}`,text:'x'.repeat(4000)}))}]),/source_context_budget_exceeded/);
console.log('PASS source-evidence invariants: original scope, >6 neighbors, multiple pages, restart, no generated memory, conflict and size guards.');

const rows=[];
for(const sourceLang of ['en','ja','th','','mixed']) for(const targetLang of ['en','ja','th']) {
 if(sourceLang===targetLang) continue;
 for(const structured of [false,true]) for(const custom of [false,true]) {
  rows.push({sourceLang,targetLang,structured,custom,sourceContext:evidence,targets});
 }
}
const py=spawnSync(process.env.PYTHON || 'python',['-c',`
import json,sys
sys.path.insert(0,'api')
from backend.ai.prompts.builder import build_translation_user_message,build_translator_identity_system,exact_request_output_contract
from backend.ai.prompts.styles import select_style
from backend.application.ai_translation.request_validation import build_config
from backend.ai.prompts.source_context import build_source_context_block
out=[]
for row in json.load(sys.stdin):
 ids=['P0','P1']; lang=row['targetLang']; structured=row['structured']
 source='\\n'.join(f'{key}:SOURCE {index}' if structured else f'<<TP_{key}:SOURCE {index}>>' for index,key in enumerate(ids))
 prompt='CUSTOM STYLE SENTINEL' if row['custom'] else ''
 config=build_config({'provider':{'id':'ollama'},'units':row['targets'],'sourceLang':row['sourceLang'],'sourceContext':row['sourceContext']})
 style,_=select_style(lang,prompt)
 out.append(dict(system=build_translator_identity_system(style,lang),source=source,
   context=build_source_context_block(config.source_context),
   user=build_translation_user_message(lang,prompt,source,ids,structured_output=structured,source_lang=config.source_lang,source_context=config.source_context,repair_reason='wrong_target_script')))
print(json.dumps(out,ensure_ascii=False))
`],{cwd:root,input:JSON.stringify(rows),encoding:'utf8'});
assert.equal(py.status,0,py.stderr);
const outputs=JSON.parse(py.stdout);
for(let index=0;index<rows.length;index++) {
 const r=rows[index], expected=outputs[index], ids=['P0','P1'], kind=r.structured?'schema_object':'compact_records';
 const ai={prompt:r.custom?'CUSTOM STYLE SENTINEL':'',source_context:evidence,repair_reason:'wrong_target_script'};
 const c=composeCanonicalPrompt(plans[r.targetLang],ai,false,r.structured,r.targetLang,targets);
 const system=composeTranslatorIdentitySystem(`${c.sections.language}\n${c.sections.style}`,r.lang || r.targetLang);
 const user=composeTranslationUserMessage({sections:{...c.sections,source:r.structured?'INPUT — tp.translation.schema-object/1\nEach source record is Pn:source text.':c.sections.source},requestOutputContract:exactOutputInstruction(ids,{kind},r.targetLang),sourceRecords:expected.source,targetLang:r.targetLang,sourceLang:r.sourceLang,repairReason:ai.repair_reason,expectedIds:ids,structuredOutput:r.structured});
 const label=JSON.stringify([r.sourceLang,r.targetLang,r.structured,r.custom]);
 assert.equal(system,expected.system,label+' system'); assert.equal(user,expected.user,label+' user');
 assert.equal(sourceContextText(evidence,targets),expected.context);
 assert.ok(user.endsWith(instructionPack(r.targetLang).sourceHeading+'\n'+expected.source));
 assert.equal(user.includes(instructionPack(r.targetLang).examplesHeading),true);
 const estimate=createPromptInputEstimator({ai,sourceLang:r.sourceLang,targetLang:r.targetLang,contract:kind});
 const actualUnits=targets.map((t,i)=>({...t,text:`SOURCE ${i}`}));
 const budget=estimateRequest(actualUnits,initialProfile(),{contract:kind,limits:{},reasoningActive:false,estimateFixedInput:units=>estimate(units,units,evidence),fixedInput:0});
 const actual=textWeight(system)+textWeight(user)+(r.structured?textWeight(JSON.stringify(translationObjectSchema(ids))):0);
 assert.ok(budget.estimatedInput>=actual,label+' actual captured context must fit reserved budget');
}
console.log(`PASS ${rows.length} cross-runtime source-direction / custom-style / output-format / captured-context byte-parity and budget cases.`);

const originalFetch=globalThis.fetch; const captures=[];
try {
 for(const structured of [false,true]) {
  globalThis.fetch=async(_url,init)=>{captures.push(JSON.parse(init.body));return new Response(JSON.stringify({model:'fixture',message:{role:'assistant',content:structured?'{"P0":"รับทราบ","P1":"ตกลง"}':'<<TP_P0:รับทราบ>><<TP_P1:ตกลง>>'},done:true,done_reason:'stop'}),{status:200,headers:{'Content-Type':'application/json'}});};
  const answer=await translateWithLocalOpenAi(targets,{targetLang:'th',sourceLang:'en',canonicalPrompt:plans.th,ai:{provider:'ollama',model:'fixture',prompt:'',thinking:'off',source_context:evidence,local_adapter:{protocol:'ollama',baseUrl:'http://localhost:11434'},model_capabilities:{reasoning:{supported:true,control:'boolean'},structuredOutput:{supported:structured,contract:SCHEMA_OBJECT_CONTRACT,source:'fixture'}}}});
  const request=captures.at(-1), text=request.messages[1].content;
  assert.ok(text.includes(instructionPack('th').captured));
  assert.ok(text.includes('"appliesTo":["P0"]')&&text.includes('"appliesTo":["P1"]'));
  assert.ok(!text.includes('R7')&&!text.includes('R8'));
  assert.equal(request.think,false);
  assert.equal(request.options.temperature,0.2);assert.equal(request.options.seed,0);
  assert.deepEqual(answer.translations.map(r=>r.id),['R7','R8']);
 }
} finally {globalThis.fetch=originalFetch;}
assert.equal(captures.length,2,'one call per generation, not an editor/critic cascade');
const body=buildOllamaGeneration({model:'fixture',messages:[],outputTokens:128,thinkingMode:'default'});
assert.ok(!('think' in body),'unsupported thinking still omitted');
console.log('PASS 2 real Local transport boundaries captured with a fake network: context alias mapping, stable native sampling, Think off, source/output IDs.');
