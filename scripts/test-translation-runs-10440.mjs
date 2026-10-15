/** Production transport/READY ownership with synthetic responses; no provider network. */
import assert from 'node:assert/strict';
import {createReadyQueue} from '../src/background/ai/translation-paths/ready-queue.js';
import {reserveConversationJob, finishConversationJob} from '../src/background/ai/translation-paths/order.js';
globalThis.chrome={runtime:{getManifest:()=>({version:'qa'})},storage:{local:{get:(keys,callback)=>callback({}),set:(_value,callback)=>callback?.()}}};
const {translateViaServer}=await import('../src/background/ai/transports/server.js');
const posts=[];
globalThis.fetch=async(_url,init)=>{
 const body=JSON.parse(init.body);posts.push(body);
 return new Response(JSON.stringify({schema:'tp.ai.result/1',translations:body.units.map(u=>({id:u.id,text:'คำแปล'})),missing:[],meta:{resolvedProvider:'paid',resolvedModel:'qa/test',generationAttempts:1,providerAttempts:1}}),{status:200,headers:{'content-type':'application/json'}});
};
for(const operationId of ['generation-main','generation-repair'])await translateViaServer([{id:'P0',text:'Hello world'}],{
 base:'https://fixture.invalid',targetLang:'th',batchId:'one-user-click',operationId,
 ai:{provider:'paid',model:'qa/test',api_key:'synthetic-session',conversation:{batchId:operationId}},
});
assert.deepEqual(posts.map(p=>p.userRunId),['one-user-click','one-user-click']);
assert.deepEqual(posts.map(p=>p.operationId),['generation-main','generation-repair']);
assert.deepEqual(posts.map(p=>p.conversation.batchId),['generation-main','generation-repair']);
await translateViaServer([{id:'P0',text:'Hello world'}],{base:'https://fixture.invalid',targetLang:'th',operationId:'legacy',ai:{provider:'paid',model:'qa/test',api_key:'synthetic-session'}});
assert.ok(!('userRunId' in posts.at(-1)), 'Legacy operation must not invent a user-click owner');

function page(index,run,provider,document){
 const payload={source:'ai',lang:'th',context:{page_url:document,tp_tab_session:'qa-owner',page_index:index},metadata:{image_id:'page-'+index,batch_id:run},ai:{provider,model:'qa/test',translation_mode:'conversation'}};
 reserveConversationJob(payload,1);
 return {payload,ai:payload.ai,imageId:'page-'+index,batchId:run,targetLang:'th',sourceLang:'en',route:'server',sourceFingerprint:'a'.repeat(64)};
}
async function ready(runs,provider='paid'){
 const calls=[];
 // Use one actual document reservation key; different clicks retain its ordering/history.
 const document='run-boundary-'+crypto.randomUUID();
 const owned=runs.map((run,i)=>page(i,run,provider,document));
 const queue=createReadyQueue({choose:async rows=>({units:rows,splitReason:'ready_queue_drained'}),dispatch:async(units,options,plan)=>{
  calls.push({run:options.batchId,pages:plan.origins.map(o=>o.pageId)});
  return {translations:units.map(u=>({id:u.id,text:'คำแปล'})),missing:[],meta:{}};
 }});
 try {
  const results=await Promise.all(owned.map((p,i)=>queue.submit([{id:'P0',text:'Source page '+i}],p)));
  assert.ok(results.every(r=>r.translations.length===1&&r.missing.length===0));
  return calls;
 }finally{for(const p of owned)finishConversationJob(p.payload);queue.close();}
}
assert.deepEqual(await ready(['one-click','one-click','second-click']),[
 {run:'one-click',pages:['page-0','page-1']},{run:'second-click',pages:['page-2']},
]);
assert.equal((await ready(['click-A','click-B'],'ollama')).length,1,'Local conversation grouping remains independent of Paid charge presentation');
console.log(JSON.stringify({passed:5,checks:['Main and repair wire carry same user run','Provider operation IDs stay independent','Legacy run remains absent','Paid READY only combines pages from one click','Local READY behavior retained']}));
