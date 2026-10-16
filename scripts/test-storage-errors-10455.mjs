// Production integration with synthetic storage, DOM and provider-boundary replies.
// No live OCR, provider, payment or account access. Production files are read-only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {imageRuntime} from './test-storage-finalization-10455.mjs';
import {installSettle} from './lib/settle.mjs';
// Settling waits for WebCrypto (thread pool) digests, not a fixed number of turns.
const settle=installSettle({turns:40});
const root=process.env.TP_PAID_SOURCE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at=rel=>import(pathToFileURL(path.join(root,rel)).href);
const [{createRepairCoordinator},{createTranslationSessionStore},{createPreparedPageJournal},
 {createDispatchJournal},{createResultDelivery},{imageErrorMessage},batches,
 {createBatchRetryCoordinator},{completeBatch},{translateLensPage},order,resultPolicy]=await Promise.all([
 at('src/background/repair/coordinator.js'),at('src/background/translation-session-store.js'),
 at('src/background/repair/prepared-page-journal.js'),at('src/background/repair/dispatch-journal.js'),
 at('src/background/jobs/result-delivery.js'),at('src/background/error-message.js'),at('src/background/batches.js'),
 at('src/background/jobs/batch-retry.js'),at('src/background/reader-placement.js'),
 at('src/background/pipeline/page-translation.js'),at('src/background/ai/translation-paths/order.js'),
 at('src/background/pipeline/result-policy.js')]);
const productionFiles=['src/background/repair/coordinator.js','src/background/translation-session-store.js',
 'src/background/repair/prepared-page-journal.js','src/background/repair/dispatch-journal.js',
 'src/background/jobs/result-delivery.js','src/background/jobs/batch-retry.js',
 'src/background/reader-placement.js','src/background/pipeline/page-translation.js','src/background/pipeline/result-policy.js',
 'src/background/ai/translation-paths/order.js','src/background/batches.js',
 'src/content/image-finder.js','src/content/target-key.js','src/content/overlay/message-controller.js'];
const hashSource=async()=>Object.fromEntries(await Promise.all(productionFiles.map(async rel=>
 [rel,createHash('sha256').update(await readFile(path.join(root,rel))).digest('hex')])));
const beforeHashes=await hashSource();
const noop=()=>{},clone=structuredClone,tick=()=>new Promise(resolve=>setImmediate(resolve));
const spin=()=>settle(40);
const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const observed=[],failures=[],unhandled=[];
process.on('unhandledRejection',error=>unhandled.push({code:error?.code||'',message:String(error?.message||error)}));
const transport=[];
globalThis.chrome={runtime:{lastError:null},tabs:{sendMessage(tabId,message,_options,callback){
 transport.push({tabId,type:message.type,batchId:message.batchId||''});callback?.({ok:true});}}};

