import assert from 'node:assert/strict';
import {createLocalDiscoveryController} from '../src/background/ai/local-discovery-controller.js';
import '../src/shared/diagnostic-schema.js';
const model='fixture:1b', base='http://127.0.0.1:11434';
const msg=(id, extra={})=>({type:'TP_LOCAL_AI_DISCOVER',provider:'ollama',adapter:{protocol:'ollama',baseUrl:base},model,thinking:'off',discoveryId:`00000000-0000-4000-8000-${String(id).padStart(12,'0')}`,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle=async test=>{for(let i=0;i<100&&!test();i++)await new Promise(r=>setTimeout(r,1));assert.ok(test(),'asynchronous stage reached');};
let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
const network=globalThis.fetch;
let online=false,revision='sha-fixture-a',calls={tags:0,show:0,ps:0,chat:0}, showGate=deferred();
const json=x=>new Response(JSON.stringify(x),{status:200,headers:{'content-type':'application/json'}});
globalThis.fetch=async(url,options={})=>{
 if(!online)throw new TypeError('fetch failed');
 const path=new URL(url).pathname;
 if(path==='/api/tags'){calls.tags++;return json({models:[{name:model,digest:revision,size:512000000,details:{family:'qwen'}}]});}
 if(path==='/api/ps'){calls.ps++;return json({models:[]});}
 if(path==='/api/show'){
   calls.show++;
   await showGate.promise;
   return json({capabilities:['completion','thinking'],model_info:{'general.architecture':'qwen'},details:{family:'qwen'}});
 }
 if(path==='/api/chat'){calls.chat++;throw new Error('Local discovery must never generate');}
 throw Error(`unexpected path ${path}`);
};
const events=[],progress=[],store={};let leases=0;
const controller=createLocalDiscoveryController({emit:e=>events.push(e),publish:e=>progress.push(e),
 read:async()=>structuredClone(store),write:async patch=>Object.assign(store,structuredClone(patch)),keepAlive:()=>leases++});
try {
 const fail=await controller.run(msg(1));check(fail.ok===false&&fail.code==='local_ai_unreachable','offline is retryable, not model invalid');
 check(controller.activeCount()===0,'offline releases in-flight state');
 online=true;
 const first=controller.run(msg(2));await settle(()=>calls.show===1);
 const joined=controller.run(msg(3));await Promise.resolve();
 check(calls.tags===1&&calls.show===1&&calls.chat===0,'reopened popup joins one physical metadata discovery without generation');
 showGate.resolve();const [a,b]=await Promise.all([first,joined]);
 check(a.ok&&a.selectedModelVerification.status==='passed'&&a.selectedModelVerification.metadataOnly===true&&a.discoveryId===b.discoveryId,'one metadata result correlates multiple callers');
 check(a.snapshotOwner==='worker','result survives popup closure through worker-owned storage');
 check(progress.some(p=>p.requestId===msg(2).discoveryId&&p.stage==='models_loaded'&&p.models[0]===model),'usable model list is published after metadata filtering');
 await controller.flush();
 const snap=store.aiLocalCapabilitySnapshotsV1?.[`ollama|${base}`];
 check(snap?.verifiedModel===model&&snap.verificationStatus==='passed'&&snap.metadataOnly===true,'worker wrote completed metadata availability evidence');

 // Explicit refresh performs fresh cheap metadata I/O. It must never turn that
 // refresh into a throw-away generation, even after model revision changes.
 showGate=deferred(); showGate.resolve();
 const replay=await controller.run(msg(4));
 check(replay.selectedModelVerification.metadataOnly===true&&calls.tags===2&&calls.show===2&&calls.chat===0,'refresh rechecks metadata only');
 const replayEvents=events.filter(e=>e.operationId===replay.discoveryId);
 const replayEnd=globalThis.TPAuditSchema.sanitize(replayEvents.find(e=>e.reason==='finished'));
 check(replayEnd.metadataOnly===true&&replayEnd.timing.metadataMs===null,'trace identifies metadata-only discovery without probe timing');
 revision='sha-fixture-b';await controller.run(msg(5));
 check(calls.chat===0,'model revision changes never trigger a dummy generation');
 online=false;await controller.run(msg(6));online=true;await controller.run(msg(7));
 check(calls.chat===0,'offline recovery returns to metadata discovery without generation');
 controller.acknowledge({discoveryId:a.discoveryId,requestId:msg(2).discoveryId,applied:true,ready:true});
 controller.acknowledge({discoveryId:a.discoveryId,requestId:msg(3).discoveryId,applied:false,ready:false});
 const typed=events.map(e=>globalThis.TPAuditSchema.sanitize(e));
 check(typed.every(e=>e.event==='local_discovery'),'typed trace preserves event name');
 check(typed.some(e=>e.reason==='failed'&&e.errorCode==='local_ai_unreachable'&&e.retryable===true),'typed failure is not mislabeled non-retryable');
 check(typed.some(e=>e.reason==='ui_applied'&&e.ready===true)&&typed.some(e=>e.reason==='stale_discard'),'UI acknowledgement vs stale discard is observable');
 const contaminated=globalThis.TPAuditSchema.sanitize({...events[0],endpoint:'http://secret',apiKey:'hf_secret',errorCode:'hf_secret',ready:'yes'});
 check(!('endpoint'in contaminated)&&!('apiKey'in contaminated)&&contaminated.errorCode==='unknown'&&contaminated.ready===null,'compact logs exclude credentials and unbounded errors');
 check(controller.activeCount()===0&&leases===0,'no idle lease or active check leaks');

 // A stale model result must not replace the newer selected-model snapshot for
 // the same provider/endpoint. Thinking is intentionally not an identity key.
 let next=0;const gates=[deferred(),deferred()];const snapshots={};
 const delayed=createLocalDiscoveryController({discover:async(_adapter,options)=>{
   const i=next++;await gates[i].promise;const selected=String(options.model);
   return {ok:true,models:[selected],capability:{models:{[selected]:{generation:{supported:true}}}},
     selectedModelVerification:{model:selected,status:i?'passed':'timeout',metadataOnly:true,evidence:'fixture'},checkedAt:Date.now()};},
  read:async()=>structuredClone(snapshots),write:async x=>Object.assign(snapshots,structuredClone(x))});
 const old=delayed.run(msg(8,{model:'fixture-old'})), newer=delayed.run(msg(9,{model:'fixture-new',thinking:'on'}));
 await settle(()=>next===2);gates[1].resolve();await newer;gates[0].resolve();await old;await delayed.flush();
 const newest=snapshots.aiLocalCapabilitySnapshotsV1[`ollama|${base}`];
 check(newest.verificationStatus==='passed'&&newest.verifiedModel==='fixture-new','late old-model result cannot overwrite newer metadata snapshot');
} finally {await controller.flush();globalThis.fetch=network;}
console.log(`Local worker recovery: ${checks} checks passed; metadata-only discovery, mocked HTTP; no live models.`);
