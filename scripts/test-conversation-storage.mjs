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
    tx.objectStore=()=>({get:k=>request(()=>rows.get(k)),getAll:()=>request(()=>[...rows.values()]),
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
await fresh.withLocalHistory(ai,'th','en',null,async s=>{
  assert.equal(s.storage,'local_memory');assert.equal(s.history.length,1);
  assert.equal(await s.save({history:[{user:'Changed',assistant:'แก้ไข'}],prefix:'p',revision:2}),'local_memory');
});
fail=false;
await fresh.withLocalHistory(ai,'th','en',null,async s=>{
  assert.equal(s.history[0].user,'Changed','storage recovery must not overwrite newer in-memory history');
  assert.equal(s.storage,'local_memory');
  assert.equal(await s.save({history:s.history,prefix:'p',revision:s.revision}),'local_indexeddb');
});
const recovered=await import('../src/background/ai/translation-paths/local-history.js?recovered-worker');
await recovered.withLocalHistory(ai,'th','en',null,s=>assert.equal(s.history[0].user,'Changed'));
console.log('PASS IndexedDB callback fixtures: write/read across module reload, owner/document isolation and obsolete reset ignored, explicit memory fallback; browser engine not exercised');
