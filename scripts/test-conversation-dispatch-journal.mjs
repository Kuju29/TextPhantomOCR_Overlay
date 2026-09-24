import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
import {createTranslationSessionStore} from '../src/background/translation-session-store.js';
import {createRepairCoordinator} from '../src/background/repair/coordinator.js';
import {createDispatchJournal} from '../src/background/repair/dispatch-journal.js';
import {createPreparedPageJournal} from '../src/background/repair/prepared-page-journal.js';
import {ensureBatch} from '../src/background/batches.js';

const saved={};let sessionWrites=0;
const area={
  async get(key){if(key==null)return structuredClone(saved);return {[key]:structuredClone(saved[key])};},
  async set(patch){sessionWrites++;Object.assign(saved,structuredClone(patch));},
  async remove(keys){for(const key of (Array.isArray(keys)?keys:[keys]))delete saved[key];},
  async setAccessLevel(){}
};
const sessions=createTranslationSessionStore({area:()=>area});
const journalArea={
  async get(key){if(key==null)return structuredClone(saved);return {[key]:structuredClone(saved[key])};},
  async set(patch){Object.assign(saved,structuredClone(patch));},
  async remove(keys){for(const key of (Array.isArray(keys)?keys:[keys]))delete saved[key];}
};
const dispatchJournal=createDispatchJournal({area:()=>journalArea});
const preparedPages=createPreparedPageJournal({area:()=>journalArea});
const batchId='conversation-journal',tabId=551;
const payload={engine:'extension',mode:'lens_text',source:'ai',lang:'th',src:'https://fixture/page.png',
  metadata:{image_id:'page'},context:{},ai:{translation_mode:'conversation'}};
const batch=ensureBatch(batchId,tabId,0);batch.items.set('page',{attempt:1,status:'queued',phase:'waiting',payload});
const ctx={jobId:'job',imageKey:'page',tabId,frameId:0,imgUrl:payload.src,mode:'lens_text',source:'ai',lang:'th',
  sessionId:'tab-session',settingsEpoch:1,generation:{pageInstanceId:'p'}};
const pageReports=[];
const coordinator=createRepairCoordinator({sessions,dispatchJournal,preparedPages,api:async(_run,path,body)=>{
  if(path==='pages')pageReports.push(structuredClone(body));
  if(path==='seal')return {phase:'done'};
  return {};
},getBase:async()=> 'https://fixture',getCapabilitiesFor:async()=>({}),
  execute:async()=>({phase:'done',repaired:0,unresolved:1,failedUnits:1,initialAccepted:1,unverified:0,unavailablePages:0}),
  currentEpoch:()=>1,currentSession:()=> 'tab-session',getContext:()=>ctx,insert:async()=>({ok:true}),emit:()=>{}});
const run=await coordinator.registerBatch(batch,[payload]);
const units=[{id:'g0',text:'hello',translatable:true,paragraphIds:['p0']},{id:'g1',text:'world',translatable:true,paragraphIds:['p1']}];
const result={lensDocument:{schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'en',target:'th'},
  paragraphs:[{id:'p0',sourceText:'hello',items:[]},{id:'p1',sourceText:'world',items:[]}]},eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}};
const plan={route:'server',ai:{provider:'openrouter',model:'fixture',translation_mode:'conversation',thinking:'off'}};
const beforePrepared=sessionWrites;
await coordinator.capture(batchId,{stage:'prepared',payload,result,plan,units,jobId:'job',operationId:'initial',imageId:'page'});
assert.equal(sessionWrites,beforePrepared,'Conversation prepared checkpoint must use its per-page key, not rewrite the growing run');
const prepared=await preparedPages.get(run.id,'page');assert.equal(prepared.phase,'prepared');
assert.equal((await sessions.get(run.id)).pages.page,undefined,'canonical run stays small until the repair barrier');
const before=sessionWrites;
await coordinator.capture(batchId,{stage:'dispatch',payload,result,plan,units,jobId:'job',operationId:'turn-1',imageId:'page',ids:['g0','g1']});
assert.equal(sessionWrites,before,'Conversation dispatch must not rewrite the full run checkpoint before provider I/O');
const receipt=await dispatchJournal.get(run.id,'page');assert.deepEqual(receipt.evidence.targetIds,['g0','g1']);
let page=(await sessions.get(run.id)).pages.page;
assert.equal(page,undefined,'full checkpoint stays out of the canonical run during provider I/O');
await coordinator.capture(batchId,{stage:'progress',payload,result,plan,units,jobId:'job',operationId:'turn-1',imageId:'page',
  accepted:[{id:'g0',text:'สวัสดี'}],failures:[{id:'g1',reason:'missing'}]});