async function setup({count=1,maxBytes,sealFailure=false,sealSnapshot=null,executeImpl=null,text='Synthetic source dialogue'}={}){
 let stored={},quotaBytes=Infinity,epoch=7,session='fixture-tab';
 const writes=[],removed=[],insertions=[],events=[],apiCalls=[],contexts=new Map();
 const area={get:async key=>key==null?clone(stored):Array.isArray(key)?Object.fromEntries(key.map(k=>[k,clone(stored[k])])):{[key]:clone(stored[key])},
  set:async patch=>{const next={...stored,...clone(patch)},rejected=size(next)>quotaBytes;
   writes.push({keys:Object.keys(patch),rejected,before:size(stored),after:size(next),limit:Number.isFinite(quotaBytes)?quotaBytes:null,
    phases:Object.values(patch).map(v=>v?.row?.phase||'')});
   if(rejected)throw Object.assign(new Error('QUOTA_BYTES exceeded'),{code:'session_storage_quota'});stored=next;},
  remove:async keys=>{for(const key of[].concat(keys)){removed.push(key);delete stored[key];}}};
 const sessions=createTranslationSessionStore({area:()=>area,...(maxBytes?{maxBytes}:{} )});
 const preparedPages=createPreparedPageJournal({area:()=>area}),dispatchJournal=createDispatchJournal({area:()=>area});
 const batch=batches.ensureBatch(crypto.randomUUID(),Math.floor(Math.random()*1000000)+105550,0);
 const pages=[];
 for(let index=0;index<count;index++){
  const pageId='page-'+index,jobId=batch.id+'-job-'+index;
  const ai={provider:'paid',model:'synthetic/model',translation_mode:'conversation',memory_mode:'off',style_examples:false};
  const payload={engine:'extension',mode:'lens_text',source:'ai',lang:'th',src:'https://fixture.invalid/'+batch.id+'/'+pageId+'.png',
   metadata:{image_id:pageId,batch_id:batch.id},context:{tp_tab_session:session,page_index:index,batch_id:batch.id},ai};
  const runtime=await imageRuntime(payload.src);
  const ctx={jobId,batchId:batch.id,imageKey:pageId,tabId:batch.tabId,frameId:0,imgUrl:payload.src,
   sessionId:session,settingsEpoch:epoch,mode:'lens_text',source:'ai',aiGenerationAttempted:true,generation:runtime.TP.generationFor(runtime.image)};
  contexts.set(jobId,ctx);payload.generation=ctx.generation;
  const result={lensDocument:{schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'en',target:'th'},
   paragraphs:[{id:'p0',sourceText:text+' '+index,items:[]}]},eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}};
  const page={pageId,jobId,payload,ctx,runtime,result,plan:{route:'server',ai}};
  pages.push(page);batch.items.set(pageId,{attempt:1,status:'processing',phase:'ai_generating',payload,presentation:{repairPhase:'collecting'}});
 }
 batch.total1=count;
 let executes=0;
 const coordinator=createRepairCoordinator({sessions,preparedPages,dispatchJournal,
  currentEpoch:()=>epoch,currentSession:()=>session,getBase:async()=> 'http://fixture.invalid',getContext:jobId=>contexts.get(jobId),
  getCapabilitiesFor:async()=>({}),readSettings:async()=>({}),emit:(name,value)=>events.push({name,value}),
  api:async(_run,action,_body,options)=>{apiCalls.push({action,method:options?.method||''});
   if(action==='seal'&&sealFailure)throw Object.assign(new Error('Synthetic repair seal connection failed'),{code:'repair_connection_failed'});
   return action==='seal'?(sealSnapshot||{phase:'done',tasks:[],results:[],unresolved:1}):{};},
  insert:async(_tab,message)=>{const page=pages.find(p=>p.payload.src===message.original);const ack=await page?.runtime.TP.applyInsertMessage(message);
   insertions.push({message,ack});return ack||{ok:true,applied:true};},
  execute:async options=>{executes++;if(executeImpl)return executeImpl(options);
   throw Error('Synthetic fixture must never enter provider repair execution.');}});
 const run=await coordinator.registerBatch(batch,pages.map(p=>p.payload));assert(run);
 const pending=new Map(pages.map(p=>[p.jobId,p.ctx]));let completedCalls=0,completionGate=null;
 const retry=createBatchRetryCoordinator({batchPassStats:batches.batchPassStats,
  selectRetryCandidates:()=>({failed:pages.filter(p=>batch.items.get(p.pageId)?.status==='error').map(p=>p.pageId),permanentErrors:0}),
  onComplete:async(owner,label)=>{completedCalls++;if(completionGate)await completionGate.promise;return completeBatch(owner,label,coordinator);},
  updateToast:noop,stopKeepAlive:async()=>{},addTask:()=>{throw Error('AI image must not be retried.');}});
 const delivery=createResultDelivery({pendingByJob:pending,getTabSessionId:()=>session,getSettingsEpoch:()=>epoch,
  ensureBatch:()=>batch,classifyJobError:()=>({permanent:true}),imageErrorMessage,
  sendToTab:(_tab,message)=>{const page=pages.find(p=>p.payload.src===message.original);const ack=page?.runtime.TP.applyInsertMessage(message);insertions.push({message,ack});},
  removeJob:id=>pending.delete(id),markImagePhase:batches.markImagePhase,batchUpdateToast:noop,
  finalizeBatch:retry.finalizeBatch,isUrlOnlyPayload:()=>false,log:{warn:noop},
  findContext:jobId=>pending.get(jobId),accumulateSeriesMemory:async()=>{},resolveSeriesKey:async()=>'',
  mdCacheKey:()=>'',mdKeyFromUrl:()=>'',normImgSrc:value=>String(value||''),setCachedDataUri:noop,
  setCachedResult:noop,stripImageFields:value=>value,traceNote:noop,
  summarizeResultPresentation:resultPolicy.summarizeResultPresentation,
  evaluateTextNoOverlaySkippable:resultPolicy.isTextNoOverlaySkippable,
  workflow:{renderReady:async()=>{},applyRequested:async()=>{},applied:async()=>{},failed:async()=>{}},
  updateImagePresentation:batches.updateImagePresentation,
  enqueueDomInsert:async(_tab,message)=>{const page=pages.find(p=>p.payload.src===message.original);
   const ack=await page?.runtime.TP.applyInsertMessage(message);insertions.push({message,ack});return ack;},
  onDelivered:(ctx,applied)=>coordinator.markDelivered(ctx,applied),
  shouldDeferImageError:({batch,imageKey,terminalAiError})=>terminalAiError&&coordinator.ownsInitialFailure(batch.id,imageKey),
  accountingQueue:{enqueue:async()=>{},flush:async()=>{},describe:()=>({})}});
 async function prepare(page){await coordinator.capture(batch.id,{stage:'prepared',payload:page.payload,result:page.result,plan:page.plan,
  units:[{id:'g0',text:page.result.lensDocument.paragraphs[0].sourceText,translatable:true,paragraphIds:['p0']}],jobId:page.jobId});}
 async function dispatch(page){await coordinator.capture(batch.id,{stage:'dispatch',payload:page.payload,plan:page.plan,jobId:page.jobId,
  ids:['g0'],operationId:page.jobId+'-operation'});}
 async function finished(page){await coordinator.capture(batch.id,{stage:'finished',payload:page.payload,plan:page.plan,jobId:page.jobId,
  accepted:[],failures:[{id:'g0',reason:'missing'}]});}
 function error(page){delivery.handleJobError(page.jobId,{code:'invalid_model_output',message:'Paid model returned no attributable translation',
  stage:'ai',generationAttempts:1,providerAttempts:1,requestDispatched:true});}
 return {batch,pages,run,sessions,preparedPages,dispatchJournal,coordinator,retry,delivery,prepare,dispatch,finished,error,
  writes,removed,insertions,events,apiCalls,pending,setQuota:()=>quotaBytes=size(stored),setEpoch:value=>epoch=value,setSession:value=>session=value,
  stored:()=>clone(stored),executes:()=>executes,completedCalls:()=>completedCalls,setCompletionGate:value=>completionGate=value};
}

