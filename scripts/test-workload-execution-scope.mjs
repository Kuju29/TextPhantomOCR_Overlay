/** State transitions before dispatch. No external I/O or secret fixtures. */
import assert from 'node:assert/strict';
import {createWorkloadController,WORKLOAD_STORAGE_KEY} from '../src/background/ai/workload-controller.js';
import {initialProfile,WORKLOAD_VERSION} from '../src/shared/ai/workload/model.js';
import {workloadOperationId} from '../src/background/ai/workload-identity.js';
import {serverModelCapabilities,workloadSelection} from '../src/shared/ai/workload/contract.js';
let count=0;
async function check(name, fn){await fn();count++;console.log('PASS '+name);}
const rows=Array.from({length:7},(_,i)=>({id:`g${i}`,text:'A',translatable:true,paragraphIds:[`p${i}`]}));
const opts=()=>({route:'server',sourceLang:'en',targetLang:'th',ai:{provider:'openrouter',model:'model-a',base_url:'https://fixture.invalid',api_key:'fixture-key',prompt:'STYLE-DO-NOT-MUTATE',thinking:'off',model_capabilities:{structured_output:{supported:true},reasoning:{supported:false}}}});
function store(seed={}){let disk=structuredClone(seed);return {read:async()=>structuredClone(disk),write:async d=>{disk=structuredClone(d);},disk:()=>disk};}
async function seedProfile(options,extra){const io=store(),c=createWorkloadController(io);const s=await c.open(options);return store({[WORKLOAD_STORAGE_KEY]:{version:WORKLOAD_VERSION,profiles:{[s.key]:{...initialProfile(),samples:132,records:2,target:128,...extra}}}});}
const answer=(items,extra={})=>({translations:items.map(u=>({id:u.id,text:'คำแปล'})),missing:[],meta:{model:'model-a',selectedContract:'json_schema_object_v1',finishReason:'stop',usage:{source:'provider',inputTokens:100,outputTokens:10,thinkingTokens:0},...extra}});
await check('old marker target rejected before all 17 parallel first dispatches',async()=>{
 const io=await seedProfile(opts(),{actualIdentity:'model-a|compact_markers_v1'}),c=createWorkloadController(io);
 const sessions=await Promise.all(Array.from({length:17},()=>c.open(opts())));
 for(const s of sessions){const b=s.next(rows,0);assert.equal(b.estimate.recordTarget,10);assert.equal(b.estimate.target,160);assert.equal(b.estimate.samples,0);assert.equal(b.units.length,7);assert.equal(s.snapshot().epoch,1);}
 await c.flush();assert.equal(io.disk()[WORKLOAD_STORAGE_KEY].profiles[sessions[0].key].records,10);
});
await check('valid v6 schema profile is retained, including safely learned small targets',async()=>{
 const io=await seedProfile(opts(),{actualIdentity:'model-a|json_schema_object_v1'});const s=await createWorkloadController(io).open(opts());
 assert.equal(s.next(rows,0).units.length,2);assert.equal(s.snapshot().samples,132);assert.equal(s.snapshot().target,128);
});
await check('contract aliases normalize without throwing away matching learning',async()=>{
 for(const contract of ['schema_object','json_schema_object_v1','tp.translation.schema-object/1']){
  const s=await createWorkloadController(await seedProfile(opts(),{actualIdentity:'model-a|'+contract})).open(opts());
  assert.equal(s.snapshot().samples,132);assert.equal(s.snapshot().epoch,0);
 }
});
await check('missing or wrong model provenance does not survive under a confirmed plan',async()=>{
 for(const actualIdentity of ['', 'model-b|json_schema_object_v1', 'model-a|unrecognized']){
  const s=await createWorkloadController(await seedProfile(opts(),{actualIdentity})).open(opts());assert.equal(s.next(rows,0).estimate.samples,0);
 }
});
await check('unknown capability cannot borrow past cache-selected structure targets',async()=>{
 const o=opts();o.ai.model_capabilities={};
 const s=await createWorkloadController(await seedProfile(o,{actualIdentity:'model-a|compact_markers_v1'})).open(o);
 assert.equal(s.next(rows,0).estimate.recordTarget,10);assert.equal(s.next(rows,0).estimate.planningContract,'unconfirmed');
});
await check('explicit supported=false has its own concrete marker scope',async()=>{
 const c=createWorkloadController(store()),json=await c.open(opts()),o=opts();o.ai.model_capabilities.structured_output.supported=false;
 const marker=await c.open(o);assert.notEqual(marker.key,json.key);assert.equal(marker.next(rows,0).estimate.planningContract,'compact_markers_v1');
});
await check('old unexpected-contract response cannot shrink a confirmed profile or peers',async()=>{
 const c=createWorkloadController(store()),a=await c.open(opts()),b=await c.open(opts());const chunk=a.next(rows,0);
 const bad=answer(chunk.units,{selectedContract:'compact_markers_v1'});bad.translations.pop();
 const event=a.observe({units:chunk.units,answer:bad,plan:chunk.estimate});
 assert.equal(event.learning.decision,'unplanned_execution_observation_ignored');assert.equal(b.snapshot().samples,0);assert.equal(b.snapshot().records,10);
 const good=b.next(rows,0);b.observe({units:good.units,answer:answer(good.units),plan:good.estimate});assert.equal(b.snapshot().samples,1);
});
await check('caller mutation after open cannot alter planning or wire snapshot',async()=>{
 const o=opts(),s=await createWorkloadController(store()).open(o);o.ai.model='changed';o.ai.model_capabilities.structured_output.supported=false;
 assert.equal(s.ai.model,'model-a');assert.equal(s.ai.model_capabilities.structured_output.supported,true);assert.equal(s.next(rows,0).estimate.planningContract,'json_schema_object_v1');
 const leaked=s.ai;leaked.model='again';assert.equal(s.ai.model,'model-a');
});
await check('upstream-only changes never reset correct-contract learning',async()=>{
 const s=await createWorkloadController(store()).open(opts());
 for(const upstreamProvider of ['one','two','three']){const b=s.next(rows,0);s.observe({units:b.units,answer:answer(b.units,{upstreamProvider}),plan:b.estimate});}
 assert.equal(s.snapshot().samples,3);assert.equal(s.snapshot().epoch,0);
});
await check('wrong language remains a defect, not evidence of smaller capacity',async()=>{
 const s=await createWorkloadController(store()).open(opts());const b=s.next(rows,0);
 const ev=s.observe({units:b.units,answer:answer(b.units),defects:{wrongLanguage:['g0']},plan:b.estimate});
 assert.equal(ev.outcome,'language');assert.equal(s.snapshot().target,160);assert.equal(s.snapshot().records,10);
});
await check('receipt identity includes execution scope for single and multi batches',async()=>{
 const c=createWorkloadController(store()),a=await c.open(opts()),other=opts();other.ai.model_capabilities.structured_output.supported=false;const b=await c.open(other);
 for(const units of [rows.slice(0,1),rows]){
  const one=await workloadOperationId('ai:fixture',0,units,a.key);const two=await workloadOperationId('ai:fixture',0,units,b.key);
  assert.notEqual(one,two);assert.equal(one,await workloadOperationId('ai:fixture',0,units,a.key));assert.ok(!one.includes('fixture-key'));
 }
});
await check('normalized camel metadata matches the canonical profile and dispatch contract',async()=>{
 const a=opts(),b=opts();b.ai.model_capabilities={structuredOutput:{supported:true},reasoning:{supported:false}};
 const c=createWorkloadController(store());assert.equal((await c.open(a)).key,(await c.open(b)).key);
 assert.deepEqual(serverModelCapabilities(b.ai.model_capabilities),a.ai.model_capabilities);
});
await check('Local schema and marker identity spellings match provider terminal aliases',async()=>{
 for(const supported of [false,true]){
  const o=opts();o.route='direct-local';o.ai.provider='ollama';o.ai.model_capabilities={structuredOutput:{supported,contract:'tp.translation.schema-object/1'}};
  const s=await createWorkloadController(store()).open(o);const b=s.next(rows,0);
  s.observe({units:b.units,answer:answer(b.units,{selectedContract:supported?'tp.translation.schema-object/1':'tp.translation.compact-records/1'}),plan:b.estimate});assert.equal(s.snapshot().samples,1);
 }
});
await check('new plan does not touch Style, usage keys or expose source/credentials in storage',async()=>{
 const io=store(),o=opts(),s=await createWorkloadController(io).open(o),b=s.next(rows,0);s.observe({units:b.units,answer:answer(b.units),plan:b.estimate});
 // flush using controller below verifies real persistence in the transition case;
 // this snapshot write is deliberately checked only for allowed storage keys.
 await new Promise(r=>setTimeout(r,0));assert.deepEqual(Object.keys(io.disk()),[WORKLOAD_STORAGE_KEY]);
 const text=JSON.stringify(io.disk());for(const forbidden of ['fixture-key','STYLE-DO-NOT-MUTATE','คำแปล'])assert.ok(!text.includes(forbidden));
});
await check('direct-local top-level alias is projected to the actual generator field',async()=>{
 const o=opts();o.route='direct-local';o.ai.provider='ollama';
 o.ai.modelCapabilities={structuredOutput:{supported:true,contract:'tp.translation.schema-object/1'}};
 delete o.ai.model_capabilities;
 const s=await createWorkloadController(store()).open(o);
 assert.equal(s.ai.modelCapabilities,undefined);
 assert.equal(s.ai.model_capabilities.structuredOutput.supported,true);
 assert.equal(workloadSelection(s.ai,o.route).contract,s.next(rows,0).estimate.planningContract);
});
console.log(`Execution scope: ${count}/${count} checks passed; zero provider calls.`);
