/** IndexedDB event-boundary fixtures; not a substitute for a browser persistence test. */
import assert from 'node:assert/strict';
const rows=new Map();let fail=false;
function database(){return {
  createObjectStore(){},
  transaction(){
    const tx={};let waiting=0,scheduled=false,aborted=false;
    const complete=()=>{
      if(scheduled||aborted)return;scheduled=true;
      setTimeout(()=>{scheduled=false;if(!waiting)tx.oncomplete?.();else complete();},0);
    };
    const request=work=>{
      const q={};waiting++;
      setTimeout(()=>{
        if(fail){aborted=true;tx.error=new Error('synthetic IDB failure');tx.onabort?.();return;}
        q.result=structuredClone(work());q.onsuccess?.();waiting--;complete();
      },0);return q;
    };
    tx.objectStore=()=>({get:k=>request(()=>rows.get(k)),count:()=>request(()=>rows.size),
      getAll:()=>{throw new Error('bulk history scan is forbidden');},
      put:v=>request(()=>{rows.set(v.scope,structuredClone(v));}),delete:k=>request(()=>rows.delete(k))});
    return tx;
  }
};}
globalThis.indexedDB={open(){const q={};setTimeout(()=>{q.result=database();q.onupgradeneeded?.();q.onsuccess?.();},0);return q;}};
const ai={provider:'ollama',model:'fixture',thinking:'off',conversation:{owner:'a',documentId:'doc',reset:'0'}};
const first=await import('../src/background/ai/translation-paths/local-history.js?first-worker');
await first.withLocalHistory(ai,'th','en',null,async s=>{
  assert.equal(s.history.length,0);
  assert.equal(await s.save({history:[{user:'Hello',assistant:'สวัสดี'}],prefix:'p',revision:1}),'local_indexeddb');
});
const fresh=await import('../src/background/ai/translation-paths/local-history.js?new-worker');
await fresh.withLocalHistory(ai,'th','en',null,async s=>{
  assert.equal(s.history.length,1);assert.equal(s.history[0].assistant,'สวัสดี');assert.equal(s.storage,'local_indexeddb');
});
for(const conversation of [{owner:'b',documentId:'doc',reset:'0'},{owner:'a',documentId:'doc2',reset:'0'},{owner:'a',documentId:'doc3',reset:'1'}]){
  await fresh.withLocalHistory({...ai,conversation},'th','en',null,s=>assert.equal(s.history.length,0));
}
await fresh.withLocalHistory({...ai,conversation:{...ai.conversation,reset:'obsolete'}},'th','en',null,s=>assert.equal(s.history.length,1,'manual reset no longer changes the dynamic scope'));
fail=true;
await assert.rejects(()=>fresh.withLocalHistory(ai,'th','en',null,()=>{}),
  error=>error.code==='ai_conversation_storage_unavailable');
fail=false;
await fresh.withLocalHistory(ai,'th','en',null,async s=>{
  s.history.push({user:'Only in worker memory'});
  fail=true;
  try {
    await assert.rejects(()=>s.save({history:[{user:'Not durable',assistant:'ไม่บันทึก'}],prefix:'p',revision:2}),
      error=>error.code==='ai_conversation_storage_unavailable');
  } finally {fail=false;}
});
await assert.rejects(()=>fresh.withLocalHistory(ai,'th','en',null,()=>{}),
  error=>error.code==='ai_conversation_storage_unavailable',
  'A failed history commit must fence subsequent turns in this worker');
const recovered=await import('../src/background/ai/translation-paths/local-history.js?recovered-worker');
await recovered.withLocalHistory(ai,'th','en',null,s=>{
  assert.equal(s.history.length,1,'failed commit and mutated worker memory must not publish another turn');
  assert.equal(s.history[0].user,'Hello');
});
const changed={...ai,conversation:{owner:'changed',documentId:'doc'}};
await recovered.withLocalHistory(changed,'th','en',null,s=>s.save({history:[{user:'Durable'}],prefix:'p',revision:1}));
const changedScope=await recovered.localScope(changed,'th','en');
const durable=structuredClone(rows.get(changedScope));
rows.set(changedScope,{...durable,history:[],revision:0});
await assert.rejects(()=>recovered.withLocalHistory(changed,'th','en',null,()=>{}),
  error=>error.code==='ai_conversation_storage_unavailable',
  'A rolled-back IDB record must never be replaced by a newer worker-memory record');
rows.delete(changedScope);
await assert.rejects(()=>recovered.withLocalHistory(changed,'th','en',null,()=>{}),
  error=>error.code==='ai_conversation_storage_unavailable',
  'A deleted IDB record must never be resurrected from worker memory');
rows.set(changedScope,durable);
const previousIndexedDB=globalThis.indexedDB;
const vanished={...ai,conversation:{owner:'vanished',documentId:'doc'}};
globalThis.chrome={runtime:{id:'fixture-extension'}};
await recovered.withLocalHistory(vanished,'th','en',null,async s=>{
  globalThis.indexedDB=undefined;
  try {
    await assert.rejects(()=>s.save({history:[{user:'No database'}],prefix:'p',revision:1}),
      error=>error.code==='ai_conversation_storage_unavailable');
  } finally {globalThis.indexedDB=previousIndexedDB;}
});
await assert.rejects(()=>recovered.withLocalHistory(vanished,'th','en',null,()=>{}),
  error=>error.code==='ai_conversation_storage_unavailable',
  'A vanished IDB during commit must not restart the same conversation');
globalThis.indexedDB=undefined;
const missing=await import('../src/background/ai/translation-paths/local-history.js?missing-browser-idb');
await assert.rejects(()=>missing.withLocalHistory(ai,'th','en',null,()=>{}),
  error=>error.code==='ai_conversation_storage_unavailable');
globalThis.indexedDB=previousIndexedDB;
delete globalThis.chrome;
console.log('PASS IndexedDB callback fixtures: worker reload, isolation, obsolete reset, fail-closed storage; browser engine not exercised');
