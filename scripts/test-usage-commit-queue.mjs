import assert from 'node:assert/strict';
import {createUsageCommitQueue} from '../src/shared/ai/usage-commit-queue.js';
let checks=0;
async function test(name, fn){await fn();checks++;console.log('PASS '+name);}
const tick=()=>new Promise(r=>setImmediate(r));
function harness({hold=false,fail=false}={}) {
 let data={events:[]},reads=0,writes=0,locks=0,release;const stats=[];
 const gate=hold?new Promise(r=>release=r):Promise.resolve();
 const commit=createUsageCommitQueue({read:async()=>{reads++;await gate;return structuredClone(data);},
  write:async v=>{writes++;if(fail)throw new Error('storage unavailable');data=structuredClone(v);},
  normalize:v=>structuredClone(v),lock:async fn=>{locks++;return fn();},maxBatch:32});
 return {commit,release,stats,read:()=>data,counts:()=>({reads,writes,locks}),unfail:()=>fail=false};
}
await test('24 concurrent intents use one read/write, resolve only after durable commit, preserve order',async()=>{
 const h=harness({hold:true});let resolved=0;
 const requests=Array.from({length:24},(_,i)=>h.commit(v=>({events:[...v.events,i]}),{onTiming:t=>h.stats.push(t)}).then(v=>{resolved++;return v;}));
 await tick();assert.equal(resolved,0);assert.equal(h.counts().reads,1);assert.equal(h.counts().writes,0);
 h.release();const values=await Promise.all(requests);assert.equal(resolved,24);
 assert.deepEqual(h.read().events,Array.from({length:24},(_,i)=>i));assert.deepEqual(h.counts(),{reads:1,writes:1,locks:1});
 assert.equal(values[0].events.length,1);assert.equal(values[23].events.length,24);
 assert(h.stats.every(t=>t.batchSize===24&&t.persistMs>=0&&t.queueMs>=0&&t.writeMs>=0));
});
await test('reset and later receipt stay in call order, not sorted by outcome',async()=>{
 const h=harness();await Promise.all([h.commit(v=>({events:[...v.events,'old']})),h.commit(()=>({events:[]})),h.commit(v=>({events:[...v.events,'new']}))]);
 assert.deepEqual(h.read().events,['new']);assert.equal(h.counts().writes,1);
});
await test('write failure rejects all intents without claiming durability; later commit recovers',async()=>{
 const h=harness({fail:true});const results=await Promise.allSettled([1,2,3].map(i=>h.commit(v=>({events:[...v.events,i]}))));
 assert(results.every(v=>v.status==='rejected'));assert.deepEqual(h.read().events,[]);
 h.unfail();await h.commit(v=>({events:[...v.events,4]}));assert.deepEqual(h.read().events,[4]);
});
await test('timing callbacks cannot reverse a committed ledger or cause provider replay',async()=>{
 const h=harness();const result=await h.commit(v=>({events:[...v.events,1]}),{onTiming(){throw new Error('diagnostic failure');},onCommit(){throw new Error('trace failure');}});
 assert.deepEqual(result.events,[1]);assert.deepEqual(h.read().events,[1]);
});
await test('one invalid reducer does not poison unrelated pending events in the same burst',async()=>{
 const h=harness();const results=await Promise.allSettled([
  h.commit(v=>({events:[...v.events,'A']})),h.commit(()=>{throw new Error('bad event');}),h.commit(v=>({events:[...v.events,'B']}))]);
 assert.deepEqual(results.map(r=>r.status),['fulfilled','rejected','fulfilled']);
 assert.deepEqual(h.read().events,['A','B']);assert.equal(h.counts().writes,1);
});
await test('large bursts are bounded to 32 and no task lost across batch boundaries',async()=>{
 const h=harness();await Promise.all(Array.from({length:70},(_,i)=>h.commit(v=>({events:[...v.events,i]}))));
 assert.equal(h.counts().reads,3);assert.equal(h.counts().writes,3);assert.equal(new Set(h.read().events).size,70);
});
await test('request arriving during authoritative read joins ordered transaction before reducers',async()=>{
 const h=harness({hold:true}),a=h.commit(v=>({events:[...v.events,'A']}));await tick();
 const b=h.commit(v=>({events:[...v.events,'B']}));h.release();await Promise.all([a,b]);
 assert.equal(h.counts().reads,1);assert.deepEqual(h.read().events,['A','B']);
});
await test('write-phase arrivals require another authoritative read',async()=>{
 let data={events:[]},reads=0,release,entered;
 const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);
 const commit=createUsageCommitQueue({read:async()=>{reads++;return structuredClone(data);},
  write:async v=>{entered();await gate;data=structuredClone(v);},normalize:v=>v,lock:fn=>fn()});
 const first=commit(v=>({events:[...v.events,'A']}));await start;
 const second=commit(v=>({events:[...v.events,'B']}));release();await Promise.all([first,second]);
 assert.equal(reads,2);assert.deepEqual(data.events,['A','B']);
});
await test('exact adjacent equality, trace-off encoding budget, and callback timing',async()=>{
 let time=0,writes=0;const results=[],timings=[];
 const commit=createUsageCommitQueue({read:async()=>({n:0}),write:async()=>{writes++;},normalize:v=>v,lock:fn=>fn(),clock:()=>time});
 const stringify=JSON.stringify;let encodes=0;
 JSON.stringify=(...args)=>{encodes++;return stringify(...args);};
 try {
  await Promise.all(Array.from({length:24},()=>commit(v=>({n:v.n+1}))));
  assert.equal(encodes,2,'unobserved batch encodes only original and final ledger');
  encodes=0;
  const onCommit=result=>{results.push(result.unchanged);time+=7;};
  await Promise.all([commit(v=>({n:v.n+1}),{onCommit,onTiming:t=>timings.push(t)}),
    commit(v=>({...v}),{onCommit,onTiming:t=>timings.push(t)}),
    commit(()=>({n:0}),{onCommit,onTiming:t=>timings.push(t)})]);
  assert.equal(encodes,4,'three observed events share adjacent encodings');
 } finally {JSON.stringify=stringify;}
 assert.deepEqual(results,[false,true,false]);
 assert(timings.every(t=>t.callbackMs===7&&t.persistMs>=t.callbackMs));
 assert.equal(writes,1,'net unchanged observed batch needs no write');
});
await test('late read-phase task timings exclude time before its arrival',async()=>{
 let time=0,release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r),timings=[];
 const commit=createUsageCommitQueue({clock:()=>time,read:async()=>{time=10;entered();await gate;time=30;return {n:0};},
  write:async()=>{time=40;},normalize:v=>v,lock:fn=>fn()});
 const first=commit(v=>({n:v.n+1}));await start;time=20;
 const second=commit(v=>({n:v.n+1}),{onTiming:t=>timings.push(t)});release();await Promise.all([first,second]);
 assert.equal(timings[0].readMs,10);assert.equal(timings[0].persistMs,20);
 assert.equal(timings[0].lockMs,0);assert.equal(timings[0].batchSize,2);
});
console.log(`${checks}/${checks} durable burst queue checks passed; no provider I/O.`);