page=(await sessions.get(run.id)).pages.page;
assert.equal(page,undefined,'full OCR/render checkpoint is not rewritten on the provider-result hot path');
assert.equal(sessionWrites,before,'Conversation result durability must stay in the small journal, not rewrite the full run');
const resultReceipt=await dispatchJournal.get(run.id,'page');
assert.equal(resultReceipt.accepted[0].text,'สวัสดี');assert.equal(resultReceipt.failures[0].id,'g1');
assert.equal(resultReceipt.dispatches[0].operationId,'turn-1');
await coordinator.capture(batchId,{stage:'finished',payload,result,plan,units,jobId:'job',operationId:'turn-1',imageId:'page',
  accepted:[{id:'g0',text:'สวัสดี'}],failures:[{id:'g1',reason:'missing'}]});
assert.equal((await dispatchJournal.get(run.id,'page')).phase,'finished');
await coordinator.markDelivered(ctx,true);
assert.equal((await dispatchJournal.get(run.id,'page')).delivered,true,'initial delivery ACK remains a compact receipt before the barrier');
await coordinator.finishInitial(batch);
assert.equal(pageReports.length,1,'repair barrier must fold the durable journal before sealing');
assert.equal(pageReports[0].initialAccepted,1);assert.equal(pageReports[0].failed[0].id,'g1');
assert.equal(await dispatchJournal.get(run.id,'page'),null,'folded result receipt is cleared only at the repair barrier');
assert.equal(await preparedPages.get(run.id,'page'),null,'folded source page is cleared only after the canonical barrier write');
const healthyBatch=ensureBatch('conversation-healthy',tabId,0);
healthyBatch.items.set('page',{attempt:1,status:'queued',phase:'waiting',payload});
const healthyRun=await coordinator.registerBatch(healthyBatch,[payload]);
const largeResult={...result,lensDocument:{...result.lensDocument,layoutFixture:'x'.repeat(240*1024)}};
await coordinator.capture(healthyBatch.id,{stage:'prepared',payload,result:largeResult,plan,units,jobId:'job',operationId:'initial',imageId:'page'});
await coordinator.capture(healthyBatch.id,{stage:'dispatch',payload,result:largeResult,plan,units,jobId:'job',operationId:'turn-1',imageId:'page',ids:['g0','g1']});
await coordinator.capture(healthyBatch.id,{stage:'finished',payload,result:largeResult,plan,units,jobId:'job',operationId:'turn-1',imageId:'page',
  accepted:[{id:'g0',text:'หนึ่ง'},{id:'g1',text:'สอง'}],failures:[]});
await coordinator.markDelivered({...ctx,translationRun:{runId:healthyRun.id,pageId:'page'}},true);
const small=await preparedPages.get(healthyRun.id,'page');
assert.equal(small.compacted,true,'fully translated and placed page sheds its render/OCR source before the repair barrier');
assert.equal(small.result,undefined);assert.equal(small.initialAcceptedCount,2);
assert.equal(small.units.length,0);
assert.equal((await dispatchJournal.get(healthyRun.id,'page')).delivered,true);
await coordinator.finishInitial(healthyBatch);
assert.equal(pageReports.at(-1).initialAccepted,2,'the small summary still reports accepted units');
assert.equal((await sessions.get(healthyRun.id)).phase,'done');
assert.equal(await preparedPages.get(healthyRun.id,'page'),null);
console.log('PASS Conversation page journals: prepared source, dispatch/result and delivery durability stay per-page until the repair barrier');