async function test(name,work){const startUnhandled=unhandled.length;try{
 const facts=await work();await spin();assert.equal(unhandled.length,startUnhandled,'No detached promise rejection.');
 observed.push({name,passed:true,...facts});
 }catch(error){observed.push({name,passed:false});failures.push({name,message:error.message,stack:String(error.stack||'').split('\n').slice(0,5)});}}

await test('failed durability latch: unknown receipt and source survive, sibling initial page runs once, no repair',async()=>{
 const f=await setup({count:2}),[a,b]=f.pages;await f.prepare(a);await f.dispatch(a);
 const sourceBefore=await f.preparedPages.get(f.run.id,a.pageId),receiptBefore=await f.dispatchJournal.get(f.run.id,a.pageId);
 f.setQuota();f.apiCalls.length=0;
 // A real Conversation result checkpoint exceeds the shared area's capacity.
 await f.coordinator.capture(f.batch.id,{stage:'finished',payload:a.payload,plan:a.plan,jobId:a.jobId,
  accepted:[{id:'g0',text:'คำแปลที่เพิ่มพื้นที่ในใบรับผล'}],failures:[]});
 assert.equal(f.batch.repair.phase,'unavailable');assert.equal((await f.sessions.get(f.run.id)).phase,'collecting');
 assert(f.writes.some(w=>w.rejected&&w.phases.includes('unavailable')),'The unavailable write itself must fail.');
 assert.equal(f.coordinator.ownsInitialFailure(f.batch.id,a.pageId),false);
 const afterLatch=f.writes.length;
 // Actual page pipeline still performs a sibling's initial call once. Its
 // checkpoint callback now refuses unsafe repair ownership from durable collecting.
 let initialCalls=0;order.reserveConversationJob(b.payload,f.batch.tabId);
 try{
  const result=await translateLensPage({base:'http://fixture.invalid',payload:b.payload,result:b.result,plan:b.plan,
   jobId:b.jobId,cancelBatchId:f.batch.id,onCheckpoint:data=>f.coordinator.capture(f.batch.id,data),
   conversationSubmit:async(units,opts)=>{initialCalls++;await opts.beforeBatchDispatch({units,batchId:'synthetic-once',estimate:{}});
    return {translations:units.map(u=>({id:u.id,text:'สวัสดีเพื่อน'})),missing:[],meta:{generationAttempts:1,providerAttempts:1}};}});
  assert.equal(result.complete,true);assert.equal(result.usable,true);assert.equal(initialCalls,1);
 }finally{order.finishConversationJob(b.payload);}
 assert.equal(f.writes.length,afterLatch,'Sibling checkpoint calls must obey the in-memory latch.');
 batches.markImagePhase(f.batch.id,b.pageId,'done');f.pending.delete(b.jobId);f.error(a);await spin();
 await Promise.all(Array.from({length:12},()=>f.coordinator.finishInitial(f.batch)));await f.sessions.flush();
 assert.equal(f.apiCalls.length,0,'No ledger pages, seal, execute, resend or DELETE after failed authority.');assert.equal(f.executes(),0);
 assert.equal(f.completedCalls(),1);assert.equal(f.batch.lifecycle,'completed');
 assert.equal(transport.filter(m=>m.type==='TP_KEEPALIVE_STOP'&&m.batchId===f.batch.id).length,1,
  'The actual terminal completion path must release the tab keepalive once.');
 assert.deepEqual(await f.preparedPages.get(f.run.id,a.pageId),sourceBefore,'Immutable unknown source bytes stay exact.');
 const receiptAfter=await f.dispatchJournal.get(f.run.id,a.pageId);assert.deepEqual(receiptAfter,receiptBefore);
 assert.equal(receiptAfter.phase,'translating');assert.deepEqual(receiptAfter.evidence.targetIds,['g0']);
 assert.deepEqual(receiptAfter.failures,[],'Unknown dispatch must never be relabeled not_sent.');
 assert.equal(a.runtime.badges().length,1);assert.equal((await f.preparedPages.listRun(f.run.id)).length,1);
 return {initialCalls,repairExecuteCalls:f.executes(),apiCalls:f.apiCalls.length,durablePhase:'collecting',runtimePhase:f.batch.repair.phase,
  unknownReceiptPhase:receiptAfter.phase,sourceAndReceiptExact:true,failedUnavailableWrites:f.writes.filter(w=>w.rejected&&w.phases.includes('unavailable')).length};
});

