import assert from 'node:assert/strict';
import {createWorkloadController} from '../src/background/ai/workload-controller.js';
import {planIndependentExamples} from '../src/background/ai/independent-example-budget.js';
import {getCanonicalPrompt} from '../src/background/ai/prompt-cache.js';
import {translateWithLocalOpenAi} from '../src/shared/ai/direct-local/generation.js';
import {humanExampleCount} from '../src/shared/ai/independent/examples.js';
import {localAiPreset} from '../src/shared/ai/providers/local-registry.js';
import {discoverLocalModels} from '../src/shared/ai/direct-local/model-discovery.js';
import {userMessageForCode} from '../src/shared/error-contract.js';

const deepseek='deepseek/deepseek-r1-0528-qwen3-8b',gemma='google/gemma-4-e4b';
const native=context=>({models:[
  {type:'llm',key:deepseek,loaded_instances:[{id:deepseek,config:{context_length:context}}],
    capabilities:{reasoning:{allowed_options:['on'],default:'on'}}},
  {type:'llm',key:gemma,loaded_instances:[],capabilities:{reasoning:{allowed_options:['off','on']}}},
  {type:'embedding',key:'nomic-embed',loaded_instances:[]},
]});
const previousFetch=globalThis.fetch,posts=[];
let context=8192;
globalThis.fetch=async (url,init={})=>{
  if(String(url).endsWith('/api/v1/models')) return Response.json(native(context));
  if(String(url).endsWith('/v1/models')) return Response.json({data:[
    {id:deepseek},{id:'nomic-embed'},{id:'dspark-draft'}]});
  assert.ok(String(url).endsWith('/api/v1/chat'));
  const body=JSON.parse(init.body);posts.push(body);
  assert.equal(body.model,deepseek,'never swap to the other LLM');
  return Response.json({model_instance_id:deepseek,output:[{type:'message',content:'<<TP_P0:สวัสดี>>'}],
    stats:{input_tokens:3400,total_output_tokens:26,reasoning_output_tokens:0}});
};
try {
  const adapter=localAiPreset('lmstudio');
  const listed=await discoverLocalModels(adapter,{provider:'lmstudio',model:deepseek,verifySelected:true});
  assert.deepEqual(listed.models,[deepseek,gemma]);
  assert.deepEqual(listed.selectableModels,[deepseek]);
  assert.equal(listed.selectedModelVerification.status,'passed');
  assert.equal((await discoverLocalModels(adapter,{provider:'lmstudio',model:gemma,verifySelected:true}))
    .selectedModelVerification.status,'model_not_loaded');

  const ai={provider:'lmstudio',model:deepseek,base_url:adapter.baseUrl,local_adapter:adapter,
    thinking:'minimum',translation_mode:'independent',style_examples:true,prompt:'',
    independent_examples:{source:'human',pairs:[],scopeStatus:'document',storageStatus:'ready'},
    model_capabilities:listed.capability.models[deepseek]};
  const rows=[{id:'raw-0',text:'HELLO.'}];
  const storage={}, controller=createWorkloadController({read:async key=>({[key]:storage[key]}),
    write:async patch=>Object.assign(storage,patch),emit:()=>{}});
  const open=(settings)=>controller.open({ai:settings,route:'direct-local',targetLang:'th',sourceLang:'en',
    pageUnits:rows,wholePageFirst:true,phase:'initial'});
  const session=await open(ai);
  const chosen=planIndependentExamples(session,rows,0,ai.independent_examples);
  assert.equal(chosen.availableExamplePairs,4,'only four of the 69 catalog entries are default examples');
  assert.equal(chosen.includedExamplePairs,4);
  assert.equal(chosen.includedExamplePairs,humanExampleCount(chosen.selection));
  assert.equal(chosen.chunk.estimate.fitsHard,true);
  const tightPrompt='ภาษาไทย'.repeat(1050);
  const tightSession=await open({...ai,prompt:tightPrompt});
  tightSession.setIndependentExamples(ai.independent_examples);
  assert.throws(()=>tightSession.next(rows,0),e=>e.code==='ai_workload_budget_insufficient'&&
    e.requestDispatched===false);
  const tight=planIndependentExamples(tightSession,rows,0,ai.independent_examples);
  assert.ok(tight.includedExamplePairs>=1&&tight.includedExamplePairs<4);
  assert.equal(posts.length,0,'planning and discovery cannot call the generator');
  const canonicalPrompt=await getCanonicalPrompt(tightPrompt, 'th', {wantMemo:false});
  const result=await translateWithLocalOpenAi(tight.chunk.units,{ai:{...tightSession.ai,
    workload:{version:1,...tight.chunk.estimate}},canonicalPrompt,targetLang:'th',sourceLang:'en'});
  assert.equal(result.translations[0].text,'สวัสดี');
  assert.equal(posts.length,1);
  assert.equal(posts[0].reasoning,'on','Lowest available respects mandatory reasoning');
  assert.match(posts[0].input,/H01\nEN:/);
  assert.doesNotMatch(posts[0].input,/H05\nEN:/);

  context=16384;
  const larger=await discoverLocalModels(adapter,{provider:'lmstudio',model:deepseek,verifySelected:true});
  const expanded=await open({...ai,prompt:tightPrompt,model_capabilities:larger.capability.models[deepseek]});
  const full=planIndependentExamples(expanded,rows,0,ai.independent_examples);
  assert.equal(full.includedExamplePairs,4,'larger verified context retains the bounded style sample');
  const configuredExamples={...ai.independent_examples,humanExampleCount:8};
  const configured=await open({...ai,independent_examples:configuredExamples,
    model_capabilities:larger.capability.models[deepseek]});
  assert.equal(planIndependentExamples(configured,rows,0,configuredExamples).includedExamplePairs,8,
    'explicit example count stays authoritative despite the smaller default');

  const missingPrompt='ภาษาไทย'.repeat(1045);
  const repairRows=[{id:'missing-0',text:'HELLO.',reason:'missing'}];
  const repair=await controller.open({ai:{...ai,prompt:missingPrompt,repair_reason:'wrong_target_script'},
    route:'direct-local',targetLang:'th',sourceLang:'en',pageUnits:repairRows,phase:'repair'});
  assert.throws(()=>planIndependentExamples(repair,repairRows,0,ai.independent_examples),
    e=>e.code==='ai_workload_budget_insufficient',
    'the wrong-language instruction can falsely reject an ordinary missing unit');
  repair.setRepairReason('');
  const missing=planIndependentExamples(repair,repairRows,0,ai.independent_examples);
  assert.ok(missing.includedExamplePairs>=1&&missing.includedExamplePairs<=4);
  assert.equal(repair.ai.repair_reason,'');
  const repairResult=await translateWithLocalOpenAi(missing.chunk.units,{ai:{...repair.ai,
    workload:{version:1,...missing.chunk.estimate}},
    canonicalPrompt:await getCanonicalPrompt(missingPrompt,'th',{wantMemo:false}),
    targetLang:'th',sourceLang:'en'});
  assert.equal(repairResult.translations[0].text,'สวัสดี');
  assert.equal(posts.length,2,'a correctly estimated repair request reaches LM Studio once');

  const huge=await open({...ai,prompt:'ใช้ภาษาไทย'.repeat(8000)});
  assert.throws(()=>planIndependentExamples(huge,rows,0,ai.independent_examples),
    e=>e.code==='ai_workload_budget_insufficient'&&e.requestDispatched===false);
  assert.equal(posts.length,2,'an oversized user prompt is never silently removed or dispatched');
  assert.match(userMessageForCode('ai_workload_budget_insufficient'),/Context/);
  console.log('PASS LM Studio installed/loaded picker + DeepSeek 8K four-example cap and budget taper + 16K cap + no silent user-prompt fallback');
} finally {globalThis.fetch=previousFetch;}
