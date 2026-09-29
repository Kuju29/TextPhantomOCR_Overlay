/** A durable-history write may fail after Local AI has already returned. */
import assert from 'node:assert/strict';
import {conversationTranslation} from '../src/background/ai/translation-paths/conversation.js';
import {localScope} from '../src/background/ai/translation-paths/local-history.js';

let writes=0, calls=0,failNextCommit=false;
const rows=new Map();
const db={transaction(_table,mode){
 const tx={},staged=new Map();
 const finish=()=>queueMicrotask(()=>{
   if(mode==='readwrite'&&failNextCommit){
     failNextCommit=false;tx.error=new Error('QuotaExceededError');tx.onabort?.();return;
   }
   if(mode==='readwrite')for(const [key,value] of staged)rows.set(key,structuredClone(value));
   tx.oncomplete?.();
 });
 const request=work=>{const q={};queueMicrotask(()=>{q.result=structuredClone(work());q.onsuccess?.();finish();});return q;};
 tx.objectStore=()=>({get:key=>request(()=>rows.get(key)),
   count:()=>request(()=>rows.size),
   getAll:()=>{throw new Error('bulk history scan is forbidden');},
   put:value=>{writes++;staged.set(value.scope,structuredClone(value));},
   delete:key=>{staged.delete(key);}});
 return tx;
}};
globalThis.indexedDB={open(){const q={};queueMicrotask(()=>{q.result=db;q.onsuccess?.();});return q;}};
const ai={provider:'lmstudio',model:'fixture',base_url:'http://localhost:1234/v1',
 conversation:{owner:'user',documentId:'doc'},
 model_capabilities:{limits:{contextTokens:8192,maxOutputTokens:2048}}};
const opts={route:'direct-local',ai,targetLang:'th',sourceLang:'en'};
async function dispatch(_units,{conversationContext}){
 await conversationContext.prepare({layout:{userStaticChars:0,userPersistentStaticChars:0,
  instructionLocale:'th',bootstrapExamplesChars:0},system:'SYS',
  user:'\n\n<<TP_P0:Hello>>',schema:null,imageDataUri:'',outputReserve:128,
  executedModel:'fixture',protocol:'lmstudio_native',selectedContract:'v2'});
 calls++;
 conversationContext.capture('<<TP_P0:สวัสดี>>','resp_storage_result_1');
 failNextCommit=true; // The write-ahead marker was durable; the answer commit fails.
 return {translations:[{id:'P0',text:'สวัสดี'}],meta:{terminalCompleted:true,
  usage:{inputTokens:123,outputTokens:9,totalTokens:132,cachedInputTokens:0},
  generationAttempts:1,providerAttempts:1}};
}
const first=await conversationTranslation(dispatch,[{id:'P0',text:'Hello'}],opts);
assert.equal(first.translations[0].text,'สวัสดี');
assert.equal(first.meta.usage.totalTokens,132);
assert.equal(first.meta.conversation.providerCallsAdded,1);
assert.equal(first.meta.conversation.continuationTransport,'native_response_cursor');
assert.equal(first.meta.conversation.commitStatus,'not_committed_storage_unavailable');
const scope=await localScope(ai,'th','en');
assert.equal(rows.get(scope).pending,'provider_result_uncommitted');
await assert.rejects(()=>conversationTranslation(dispatch,[{id:'P0',text:'Next'}],opts),
 e=>e.code==='ai_conversation_storage_unavailable');
assert.equal(calls,1,'same-scope request must stop before a second provider call');
assert.equal(writes,2);
const restarted=await import('../src/background/ai/translation-paths/local-history.js?storage-result-restart');
await assert.rejects(restarted.withLocalHistory(ai,'th','en',null,()=>{}),
 e=>e.code==='ai_conversation_state_pending'&&e.requestDispatched===false,
 'a new worker must not replay stale history after a provider answer could not be stored');

const cancelledAi={...ai,conversation:{...ai.conversation,documentId:'cancelled-doc'}};
await assert.rejects(conversationTranslation(async(_units,{conversationContext})=>{
 await conversationContext.prepare({layout:{userStaticChars:0,userPersistentStaticChars:0,
   instructionLocale:'th',bootstrapExamplesChars:0},system:'SYS',
   user:'\n\n<<TP_P0:Hello>>',schema:null,imageDataUri:'',outputReserve:128,
   executedModel:'fixture',protocol:'lmstudio_native',selectedContract:'v2'});
 throw new DOMException('Cancelled','AbortError');
},[{id:'P0',text:'Hello'}],{...opts,ai:cancelledAi}),e=>e.name==='AbortError');
const cancelledScope=await localScope(cancelledAi,'th','en');
assert.equal(rows.get(cancelledScope).pending,undefined,
 'failed or cancelled generation rolls back its pending marker');
console.log('PASS Local result/usage retained after post-provider IDB failure and fresh-worker fence; cancellation rolls back');
