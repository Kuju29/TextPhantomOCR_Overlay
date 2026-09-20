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
console.log('PASS Conversation page journals: prepared source, dispatch/result and delivery durability stay per-page until the repair barrier');