await test('per-run checkpoint cap preserves full actual source and receipt',async()=>{
 const f=await setup({maxBytes:1600,text:'Synthetic immutable long source '.repeat(400)}),a=f.pages[0];
 await f.prepare(a);await f.dispatch(a);await f.finished(a);
 const sourceBefore=await f.preparedPages.get(f.run.id,a.pageId),receiptBefore=await f.dispatchJournal.get(f.run.id,a.pageId);
 f.apiCalls.length=0;f.error(a);await spin();await f.sessions.flush();
 assert.equal(f.batch.repair.phase,'unavailable');assert.equal(f.batch.repair.code,'SESSION_STORAGE_LIMIT');
 assert.equal(f.executes(),0);assert.equal(f.apiCalls.length,0);assert.equal(a.runtime.badges().length,1);
 assert.deepEqual(await f.preparedPages.get(f.run.id,a.pageId),sourceBefore);
 assert.deepEqual(await f.dispatchJournal.get(f.run.id,a.pageId),receiptBefore);
 assert(sourceBefore.units[0].text.length>10000,'Use actual large source, not a stub state field.');
 return {sourceChars:sourceBefore.units[0].text.length,sourceAndReceiptExact:true,repairExecuteCalls:0,apiCalls:0,visibleBadgeCount:1};
});

