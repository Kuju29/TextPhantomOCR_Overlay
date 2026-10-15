/** .10485 storage.session: journals share the run checkpoint budget; oldest finished/stopped runs are evicted first;
 * active runs are never evicted; stopped (unavailable/blocked/failed) runs can be evicted after idling; provider-pressure
 * hint failures do not disable repair. Synthetic storage only. */
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
const {createTranslationSessionStore,translationSessionRunKey}=await import('../src/background/translation-session-store.js');
const {createPreparedPageJournal,translationPreparedPageKey}=await import('../src/background/repair/prepared-page-journal.js');
const {createDispatchJournal,translationDispatchKey}=await import('../src/background/repair/dispatch-journal.js');

function memoryArea(){
  const saved={};let quota=Infinity;
  const bytes=()=>new TextEncoder().encode(JSON.stringify(saved)).length;
  return {saved,setQuota:q=>{quota=q;},area:{
    get:async keys=>keys==null?structuredClone(saved):Object.fromEntries([].concat(keys).filter(k=>k in saved).map(k=>[k,structuredClone(saved[k])])),
    set:async patch=>{const before=structuredClone(saved);Object.assign(saved,structuredClone(patch));
      if(bytes()>quota){for(const k of Object.keys(saved))delete saved[k];Object.assign(saved,before);
        throw new Error('Session storage quota bytes exceeded. QUOTA_BYTES exceeded');}},
    remove:async keys=>{for(const k of [].concat(keys))delete saved[k];},setAccessLevel:async()=>{}}};
}
const MIN=60*1000;
let clock=1_000_000_000_000;const now=()=>clock;
function fixture(maxBytes=30_000){
  const m=memoryArea();
  const sessions=createTranslationSessionStore({area:()=>m.area,now,maxBytes});
  const pages=createPreparedPageJournal({area:()=>m.area,now,budget:sessions.journalBudget});
  const receipts=createDispatchJournal({area:()=>m.area,now,budget:sessions.journalBudget});
  return {m,sessions,pages,receipts};
}
const run=(id,phase)=>({id,createdAt:clock,phase,pages:{},tasks:{},summary:{}});
const bigPage=n=>({pageId:'p',generationId:'g',units:[{id:'g0',text:'x'.repeat(n)}]});

// 1. A new active run's journal evicts the oldest finished run (row + its journals), never an active run.
{
  const f=fixture();
  await f.sessions.update('old-done',()=>run('old-done','collecting'));
  await f.pages.record('old-done','p1',bigPage(12_000));
  await f.receipts.record('old-done','p1',{operationId:'op1',targetIds:['g0']});
  await f.sessions.update('old-done',v=>({...v,phase:'done'}));
  clock+=MIN;
  await f.sessions.update('active-a',()=>run('active-a','collecting'));
  await f.pages.record('active-a','p1',bigPage(12_000));
  clock+=MIN;
  await f.sessions.update('active-b',()=>run('active-b','collecting'));
  await f.pages.record('active-b','p1',bigPage(12_000)); // needs room: only old-done may go
  assert.equal(await f.sessions.get('old-done'),null,'oldest finished run evicted');
  assert.ok(!(translationPreparedPageKey('old-done','p1') in f.m.saved),'its source journal is removed');
  assert.ok(!(translationDispatchKey('old-done','p1') in f.m.saved),'its receipt journal is removed');
  assert.ok(translationPreparedPageKey('active-a','p1') in f.m.saved,'active run journals are kept');
  const usage=await f.sessions.usage();
  assert.ok(usage.bytes<=usage.maxBytes,`budget holds rows+journals (${usage.bytes}/${usage.maxBytes})`);

  // 2. Nothing evictable: the write is refused before storage and existing receipts stay exact.
  const before=structuredClone(f.m.saved);
  await assert.rejects(f.pages.record('active-b','p2',bigPage(20_000)),e=>e.code==='session_checkpoint_limit');
  assert.deepEqual(f.m.saved,before,'refused admission writes nothing and drops nothing');
  assert.equal(await f.pages.get('active-b','p2'),null);
  // A refused write releases its reservation: a small receipt still fits.
  await f.receipts.record('active-b','p1',{operationId:'op',targetIds:['g0']});
  // Removing journals releases budget.
  await f.pages.clearRun('active-a');
  await f.pages.record('active-b','p2',bigPage(10_000));
}

