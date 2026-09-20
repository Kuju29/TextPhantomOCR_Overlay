import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createOllamaAdapter } from '../src/shared/ai/providers/local-ollama.js';
import { ollamaContextMetadata,planOllamaContext } from '../src/shared/ai/providers/ollama-context.js';
import { createWorkloadController } from '../src/background/ai/workload-controller.js';
import { translateWithLocalOpenAi } from '../src/shared/ai/direct-local/generation.js';
import { BUNDLED_CANONICAL_PROMPT_PLANS as plans } from '../src/generated/canonical-prompt-plans.js';
import { initialProfile,takeWorkloadBatch } from '../src/shared/ai/workload/model.js';
import { createPromptInputEstimator } from '../src/shared/ai/workload/prompt-input.js';
import { budgetDiagnostic } from '../src/shared/ai/request-diagnostics.js';
import '../src/shared/diagnostic-schema.js';
const limits={contextTokens:4096,runtimeContextTokens:4096,modelContextTokens:32768,source:'ollama-api-show-and-ps',scope:'runtime'};
assert.deepEqual(ollamaContextMetadata({model_info:{'vision.context_length':500000}}),{},'no guessed text ceiling');
assert.deepEqual(ollamaContextMetadata({model_info:{'general.architecture':'fixture','fixture.context_length':32768},parameters:'temperature 0.6\nnum_ctx 8192'}),{modelContextTokens:32768,configuredContextTokens:8192});
const fixtures=[];
for(const lim of [limits,{...limits,modelContextTokens:undefined},{...limits,contextTokens:2048,runtimeContextTokens:2048,modelContextTokens:2048},{...limits,contextTokens:32768,runtimeContextTokens:32768,modelContextTokens:131072},{...limits,scope:'model'}])for(const input of [500,8870,13000,50000]) {
 const estimate={estimatedInput:input,predictedOutput:160,reasoningReserve:0};const p=planOllamaContext(lim,estimate);fixtures.push({limits:lim,estimate,expected:p});
 if(p){assert.ok(p.evidence.requestedContext<=p.evidence.contextCeiling);assert.equal(p.evidence.contextVerified,false);}
}
const py=spawnSync('python',['-c',`import json,sys;sys.path.insert(0,'api');from backend.ai.providers.ollama_context import plan_ollama_context
for row in json.load(sys.stdin):
 assert plan_ollama_context(row['limits'],row['estimate'])==row['expected'],row
print('PASS 20 native context policy parity fixtures')`],{input:JSON.stringify(fixtures),encoding:'utf8'});assert.equal(py.status,0,py.stderr);console.log(py.stdout.trim());
let requests=[],active=4096;
const model='fixture-local:9b';
const server=http.createServer(async(req,res)=>{
 let body='';for await(const c of req)body+=c;
 const data=body?JSON.parse(body):null;requests.push({path:req.url,body:data});
 res.setHeader('Content-Type','application/json');
 if(req.url==='/api/tags')return res.end(JSON.stringify({models:[{name:model,digest:'localdigest',size:6000000000}]}));
 if(req.url==='/api/ps')return res.end(JSON.stringify({models:[{name:model,digest:'localdigest',context_length:active,size:6000000000,size_vram:0}]}));
 if(req.url==='/api/show')return res.end(JSON.stringify({capabilities:['completion','thinking'],model_info:{'general.architecture':'fixture','fixture.context_length':32768}}));
 if(req.url!=='/api/chat'){res.statusCode=404;return res.end('{}');}
 if(!data.messages.some(m=>m.role==='system'))return res.end(JSON.stringify({model,message:{role:'assistant',content:'OK'},done:true,done_reason:'stop'}));
 assert.ok(data.options.num_ctx>=12288,'full Thai prompt needs a requested window, not just healthy server');
 active=data.options.num_ctx;
 const src=data.messages.at(-1).content.split('ข้อความต้นฉบับ\n').at(-1);
 const ids=[...src.matchAll(/(?:<<TP_)?(P\d+):/g)].map(m=>m[1]);assert.ok(ids.length);
 const text=data.format?JSON.stringify(Object.fromEntries(ids.map(id=>[id,'สวัสดี']))):ids.map(id=>`<<TP_${id}:สวัสดี>>`).join('\n');
 res.setHeader('Content-Type','application/x-ndjson');res.end(JSON.stringify({model,message:{role:'assistant',content:text},done:true,done_reason:'stop',prompt_eval_count:3200,eval_count:32})+'\n');
});
server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
try {
 const adapter=createOllamaAdapter({baseUrl:base});
 // Run real discovery transport against a local HTTP fixture; not fetch stubs.
 const discovered=await adapter.listModels({selectedModel:model,timeoutMs:1000});
 const caps=discovered.capability.models[model];assert.equal(caps.limits.modelContextTokens,32768);assert.equal(caps.limits.contextTokens,4096);
 const units=[{id:'balloon-a',text:'Hello.'},{id:'balloon-b',text:'Are you okay?'}];
 const ai={provider:'ollama',model,base_url:base,thinking:'off',memory_mode:'off',style_examples:true,local_adapter:{protocol:'ollama',baseUrl:base},model_capabilities:caps};
 const fixed=createPromptInputEstimator({ai,sourceLang:'en',targetLang:'th',contract:'schema_object'});
 assert.throws(()=>takeWorkloadBatch(units,0,initialProfile(),{contract:'schema_object',limits:caps.limits,fixedInput:0,estimateFixedInput:u=>fixed(u,units),reasoningActive:false,wholePageFirst:true}),e=>e.code==='ai_workload_budget_insufficient','old runtime-only planning reproduces pre-dispatch rejection');
 for(const schema of [true,false]) {
  const ctl=createWorkloadController({read:async()=>({}),write:async()=>{},emit:()=>{}});
  const session=await ctl.open({route:'direct-local',sourceLang:'en',targetLang:'th',wholePageFirst:true,ai:{...ai,model_capabilities:{...caps,structuredOutput:{...caps.structuredOutput,supported:schema}}}});
  let offset=0;const translated=[];
  while(offset<units.length){
   const chunk=session.next(units,offset);assert.ok(chunk.estimate.fitsHard);
   const clean=globalThis.TPAuditSchema.sanitize(budgetDiagnostic(chunk,{operationId:'ai:'+'a'.repeat(32),pageUnits:units.length}));
   assert.equal(clean.planned.runtimeContext,4096);assert.equal(clean.planned.modelContext,32768);assert.equal(clean.planned.requestedContext,chunk.estimate.limits.contextTokens);
   const wire=[];const answer=await translateWithLocalOpenAi(chunk.units,{ai:{...session.ai,workload:{version:1,...chunk.estimate}},canonicalPrompt:plans.th,targetLang:'th',sourceLang:'en',wireTrace:async(stage,value)=>wire.push({stage,value})});
   const sent=requests.filter(r=>r.path==='/api/chat').at(-1).body;
   assert.equal(sent.think,false);assert.equal(sent.options.num_ctx,chunk.estimate.limits.contextTokens);
   assert.equal(wire.find(r=>r.stage==='contractSelection').value.contextPlan.requestedContext,sent.options.num_ctx);
   assert.equal(wire.some(r=>r.stage==='contextPlan'),false,'no unsupported relay stage');
   assert.equal(answer.meta.usage.inputTokens,3200,'actual usage separate from estimate');
   assert.equal(answer.meta.contextPlan.contextVerified,false,'request option is not runtime verification');
   translated.push(...answer.translations.map(t=>t.id));session.observe({units:chunk.units,answer,plan:chunk.estimate});offset+=chunk.units.length;
  }
  assert.deepEqual(translated,units.map(u=>u.id));await session.flush();
 }
 const before=requests.length;
 const denied=createWorkloadController({read:async()=>({}),write:async()=>{},emit:()=>{}});
 const session=await denied.open({route:'direct-local',targetLang:'th',sourceLang:'en',ai:{...ai,model_capabilities:{...caps,limits:{...caps.limits,modelContextTokens:2048}}}});
 assert.throws(()=>session.next(units,0),e=>e.code==='ai_workload_budget_insufficient' && e.requestDispatched===false && e.diagnostics.contextLimit===2048 && e.diagnostics.modelContext===2048);
 assert.equal(requests.length,before,'known small model still rejected before HTTP');
 console.log('PASS native HTTP discovery → planner → full preserved Thai prompt → requested num_ctx → marker/JSON parse → usage/learning; no API translation proxy, IDs conserved, no silent truncation.');
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