await test('accepted initial layer may paint once after repair durability latch without new checkpoint writes',async()=>{
 const f=await setup(),a=f.pages[0];await f.prepare(a);await f.dispatch(a);
 const sourceBefore=await f.preparedPages.get(f.run.id,a.pageId),receiptBefore=await f.dispatchJournal.get(f.run.id,a.pageId);
 f.setQuota();f.apiCalls.length=0;
 await f.coordinator.capture(f.batch.id,{stage:'finished',payload:a.payload,plan:a.plan,jobId:a.jobId,
  accepted:[{id:'g0',text:'สวัสดีเพื่อน'}],failures:[]});
 assert.equal(f.batch.repair.phase,'unavailable');assert.equal((await f.sessions.get(f.run.id)).phase,'collecting');
 const writesAfterLatch=f.writes.length;let paints=0;const consumed=[];
 // The renderer boundary is synthetic; the actual content consumer validates
 // generation and owns its placement ACK before real result-delivery commits.
 a.runtime.TP.applyHtmlOverlay=async(_image,result,_source,_isText,_url,canApply)=>{
  assert.equal(canApply(),true);paints++;consumed.push(result.lensDocument.paragraphs[0].aiText);return{drawn:true};};
 const result=clone(a.result);result.lensDocument.paragraphs[0].aiText='สวัสดีเพื่อน';result.metadata={image_id:a.pageId};
 await Promise.all([f.delivery.handleResult(a.jobId,result),f.delivery.handleResult(a.jobId,result)]);await spin();await f.sessions.flush();
 assert.equal(paints,1);assert.deepEqual(consumed,['สวัสดีเพื่อน']);assert.equal(f.pending.has(a.jobId),false);
 assert.equal(f.batch.items.get(a.pageId).status,'done');assert.equal(f.writes.length,writesAfterLatch,
  'markDelivered must honor unavailable runtime latch, rather than writing a receipt against durable collecting.');
 assert.deepEqual(await f.preparedPages.get(f.run.id,a.pageId),sourceBefore);
 assert.deepEqual(await f.dispatchJournal.get(f.run.id,a.pageId),receiptBefore);
 assert.equal(f.executes(),0);assert.equal(f.apiCalls.length,0);
 return{contentConsumerPaintCalls:paints,acceptedTextConsumed:true,checkpointWritesAfterLatch:0,
  sourceAndUnknownReceiptExact:true,repairExecuteCalls:0,apiCalls:0};
});

await test('blocked seal failure shows paused image error but retains deferred notice and source for recovery',async()=>{
 const f=await setup({sealFailure:true}),a=f.pages[0];await f.prepare(a);await f.dispatch(a);await f.finished(a);
 f.apiCalls.length=0;f.error(a);await spin();await f.sessions.flush();
 const saved=await f.sessions.get(f.run.id);
 assert.equal(saved.phase,'blocked');assert.equal(saved.resumePhase,'collecting');assert.equal(f.batch.repair.phase,'blocked');
 assert(saved.pages[a.pageId].units[0].text.startsWith('Synthetic source dialogue'));
 assert.equal(f.executes(),0);assert.deepEqual(f.apiCalls.map(c=>c.action),['','pages','seal']);
 assert(f.batch.items.get(a.pageId).deferredImageError,'Blocked notice must remain owned for later terminal settlement.');
 assert.equal(a.runtime.badges().length,1,'A blocked seal must show a visible image-corner error, not only a shared toast.');
 const badge=a.runtime.badges()[0];assert(badge.textContent.includes('invalid_model_output'));
 assert(/paused|พัก|หยุด|ชั่วคราว|รอ/i.test(badge.textContent),'The visible notice must explain the repair is paused.');
 const calls=f.apiCalls.length;await spin();assert.equal(f.apiCalls.length,calls,'No automatic blind reconnect or repair dispatch.');
 return {phase:saved.phase,resumePhase:saved.resumePhase,sourceRetained:true,deferredNoticeRetained:true,
  apiCalls:f.apiCalls.map(c=>c.action),visibleBadgeCount:1,repairExecuteCalls:0};
});