// 3. Finding 9: stopped runs (unavailable/blocked/failed) can be evicted when idle >= 5 min, oldest first.
{
  const f=fixture(10_000_000);
  for(let i=0;i<24;i++){await f.sessions.update(`u${i}`,()=>run(`u${i}`,i%3===0?'blocked':i%3===1?'unavailable':'failed'));clock+=1000;}
  await assert.rejects(f.sessions.update('fresh',()=>run('fresh','collecting')),e=>e.code==='session_checkpoint_limit',
    'recently stopped runs are protected while their batch may still settle');
  clock+=5*MIN;
  await f.sessions.update('fresh',()=>run('fresh','collecting'));
  assert.equal(await f.sessions.get('u0'),null,'oldest stopped run gave its slot');
  assert.ok(await f.sessions.get('u1'));
  // Terminal runs go before stopped ones.
  await f.sessions.update('u5',v=>({...v,phase:'done'}));clock+=1000;
  await f.sessions.update('fresh2',()=>run('fresh2','collecting'));
  assert.equal(await f.sessions.get('u5'),null,'terminal run is evicted before older stopped runs');
  assert.ok(await f.sessions.get('u1'));
  // Removing a row never fails on budget.
  await f.sessions.remove('u1');
}

// 4. Orphan journals (owner run row gone) are reclaimed under pressure.
{
  const f=fixture();
  f.m.saved[translationPreparedPageKey('ghost','p1')]={version:1,runId:'ghost',pageId:'p1',createdAt:clock,page:bigPage(25_000)};
  await f.sessions.update('live',()=>run('live','collecting'));
  await f.pages.record('live','p1',bigPage(15_000));
  assert.ok(!(translationPreparedPageKey('ghost','p1') in f.m.saved),'orphan journal reclaimed');
}

// 5. Provider-pressure checkpoint failure is skipped and traced; repair stays available.
{
  const batches=await import('../src/background/batches.js');
  const {createRepairCoordinator}=await import('../src/background/repair/coordinator.js');
  const m=memoryArea();
  const sessions=createTranslationSessionStore({area:()=>m.area});
  const preparedPages=createPreparedPageJournal({area:()=>m.area,budget:sessions.journalBudget});
  const dispatchJournal=createDispatchJournal({area:()=>m.area,budget:sessions.journalBudget});
  const events=[];
  const coordinator=createRepairCoordinator({sessions,preparedPages,dispatchJournal,api:async()=>({}),
    getBase:async()=>'http://fixture.invalid',currentEpoch:()=>1,currentSession:()=>'s',getContext:()=>({}),
    emit:(name,value)=>events.push({name,value}),insert:async()=>({ok:true})});
  const batch=batches.ensureBatch('pressure-batch-10485',424242,0);
  const payload={engine:'extension',mode:'lens_text',source:'ai',src:'https://x.invalid/a.png',metadata:{image_id:'p1'}};
  batch.items.set('p1',{payload});
  const r=await coordinator.registerBatch(batch,[payload]);assert.ok(r);
  await sessions.update(r.id,v=>({...v,pages:{p1:{pageId:'p1',groupKey:'grp'}}}));
  m.setQuota(1); // every further write is rejected by the browser
  await coordinator.capture(batch.id,{stage:'pressure',imageId:'p1',providerPressure:{until:Date.now()+60000,level:'high'}});
  assert.notEqual(batch.repair?.phase,'unavailable','a pressure hint must not disable repair');
  const skipped=events.find(e=>e.name==='repairCheckpointSkipped');
  assert.ok(skipped&&skipped.value.stage==='pressure'&&skipped.value.essential===false,'skip is traced');
  assert.ok(!events.some(e=>e.name==='repairCheckpointFailed'));
}
console.log('PASS .10485 session journals: shared 6 MB budget, oldest finished→stopped(idle≥5m) eviction, active runs kept, refused writes atomic, orphans reclaimed, pressure hint degrades');