// The previous all-at-once fold temporarily doubled every unmounted page.
// Emulate Chrome's shared 10 MiB quota: 18 * 300 KiB fits once, not twice.
{
  const quota=10*1024*1024,source={};let peak=0,reports=0;
  const bytes=state=>Object.entries(state).reduce((total,[key,value])=>total+Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(value)),0);
  const limited={
    async get(key){return key==null?structuredClone(source):{[key]:structuredClone(source[key])}},
    async set(patch){const next={...source,...structuredClone(patch)},used=bytes(next);
      if(used>quota)throw new Error('Session storage quota bytes exceeded. Values were not stored.');
      Object.assign(source,patch);peak=Math.max(peak,used);},
    async remove(keys){for(const key of (Array.isArray(keys)?keys:[keys]))delete source[key];},
    async setAccessLevel(){}
  };
  const durable=createTranslationSessionStore({area:()=>limited});
  const pages=createPreparedPageJournal({area:()=>limited});
  const receipts=createDispatchJournal({area:()=>limited});
  const runBatch=ensureBatch('conversation-quota',552,0);
  const payloads=Array.from({length:18},(_,i)=>({...payload,src:`https://fixture/${i}.png`,metadata:{image_id:`page-${i}`} }));
  for(const p of payloads)runBatch.items.set(p.metadata.image_id,{attempt:1,status:'queued',phase:'waiting',payload:p});
  let tabSession='tab-session';
  const folding=createRepairCoordinator({sessions:durable,preparedPages:pages,dispatchJournal:receipts,
    api:async(_run,path)=>{if(path==='pages')reports++;return path==='seal'?{phase:'done'}:{};},
    getBase:async()=> 'https://fixture',currentEpoch:()=>1,currentSession:()=> tabSession,
    insert:async()=>({ok:true}),emit:()=>{}});
  const active=await folding.registerBatch(runBatch,payloads);
  for(const p of payloads)await pages.record(active.id,p.metadata.image_id,{
    pageId:p.metadata.image_id,generationId:'gen',groupKey:'group',phase:'prepared',delivered:false,
    result:{render:'x'.repeat(300*1024)},units:[{id:'g0',text:'source',sourceHash:'h',translatable:true}],
    accepted:[],failures:[],blocked:[],inFlight:[],repaired:[]});
  assert(bytes(source)>5*1024*1024,'the fixture exercises a chapter large enough to exceed quota when doubled');
  await folding.finishInitial(runBatch);
  assert.equal(reports,18);assert(peak<quota,'journal transfer stays under the shared quota');
  assert.equal((await durable.get(active.id)).phase,'done');
  assert.equal((await pages.listRun(active.id)).length,0,'all large prepared keys are released after transfer');
  const oldBatch=ensureBatch('conversation-old-tab',552,0),oldPayload={...payload,src:'https://fixture/old',metadata:{image_id:'old'}};
  oldBatch.items.set('old',{attempt:1,status:'queued',phase:'waiting',payload:oldPayload});
  const old=await folding.registerBatch(oldBatch,[oldPayload]);
  await pages.record(old.id,'old',{pageId:'old',phase:'prepared',result:{render:'x'.repeat(300*1024)}});
  tabSession='next-session';
  const nextBatch=ensureBatch('conversation-new-tab',552,0),nextPayload={...payload,src:'https://fixture/new',metadata:{image_id:'new'}};
  nextBatch.items.set('new',{attempt:1,status:'queued',phase:'waiting',payload:nextPayload});
  const next=await folding.registerBatch(nextBatch,[nextPayload]);
  assert(next?.id,'a new session can start with a different image source');
  assert.equal(await durable.get(old.id),null,'the old tab session run is removed before the next job is registered');
  assert.equal(await pages.get(old.id,'old'),null,'old large page source is released for the next job');
  console.log('PASS quota-bound chapter: per-page transfer keeps prepared source and canonical run from doubling');
}