await test('blocked sibling failure cannot overwrite an already committed repair patch with its old error',async()=>{
 let committedBeforeThrow=false,paints=0;let f;
 f=await setup({count:2,sealSnapshot:{phase:'repairing',tasks:[],results:[],pending:[]},executeImpl:async options=>{
  const page=await options.getPage(f.pages[0].pageId);
  await options.applyResults([{id:'synthetic-accepted-repair',unitId:'g0',pageId:page.pageId,
   sourceHash:page.units[0].sourceHash,generationId:page.generationId,translation:'ซ่อมแปลแล้ว',state:'answered'}]);
  committedBeforeThrow=(await options.getPage(page.pageId)).delivered===true;
  throw Object.assign(new Error('Synthetic sibling repair receipt interrupted after page ACK'),{code:'repair_receipt_pending'});
 }});
 const [a,b]=f.pages;
 a.runtime.TP.applyHtmlOverlay=async(image,result,_source,_isText,_original,canApply)=>{
  assert(canApply());assert.equal(result.lensDocument.paragraphs[0].aiText,'ซ่อมแปลแล้ว');
  a.runtime.TP.clearImageError?.(image);paints++;return{drawn:true};};
 for(const page of f.pages){await f.prepare(page);await f.dispatch(page);await f.finished(page);}
 f.apiCalls.length=0;f.error(a);f.error(b);await spin();await f.sessions.flush();
 const saved=await f.sessions.get(f.run.id);assert.equal(saved.phase,'blocked');assert.equal(saved.resumePhase,'repairing');
 assert.equal(committedBeforeThrow,true,'Actual coordinator applyResults must have durably committed the successful DOM ACK.');
 assert.equal(saved.pages[a.pageId].delivered,true);assert.equal(saved.pages[b.pageId].delivered,false);assert.equal(paints,1);
 assert.equal(a.runtime.badges().length,0,'The paused notice must consult the latest durable page, not stale pre-repair run.pages.');
 assert.equal(f.batch.items.get(a.pageId).deferredImageError,null,'The actually repaired page no longer owns its initial failure.');
 assert.equal(b.runtime.badges().length,1);assert(f.batch.items.get(b.pageId).deferredImageError);
 assert(b.runtime.badges()[0].textContent.includes('invalid_model_output'));
 const calls=f.apiCalls.length;await spin();assert.equal(f.apiCalls.length,calls);assert.equal(f.executes(),1);
 return{durablePatchCommittedBeforeSiblingError:true,acceptedPatchPaints:paints,acceptedPageErrorBadges:0,
  unresolvedSiblingErrorBadges:1,unresolvedSourceRetained:true,repairExecuteBoundaryCalls:1,automaticRepeatCalls:0};
});

