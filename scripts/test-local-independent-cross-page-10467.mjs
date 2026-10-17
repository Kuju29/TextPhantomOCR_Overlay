/** .67 owner rule: text-only Local Independent pages share stateless requests.
 * Production ready queue, ordering and workload session; no real model. */
import assert from 'node:assert/strict';
import {createReadyQueue} from '../src/background/ai/translation-paths/ready-queue.js';
import {reserveLocalIndependentJob,finishLocalIndependentJob,localIndependentTicket,localIndependentTickets,
  onLocalIndependentReady,fenceLocalIndependentConfiguration} from '../src/background/ai/translation-paths/independent-order.js';
import {createWorkloadController} from '../src/background/ai/workload-controller.js';

const store={};
globalThis.chrome={runtime:{getManifest:()=>({version:'2026.10.4.67'}),sendMessage:(_m,cb)=>cb?.({}),lastError:null},storage:{local:{
 get(keys,cb){const out=keys==null?structuredClone(store):Object.fromEntries([].concat(keys).map(k=>[k,store[k]]));cb?.(out);return Promise.resolve(out);},
 set(value,cb){Object.assign(store,structuredClone(value));cb?.();return Promise.resolve();}}}};
const ordering={ticketFor:localIndependentTicket,list:localIndependentTickets,onReady:onLocalIndependentReady,
  fenceConfiguration:fenceLocalIndependentConfiguration};
const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw new Error('boundary not reached');};
let cases=0;
const ai={provider:'lmstudio',base_url:'http://127.0.0.1:1234',model:'fixture',translation_mode:'independent',thinking:'off'};
function page(i,run='run-a'){
  const payload={source:'ai',engine:'extension',lang:'th',context:{page_url:'doc',tp_tab_session:'tab-owner',page_index:i},
    metadata:{image_id:`page-${i}`,batch_id:run},ai:{...ai}};
  reserveLocalIndependentJob(payload,1);
  return {payload,ai:payload.ai,imageId:`page-${i}`,targetLang:'th',sourceLang:'en',route:'direct-local',batchId:run};
}
const units=(prefix,n=2)=>Array.from({length:n},(_,k)=>({id:`P${k}`,text:`${prefix} ${k}`}));

// 1. Webpage order: an unready earlier page blocks later ready pages; a page
// whose job ends without AI (OCR error) never blocks; stateless LM Studio
// answers (no Conversation commit) are accepted; memory goes to one page.
{
  let release,entered=false;const sent=[];const after=[];
  const q=createReadyQueue({mode:'independent',ordering,
    choose:async rows=>({units:rows,splitReason:'ready_queue_drained',estimate:{estimatedInput:1,predictedOutput:1},pageCount:1}),
    dispatch:async(us,o,p)=>{sent.push(p.origins.map(x=>x.pageId));if(sent.length===1){entered=true;await new Promise(r=>release=r);}
      return {translations:us.map(u=>({id:u.id,text:`แปล ${u.text}`})),missing:[],memoryDelta:{characters:[{name:'A'}],glossary:[]},meta:{}};},
    afterRequest:async({picked})=>after.push(picked.length)});
  const ps=[0,1,2,3].map(i=>page(i));
  const first=q.submit(units('A'),ps[0]);await until(()=>entered);
  const later=[q.submit(units('C'),ps[2]),q.submit(units('D'),ps[3])];
  release();const a=await first;
  await new Promise(r=>setTimeout(r,20));
  assert.equal(sent.length,1,'page 1 (not ready) blocks pages 2 and 3');
  finishLocalIndependentJob(ps[1].payload); // page 1 failed before AI
  const [c,d]=await Promise.all(later);
  assert.deepEqual(sent,[['page-0'],['page-2','page-3']],'whole pages, webpage order, one request');
  assert.equal(a.meta.translationMode,'independent');
  assert.deepEqual(c.translations.map(t=>t.text),['แปล C 0','แปล C 1']);
  assert.deepEqual(d.translations.map(t=>t.id),['P0','P1'],'page-local IDs restored');
  assert.equal(c.memoryDelta.characters.length,1);assert.equal(d.memoryDelta.characters.length,0,'request memory applied once');
  assert.deepEqual(after,[2,4],'learning hook runs after each request');
  for(const p of ps)finishLocalIndependentJob(p.payload);q.close();cases+=7;
}

// 2. Owner example: capacity fits pages 1+2 but not 3; page 3 waits for the
// next request. One page larger than the window is split as before.
{
  const c=createWorkloadController({read:async()=>({}),write:async()=>{},emit:()=>{}});
  const local={...ai,provider:'ollama',base_url:'http://127.0.0.1:11434',
    model_capabilities:{reasoning:{supported:false},structured_output:{supported:false},
      limits:{contextTokens:7168,source:'runtime',scope:'runtime'}}}; // 2026.10.17.1: sized for the M2 built-in prompt
  const session=await c.open({route:'direct-local',ai:local,sourceLang:'en',targetLang:'th',wholePageFirst:true});
  const line=n=>'An ordinary line of dialogue for the fixture '.repeat(n);
  const p1=Array.from({length:10},(_,i)=>({id:`I1_P${i}`,text:line(3)}));
  const p2=Array.from({length:5},(_,i)=>({id:`I2_P${i}`,text:line(6)}));
  const p3=Array.from({length:15},(_,i)=>({id:`I3_P${i}`,text:line(3)}));
  const plan=session.nextIndependentReady([...p1,...p2,...p3],[10,5,15]);
  assert.equal(plan.pageCount,2,'pages 1+2 fill the window; page 3 waits');
  assert.equal(plan.splitReason,'local_window_before_page');
  const e=plan.estimate;assert.ok(e.estimatedInput+e.predictedOutput+e.reasoningReserve+128<=7168);
  const all=session.nextIndependentReady([...p1,...p2],[10,5]);
  assert.equal(all.pageCount,2);assert.equal(all.splitReason,'ready_queue_drained');
  const huge=Array.from({length:300},(_,i)=>({id:`I9_P${i}`,text:line(2)}));
  const part=session.nextIndependentReady(huge,[300]);
  assert.ok(part.units.length>0&&part.units.length<300&&part.splitReason==='local_window_partial_page');
  const conversation=await c.open({route:'server',ai:{...local,translation_mode:'conversation'},sourceLang:'en',targetLang:'th'});
  assert.throws(()=>conversation.nextIndependentReady([],[]),/Local Independent only/);
  cases+=6;
}

// 3. A configuration failure fences only the same run.
{
  const ps=[0,1].map(i=>page(i,'run-fence'));const other=page(0,'run-other');
  const ticket=localIndependentTicket(ps[0].payload);
  fenceLocalIndependentConfiguration(ticket,new Error('bad model'));
  assert.ok(localIndependentTicket(ps[1].payload).configurationFailure);
  assert.equal(localIndependentTicket(other.payload).configurationFailure,undefined);
  for(const p of [...ps,other])finishLocalIndependentJob(p.payload);cases+=2;
}
console.log(`PASS ${cases} Local Independent cross-page checks: webpage order, failed-page skip, whole-page window packing, stateless LM Studio, memory once, run-scoped fence`);
