/** Paid budget/credit failures retain their cause through real initial queues.
 * Only synthetic transport; no real AI, Center, email, payment or customer state.
 */
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {pathToFileURL} from 'node:url';
globalThis.crypto ||= webcrypto;
const project=pathToFileURL(`${process.env.TP_TEST_ROOT||process.cwd()}/`);
const from=p=>import(new URL(p,project));
const {createReadyQueue}=await from('src/background/ai/translation-paths/ready-queue.js');
const {reserveConversationJob,finishConversationJob}=await from('src/background/ai/translation-paths/order.js');
const {independentTranslation}=await from('src/background/ai/translation-paths/independent.js');
const {userMessageForCode}=await from('src/shared/error-contract.js');
const cases=[
 ['paid_provider_key_limit',503,true],
 ['paid_provider_balance',502,true],
 ['paid_insufficient_credits',402,false],
 ['paid_provider_key_limit',503,false],
 ['paid_provider_balance',502,false],
];
// 10491: PAID_PROVIDER_CAPACITY (OpenRouter in-flight budget momentarily
// full) fails only its own request; queued pages are still sent.
const transientCases=[['paid_provider_capacity',503,true],['paid_provider_capacity',503,false]];
const reports=[];
const fault=([code,status,dispatched])=>Object.assign(new Error('Synthetic bounded rejection'),{
 code,status,httpStatus:status,...(dispatched?{upstreamStatus:402}:{}),requestDispatched:dispatched,
 providerAttempts:dispatched?1:0,generationAttempts:0,retryable:false,
});
async function wait(predicate){for(let n=0;n<300&&!predicate();n++)await new Promise(r=>setTimeout(r,2));assert.ok(predicate(),'Synthetic dispatch barrier did not start');}
function page(doc,index,wallet='A'){
 const payload={source:'ai',lang:'th',context:{page_url:doc,tp_tab_session:'synthetic-owner',page_index:index},
 metadata:{image_id:`${doc}-${index}`,batch_id:doc},
 ai:{provider:'paid',model:'qa/test',api_key:`synthetic-wallet-${wallet}`,translation_mode:'conversation',thinking:'minimum'}};
 reserveConversationJob(payload,1);
 return {payload,ai:payload.ai,imageId:payload.metadata.image_id,targetLang:'th',sourceLang:'en',route:'server',sourceFingerprint:'a'.repeat(64)};
}
function noDispatch(error,code){
 assert.equal(error.code,code,'Queued page must preserve the budget/credit failure cause');
 assert.equal(error.requestDispatched,false);assert.equal(error.providerAttempts,0);assert.equal(error.generationAttempts,0);
 for(const key of ['usage','receiptId','operationId','generationMeta','charged_tp','chargedTp'])assert.equal(error[key],undefined,`Unsent page must not inherit ${key}`);
 assert.equal(userMessageForCode(error.code),userMessageForCode(code),'Queued page must show the correct cause');
}
async function queued(spec){
 let calls=0,release,started=false;
 const pages=Array.from({length:5},(_,i)=>page(`${spec[0]}-queued`,i));
 const queue=createReadyQueue({choose:async rows=>({units:rows.slice(0,1),splitReason:'bounded_synthetic'}),dispatch:async()=>{
  calls++;if(calls===1){started=true;await new Promise(r=>release=r);}throw fault(spec);
 }});
 try{
  const tasks=[queue.submit([{id:'P0',text:'Synthetic source'}],pages[0])];tasks[0].catch(()=>{});
  await wait(()=>started);
  for(const p of pages.slice(1)){const task=queue.submit([{id:'P0',text:'Synthetic source'}],p);task.catch(()=>{});tasks.push(task);}
  release();const settled=await Promise.allSettled(tasks);
  assert.equal(calls,1,'Remaining queued pages must not call transport after rejection');
  assert.equal(settled[0].status,'rejected');assert.equal(settled[0].reason.code,spec[0]);
  for(const v of settled.slice(1)){assert.equal(v.status,'rejected');noDispatch(v.reason,spec[0]);}
  return{mode:'conversation',reason:spec[0],transportCalls:calls,unsentPages:4,correctUnsentCause:true};
 }finally{release?.();for(const p of pages)finishConversationJob(p.payload);queue.close();}
}
async function running(spec){
 const pages=[page(`${spec[0]}-failing`,0),page(`${spec[0]}-running`,0),page(`${spec[0]}-running`,1),page(`${spec[0]}-other`,0,'B')];
 let releaseFailure,releaseRunning,started=0,calls=0;
 const queue=createReadyQueue({choose:async rows=>({units:rows.slice(0,1),splitReason:'bounded_synthetic'}),dispatch:async(units,o)=>{
  calls++;started++;
  if(o.imageId===pages[0].imageId){await new Promise(r=>releaseFailure=r);throw fault(spec);}
  if(o.imageId===pages[1].imageId)await new Promise(r=>releaseRunning=r);
  return{translations:units.map(u=>({id:u.id,text:'Retained synthetic translation'})),meta:{conversation:{commitStatus:'committed',historyTurns:1}}};
 }});
 try{
  const tasks=pages.map(p=>{const v=queue.submit([{id:'P0',text:'Synthetic source'}],p);v.catch(()=>{});return v;});
  await wait(()=>started===3);releaseFailure();await tasks[0].catch(()=>{});await new Promise(r=>setTimeout(r,0));releaseRunning();
  const settled=await Promise.allSettled(tasks);assert.equal(calls,3);
  assert.equal(settled[0].status,'rejected');assert.equal(settled[0].reason.code,spec[0]);
  assert.equal(settled[2].status,'rejected');noDispatch(settled[2].reason,spec[0]);
  for(const i of [1,3]){assert.equal(settled[i].status,'fulfilled');assert.equal(settled[i].value.translations[0].text,'Retained synthetic translation');assert.equal(settled[i].value.meta.usage,undefined,'Page projection must not duplicate full request usage');}
  return{mode:'conversation-running',reason:spec[0],transportCalls:calls,startedSameWalletResultRetained:true,otherWalletUnaffected:true,unsentPages:1};
 }finally{releaseFailure?.();releaseRunning?.();for(const p of pages)finishConversationJob(p.payload);queue.close();}
}
async function independent(spec){
 const error=fault(spec);let calls=0;
 const result=await independentTranslation(async()=>{calls++;throw error;},[{id:'P0',text:'Synthetic source'}],{ai:{provider:'paid',translation_mode:'independent'}}).catch(e=>e);
 assert.equal(result,error,'Independent route must retain the original reason and evidence');assert.equal(result.code,spec[0]);assert.equal(calls,1,'Rejected Independent call must not automatically retry');
 return{mode:'independent-original-error',reason:spec[0],transportCalls:calls,correctCause:true,noAutomaticRetry:true};
}
async function capacityNotFenced(spec){
 let calls=0,release,started=false;
 const pages=Array.from({length:5},(_,i)=>page(`${spec[0]}-${spec[2]}-transient`,i));
 const queue=createReadyQueue({choose:async rows=>({units:rows.slice(0,1),splitReason:'bounded_synthetic'}),dispatch:async units=>{
  calls++;if(calls===1){started=true;await new Promise(r=>release=r);throw fault(spec);}
  return{translations:units.map(u=>({id:u.id,text:'Later page translated'})),meta:{conversation:{commitStatus:'committed',historyTurns:1}}};
 }});
 try{
  const tasks=[queue.submit([{id:'P0',text:'Synthetic source'}],pages[0])];tasks[0].catch(()=>{});
  await wait(()=>started);
  for(const p of pages.slice(1)){const task=queue.submit([{id:'P0',text:'Synthetic source'}],p);task.catch(()=>{});tasks.push(task);}
  release();const settled=await Promise.allSettled(tasks);
  assert.equal(settled[0].status,'rejected');assert.equal(settled[0].reason.code,spec[0]);
  assert.equal(calls,5,'Capacity refusal must not stop the remaining pages');
  for(const v of settled.slice(1)){assert.equal(v.status,'fulfilled');assert.equal(v.value.translations[0].text,'Later page translated');}
  assert.match(userMessageForCode(spec[0]),/ชั่วคราว/,'Capacity message says it is temporary');
  return{mode:'transient-capacity',reason:spec[0],transportCalls:calls,fenced:false};
 }finally{release?.();for(const p of pages)finishConversationJob(p.payload);queue.close();}
}
for(const spec of transientCases){
 try{reports.push({passed:true,evidence:spec[2]?'upstream':'admission',...await capacityNotFenced(spec)});}catch(error){reports.push({passed:false,mode:'transient-capacity',reason:spec[0],failure:String(error.message).slice(0,220)});}
}
for(const spec of cases)for(const [name,test] of [['queued',queued],['running',running],['independent',independent]]){
 try{reports.push({passed:true,evidence:spec[2]?'upstream':'admission',...await test(spec)});}catch(error){reports.push({passed:false,evidence:spec[2]?'upstream':'admission',mode:name,reason:spec[0],failure:String(error.message).slice(0,220)});}
}
const failed=reports.filter(r=>!r.passed);
console.log(JSON.stringify({schema:'tp.qa.billing-propagation/1',cases:reports,total:reports.length,passed:reports.length-failed.length,failed:failed.length},null,2));
if(failed.length)process.exitCode=1;
