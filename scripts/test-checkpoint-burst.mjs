import assert from 'node:assert/strict';
import {createTranslationSessionStore, TRANSLATION_SESSION_KEY} from '../src/background/translation-session-store.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
let saved = {}, writes=0, gate=null, entered=null, fail=false;
const area={get:async key=>({[key]:structuredClone(saved[key])}),set:async patch=>{
  writes++; entered?.resolve(); if(gate) await gate.promise;
  if(fail) throw new Error('write failed'); saved=structuredClone(patch);
}};
const store=createTranslationSessionStore({area:()=>area});
await store.update('r',()=>({createdAt:Date.now(),phase:'collecting',count:0}));
await store.update('other',()=>({createdAt:Date.now(),phase:'collecting',count:9}));
writes=0;gate=deferred();entered=deferred();let resolved=0;
const burst=Array.from({length:24},()=>store.update('r',r=>({...r,count:r.count+1})).then(r=>{resolved++;return r.count;}));
await entered.promise;
assert.equal(writes,1);assert.equal(resolved,0,'no caller released before commit');
assert.equal((await store.get('other')).count,9,'unrelated reads must not wait for a write');
let sameRead=false;const read=store.get('r').then(r=>{sameRead=true;return r;});
await Promise.resolve();assert.equal(sameRead,false);
gate.resolve();assert.deepEqual(await Promise.all(burst),Array.from({length:24},(_,i)=>i+1));
assert.equal((await read).count,24);
assert.equal(saved[TRANSLATION_SESSION_KEY].runs.r.count,24);
gate=null;entered=null;fail=true;
await assert.rejects(store.update('r',r=>({...r,count:99})),/write failed/);
assert.equal((await store.get('r')).count,24,'failed write must not publish');
fail=false;
const bad=store.update('r',()=>{throw new Error('bad reducer');});
const good=store.update('r',r=>({...r,count:r.count+1}));
await assert.rejects(bad,/bad reducer/);assert.equal((await good).count,25);
await store.remove('r');assert.equal(await store.get('r'),null);
assert.equal(await createTranslationSessionStore({area:()=>area}).get('r'),null);
console.log('PASS checkpoint burst: 24 updates / 1 durable write; ordered snapshots, read isolation, rollback, recovery, removal');

// Exact quota boundaries include escaped keys, multibyte text and commas.
{
 const now=()=>1000, key='quoted"\\key', other='ไทย';
 const row={createdAt:1000,phase:'collecting',text:'ไทย😀"\\'};
 const expected={ [key]:{...row,id:key,updatedAt:1000},[other]:{...row,id:other,updatedAt:1000} };
 const exact=new TextEncoder().encode(JSON.stringify(expected)).length;
 const make=(maxBytes)=>createTranslationSessionStore({now,maxBytes,area:()=>({get:async()=>({}),set:async()=>{}})});
 const fits=make(exact);await fits.update(key,()=>row);await fits.update(other,()=>row);
 const tight=make(exact-1);await tight.update(key,()=>row);
 await assert.rejects(tight.update(other,()=>row),{code:'session_checkpoint_limit'});
 assert.equal(await tight.get(other),null,'rejected size candidate must not publish');
 await fits.update(key,r=>({...r,text:'x'}));
 const clone=await fits.get(other);clone.text='x'.repeat(exact);
 await fits.update(key,r=>({...r,text:row.text}));
 assert.equal((await fits.get(other)).text,row.text,'caller mutation cannot corrupt immutable size cache');
 const eviction=make(exact-8);await eviction.update(key,()=>({...row,phase:'done'}));await eviction.update(other,()=>row);
 assert.equal(await eviction.get(key),null,'terminal rows still evicted to satisfy exact quota');
}
console.log('PASS checkpoint exact UTF-8 limits, escaping, immutable size cache and eviction');
