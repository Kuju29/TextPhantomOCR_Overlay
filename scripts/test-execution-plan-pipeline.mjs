/** Planner -> prepared checkpoint -> real Cloud transport -> repair transport.
 * Only provider HTTP and Lens/apply I/O are mocked; no live provider call. */
import assert from 'node:assert/strict';
import {createWorkloadController, WORKLOAD_STORAGE_KEY} from '../src/background/ai/workload-controller.js';
import {initialProfile, WORKLOAD_VERSION} from '../src/shared/ai/workload/model.js';
import {translateLensPage} from '../src/background/pipeline/page-translation.js';
import {translateViaServer} from '../src/background/ai/transports/server.js';
import {makePageCheckpoint} from '../src/background/repair/page-checkpoint.js';
const stored = {};
globalThis.chrome = {runtime:{getManifest:()=>({version:'test'})},storage:{local:{
  get(keys, cb){cb(typeof keys==='string'?{[keys]:stored[keys]}:{...stored});},
  set(values, cb){Object.assign(stored,values);cb?.();}
}}};
const units = Array.from({length:7},(_,i)=>({id:`g${i}`,text:'A',translatable:true,paragraphIds:[`p${i}`]}));
const options = {route:'server',sourceLang:'en',targetLang:'th',image:false, ai:{
  provider:'openrouter',model:'test-model',base_url:'https://openrouter.ai/api/v1',api_key:'fixture-not-a-key',
  thinking:'off',prompt:'STYLE SENTINEL',model_capabilities:{structured_output:{supported:true}}
}};
const bootstrap = createWorkloadController({read:async()=>({}),write:async()=>{}});
const key = (await bootstrap.open(options)).key;
let disk = {[WORKLOAD_STORAGE_KEY]:{version:WORKLOAD_VERSION,profiles:{[key]:{
 ...initialProfile(), samples:132, records:2, target:128, actualIdentity:'test-model|compact_markers_v1'
}}}};
const controller=createWorkloadController({read:async()=>structuredClone(disk),write:async data=>{disk=structuredClone(data);}});
const bodies=[], events=[];let checkpoint;
globalThis.fetch = async (url, init)=>{
 const body=JSON.parse(init.body);bodies.push(body);
 return new Response(JSON.stringify({schema:'tp.ai.result/1',translations:body.units.map(u=>({id:u.id,text:'คำแปล'})),missing:[],
  meta:{resolvedProvider:'openrouter',resolvedModel:'test-model',selectedContract:body.provider.outputContract,
    finishReason:'stop',providerAttempts:1,generationAttempts:1}}),{status:200});
};
const result={lensDocument:{languages:{source:'en'}},eraseBoxes:[]};
const oldCallerAi=structuredClone(options.ai), ctx={jobId:'fixture-job',imageKey:'fixture-image'};
const output=await translateLensPage({
 base:'http://fixture.invalid',payload:{lang:'th',metadata:{image_id:ctx.imageKey},context:{}},
 result,plan:{route:'server',ai:oldCallerAi},jobId:ctx.jobId,
 trace:(name,data)=>events.push({name,data}),
 onCheckpoint:async data=>{
  if(data.stage==='prepared'){
   checkpoint=await makePageCheckpoint({...data,ctx});
   // Discovery completes while persistence yields. It must not change this page.
   oldCallerAi.model='changed-model';oldCallerAi.model_capabilities.structured_output.supported=false;
  }
 },
 dependencies:{workloadController:controller,
  requireAiLensDocument:r=>r.lensDocument,translationUnits:()=>units,
  requireTranslationConservation:()=>({ok:true,eligibleParagraphCount:7,excludedBlankParagraphCount:0,unitCount:7}),
  translateUnits:translateViaServer,diagnoseTargetScripts:()=>[],summarizeUnitScripts:()=>[],
  applyTranslations:(doc, translations)=>({document:{...doc,applied:translations},report:{translated:7,missing:[],complete:true}}),
  classifyAiTranslationReport:r=>({usable:true,...r}),eraseBoxesForAiPartial:()=>({ok:true,eraseBoxes:[]})
 }});
assert.equal(output.complete,true);
assert.equal(bodies.length,1,'wrong-contract two-record history must not split the first page');
assert.equal(bodies[0].units.length,7);assert.deepEqual(bodies[0].units,units.map(({id,text})=>({id,text})));
assert.equal(bodies[0].provider.outputContract,'json_schema_object_v1');
assert.equal(bodies[0].provider.model,'test-model');assert.equal(bodies[0].provider.modelCapabilities.structured_output.supported,true);
assert.equal(checkpoint.ai.model,'test-model');assert.equal(checkpoint.ai.model_capabilities.structured_output.supported,true);
assert.equal(checkpoint.ai.api_key,undefined,'checkpoint cannot persist API credentials');
assert.equal(bodies[0].prompt,options.ai.prompt);
const dispatch=events.find(e=>e.name==='aiModelWorkload'&&e.data.event==='dispatch').data;
assert.equal(dispatch.budget.recordTarget,10);assert.equal(dispatch.budget.samples,0);
assert.equal(dispatch.budget.planningContract,bodies[0].provider.outputContract);
assert.notEqual(bodies[0].operationId,dispatch.parentOperationId,'single generation also has execution-scoped receipt identity');
const repairPlanner=await controller.open({...options,ai:{...checkpoint.ai,api_key:options.ai.api_key,repair_reason:'wrong_target_script'}});
await translateViaServer(units.slice(0,1),{base:'http://fixture.invalid',ai:repairPlanner.ai,
 targetLang:'th',sourceLang:'en',operationId:'repair:fixture',repairClaim:{runId:'fixture',taskId:'task',token:'fixture-token'}});
assert.equal(bodies.length,2);assert.equal(bodies[1].provider.outputContract,bodies[0].provider.outputContract);
assert.equal(bodies[1].provider.modelCapabilities.structured_output.supported,true);
assert.equal(bodies[1].repair.reason,'wrong_target_script');assert.equal(bodies[1].repair.enabled,false);
if(process.argv.includes('--capture')) console.log(JSON.stringify(bodies));
else console.log('Execution-plan pipeline: 4/4 stages passed (before packing, snapshot checkpoint, actual initial wire, actual repair wire); external I/O mocked.');