await test('terminal acknowledged repair clears original deferred error and releases source authority',async()=>{
 let f,paints=0;
 f=await setup({sealSnapshot:{phase:'repairing',tasks:[],results:[],pending:[]},executeImpl:async options=>{
  const page=await options.getPage(f.pages[0].pageId);
  await options.applyResults([{id:'synthetic-terminal-repair',unitId:'g0',pageId:page.pageId,
   sourceHash:page.units[0].sourceHash,generationId:page.generationId,translation:'คำแปลที่ซ่อมเรียบร้อย',state:'answered'}]);
  assert.equal((await options.getPage(page.pageId)).delivered,true);
  return{phase:'done',repaired:1,failedUnits:1,unresolved:0,tasks:[],results:[]};
 }});
 const a=f.pages[0];a.runtime.TP.applyHtmlOverlay=async(image,result,_source,_isText,_original,canApply)=>{
  assert(canApply());assert.equal(result.lensDocument.paragraphs[0].aiText,'คำแปลที่ซ่อมเรียบร้อย');
  a.runtime.TP.clearImageError?.(image);paints++;return{drawn:true};};
 await f.prepare(a);await f.dispatch(a);await f.finished(a);f.apiCalls.length=0;f.error(a);await spin();await f.sessions.flush();
 const saved=await f.sessions.get(f.run.id);assert.equal(saved.phase,'done');assert.deepEqual(saved.pages,{});
 assert.equal(paints,1);assert.equal(f.executes(),1);assert.equal(a.runtime.badges().length,0);
 assert.equal(f.batch.items.get(a.pageId).deferredImageError,null);
 assert.equal(f.insertions.filter(x=>x.message.type==='IMAGE_ERROR').length,0);
 assert.equal((await f.preparedPages.listRun(f.run.id)).length,0);assert.equal((await f.dispatchJournal.listRun(f.run.id)).length,0);
 assert.equal(f.apiCalls.filter(c=>c.method==='DELETE').length,1);
 return{terminalPhase:saved.phase,acceptedRepairPaints:1,originalDeferredNoticeCleared:true,
  imageErrorBadges:0,sourceAuthorityReleased:true,repairExecuteBoundaryCalls:1};
});

await test('cancelled owner cannot publish its deferred error when completion resumes',async()=>{
 const f=await setup(),a=f.pages[0];await f.prepare(a);await f.dispatch(a);await f.finished(a);
 const gate=latch();f.setCompletionGate(gate);f.error(a);await tick();
 assert(f.batch.items.get(a.pageId).deferredImageError);await f.coordinator.cancelBatch(f.batch.id,'synthetic_cancel');
 gate.resolve();await spin();
 assert.equal(a.runtime.badges().length,0);assert.equal(f.insertions.filter(x=>x.message.type==='IMAGE_ERROR').length,0);
 assert.equal(f.executes(),0);assert(!f.apiCalls.some(c=>c.action==='seal'));assert.equal(f.batch.cancelled,true);
 return {visibleBadgeCount:0,sealCalls:0,repairExecuteCalls:0,cancelled:true};
});

// .70 owner rule: a settings change is not staleness; only navigation/reload are.
await test('settings change does not hide the running job\'s own image error',async()=>{
 const f=await setup(),a=f.pages[0];await f.prepare(a);await f.dispatch(a);await f.finished(a);
 const gate=latch();f.setCompletionGate(gate);f.setQuota();f.error(a);await tick();
 assert(f.batch.items.get(a.pageId).deferredImageError);
 f.setEpoch(8);
 gate.resolve();await spin();await f.sessions.flush();
 const notices=f.insertions.filter(x=>x.message.type==='IMAGE_ERROR');
 assert.equal(notices.length,1,'the job\'s own error is still shown');assert.equal(a.runtime.badges().length,1);
 return {imageErrorNotices:notices.length,badges:a.runtime.badges().length};
});
for(const staleKind of ['content-generation','tab-session'])await test('stale '+staleKind+' cannot paint an old image error',async()=>{
 const f=await setup(),a=f.pages[0];await f.prepare(a);await f.dispatch(a);await f.finished(a);
 const gate=latch();f.setCompletionGate(gate);f.setQuota();f.error(a);await tick();
 assert(f.batch.items.get(a.pageId).deferredImageError);
 if(staleKind==='content-generation')a.runtime.TP.resetPageInstance('synthetic_navigation');
 if(staleKind==='tab-session')f.setSession('new-tab-session');
 if(staleKind==='settings-epoch')f.setEpoch(8);
 gate.resolve();await spin();await f.sessions.flush();
 assert.equal(a.runtime.badges().length,0);assert.equal(f.executes(),0);assert.equal(f.apiCalls.filter(c=>c.action==='seal').length,0);
 if(staleKind==='content-generation'){
  const notice=f.insertions.find(x=>x.message.type==='IMAGE_ERROR');assert(notice);assert.equal(notice.ack.stale,true);
  assert(f.batch.items.get(a.pageId).deferredImageError,'A stale ACK cannot falsely settle the old notice.');
 }else assert.equal(f.insertions.filter(x=>x.message.type==='IMAGE_ERROR').length,0);
 return {visibleBadgeCount:0,sealCalls:0,repairExecuteCalls:0,staleKind};
});

await test('generic failing completion callback owns rejection and concurrent finalization calls exactly once',async()=>{
 const batch=batches.ensureBatch(crypto.randomUUID(),0,0),page='generic-failure';
 batch.items.set(page,{attempt:1,status:'error',phase:'error',payload:{source:'ai'}});batch.total1=1;
 const gate=latch();let calls=0,reported=0,stops=0,toasts=0;
 const retry=createBatchRetryCoordinator({batchPassStats:batches.batchPassStats,selectRetryCandidates:()=>({failed:[page],permanentErrors:0}),
  onComplete:async()=>{calls++;await gate.promise;throw Object.assign(new Error('Synthetic generic onComplete error'),{code:'synthetic_on_complete'});},
  onCompletionError:(error,owner)=>{assert.equal(error.code,'synthetic_on_complete');assert.equal(owner,batch);reported++;throw Error('Diagnostic callback also failed');},
  updateToast:(_owner,label)=>{assert(label.includes('completion failed'));toasts++;},stopKeepAlive:async()=>{stops++;throw Error('Synthetic keepalive transport failure');}});
 for(let i=0;i<25;i++)retry.finalizeBatch(batch);await tick();assert.equal(calls,1);
 for(let i=0;i<25;i++)retry.finalizeBatch(batch);assert.equal(calls,1);gate.resolve();await spin();
 assert.equal(calls,1);assert.equal(reported,1);assert.equal(stops,1);assert.equal(toasts,1);
 return {simultaneousFinalizeCalls:50,completionCalls:calls,ownedErrors:reported,keepaliveStopAttempts:stops,detachedRejects:0};
});

await test('concurrent healthy coordinator completions transfer source and seal once',async()=>{
 const f=await setup(),a=f.pages[0];await f.prepare(a);await f.dispatch(a);await f.finished(a);f.apiCalls.length=0;
 await Promise.all(Array.from({length:20},()=>f.coordinator.finishInitial(f.batch)));await f.sessions.flush();
 assert.equal(f.apiCalls.filter(c=>c.action==='seal').length,1);assert.equal(f.apiCalls.filter(c=>c.action==='pages').length,1);
 assert.equal(f.executes(),0);assert.equal((await f.sessions.get(f.run.id)).phase,'done');
 assert.equal((await f.preparedPages.listRun(f.run.id)).length,0);assert.equal((await f.dispatchJournal.listRun(f.run.id)).length,0);
 return {simultaneousFinishCalls:20,sealCalls:1,ledgerReportCalls:1,sourceTransferred:true,repairExecuteCalls:0};
});

const afterHashes=await hashSource();const sourceUnchanged=JSON.stringify(beforeHashes)===JSON.stringify(afterHashes);
if(!sourceUnchanged)failures.push({name:'production source changed during fixture',message:'Production SHA256 snapshot differs.'});
console.log(JSON.stringify({scope:'Actual coordinator, shared stores/journals, result delivery, page pipeline, batch completion and content generation consumer; synthetic boundaries only',
 source:root,passed:observed.filter(x=>x.passed).length,total:observed.length,sourceUnchanged,sourceHashes:afterHashes,observed,failures,unhandled},null,2));
process.exitCode=failures.length?1:0;
