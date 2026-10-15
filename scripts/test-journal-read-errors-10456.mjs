// Production integration with synthetic storage, DOM and provider-boundary replies.
// No live OCR, provider, payment or account access. Production files are read-only.
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
globalThis.crypto ||= webcrypto;
const root=process.env.TP_PAID_SOURCE || fileURLToPath(new URL('../', import.meta.url));
const {imageRuntime}=await import(pathToFileURL(path.join(root,'scripts/test-storage-finalization-10455.mjs')).href);
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
const spin=async()=>{for(let i=0;i<40;i++)await tick();};
const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const observed=[],failures=[],unhandled=[];
process.on('unhandledRejection',error=>unhandled.push({code:error?.code||'',message:String(error?.message||error)}));
const transport=[];
globalThis.chrome={runtime:{lastError:null},tabs:{sendMessage(tabId,message,_options,callback){
 transport.push({tabId,type:message.type,batchId:message.batchId||''});callback?.({ok:true});}}};

async function setup({count=1,maxBytes,sealFailure=false,sealSnapshot=null,executeImpl=null,text='Synthetic source dialogue',diagnosticSinkThrows=false}={}){
 let stored={},quotaBytes=Infinity,epoch=7,session='fixture-tab';
 const writes=[],removed=[],insertions=[],events=[],apiCalls=[],contexts=new Map();
 const area={get:async key=>key==null?clone(stored):Array.isArray(key)?Object.fromEntries(key.map(k=>[k,clone(stored[k])])):{[key]:clone(stored[key])},
  set:async patch=>{const next={...stored,...clone(patch)},rejected=size(next)>quotaBytes;
   writes.push({keys:Object.keys(patch),rejected,before:size(stored),after:size(next),limit:Number.isFinite(quotaBytes)?quotaBytes:null,
    phases:Object.values(patch).map(v=>v?.row?.phase||''),
    failureReasons:Object.values(patch).flatMap(v=>Object.values(v?.row?.pages||{}).flatMap(p=>(p.failures||[]).map(r=>({id:r.id,reason:r.reason}))))});
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
  getCapabilitiesFor:async()=>({}),readSettings:async()=>({}),emit:(name,value)=>{
   events.push({name,value});
   if(diagnosticSinkThrows&&name==='repairCheckpointFailed')throw new Error('Synthetic diagnostic sink unavailable');
  },
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
 return {area,batch,pages,run,sessions,preparedPages,dispatchJournal,coordinator,retry,delivery,prepare,dispatch,finished,error,
  writes,removed,insertions,events,apiCalls,pending,setQuota:()=>quotaBytes=size(stored),setEpoch:value=>epoch=value,setSession:value=>session=value,
  stored:()=>clone(stored),executes:()=>executes,completedCalls:()=>completedCalls,setCompletionGate:value=>completionGate=value};
}

async function test(name,work){const startUnhandled=unhandled.length;try{
 const facts=await work();await spin();assert.equal(unhandled.length,startUnhandled,'No detached promise rejection.');
 observed.push({name,passed:true,...facts});
 }catch(error){observed.push({name,passed:false});failures.push({name,message:error.message,stack:String(error.stack||'').split('\n').slice(0,5)});}}


// Independent proof: actual journal.listRun executes, only its native storage
// get(null) is rejected. Preserve all immutable source/receipt bytes and refuse
// repair after a read failure; do not convert absent authority into not_sent.
for (const {fault,diagnosticSinkThrows} of [
 {fault:'preparedPages',diagnosticSinkThrows:false},
 {fault:'dispatchJournal',diagnosticSinkThrows:false},
 {fault:'preparedPages',diagnosticSinkThrows:true},
]) await test(fault+'.listRun storage read rejection'+(diagnosticSinkThrows?' with throwing diagnostics':'')+' retains unknown authority', async()=>{
 const f=await setup({diagnosticSinkThrows}),a=f.pages[0];await f.prepare(a);await f.dispatch(a);
 const syntheticSecret='SYNTHETIC_CREDENTIAL_SENTINEL_JOURNAL56';
 const syntheticSource=a.result.lensDocument.paragraphs[0].sourceText;
 const before=f.stored();
 const preparedKey=Object.keys(before).find(k=>k.startsWith('tpTranslationPreparedPageV1:'));
 const dispatchKey=Object.keys(before).find(k=>k.startsWith('tpTranslationDispatchV1:'));
 assert(preparedKey&&dispatchKey,'Actual durable source and receipt must exist before injection.');
 assert.equal(before[dispatchKey].phase,'translating');
 assert.equal(before[dispatchKey].dispatches.length,1);
 assert.deepEqual(before[dispatchKey].dispatches[0].targetIds,['g0']);
 assert.deepEqual(before[dispatchKey].failures,[]);
 const nativeGet=f.area.get,nativeList=f[fault].listRun;
 let reading=false,readRejections=0;
 f.area.get=async key=>{
  if(reading&&key===null&&readRejections===0){readRejections++;throw Object.assign(
   new Error('Synthetic '+fault+' read rejected; credential='+syntheticSecret+'; source='+syntheticSource),
   {code:'synthetic_journal_read_failed',api_key:syntheticSecret,sourceText:syntheticSource});}
  return nativeGet(key);
 };
 f[fault].listRun=async id=>{reading=true;try{return await nativeList(id);}finally{reading=false;}};
 f.apiCalls.length=0;f.removed.length=0;
 f.error(a);await spin();await f.coordinator.finishInitial(f.batch);await f.sessions.flush();await spin();
 const after=f.stored(),run=await f.sessions.get(f.run.id);
 const sourcePreserved=JSON.stringify(after[preparedKey])===JSON.stringify(before[preparedKey]);
 const receiptPreserved=JSON.stringify(after[dispatchKey])===JSON.stringify(before[dispatchKey]);
 const canonicalPages=Object.values(run?.pages||{});
 const notSentIds=[...new Set(f.writes.flatMap(w=>(w.failureReasons||[]).filter(x=>x.reason==='not_sent').map(x=>x.id)))];
 const notices=f.insertions.filter(x=>x.message.type==='IMAGE_ERROR');
 const classified=f.events.filter(x=>x.name==='repairCheckpointFailed'&&x.value?.schema==='tp.checkpoint-failure/1');
 const checks=[
  ['fault injected through actual journal storage read',()=>assert.equal(readRejections,1)],
  ['durable source bytes unchanged',()=>assert.equal(sourcePreserved,true)],
  ['durable unknown dispatch bytes unchanged',()=>assert.equal(receiptPreserved,true)],
  ['no journal deletion',()=>assert.equal(f.removed.length,0)],
  ['unknown dispatch never converted to not_sent',()=>assert.deepEqual(notSentIds,[])],
  ['no repair API pages/seal/DELETE/replay',()=>assert.deepEqual(f.apiCalls,[])],
  ['no provider repair execution',()=>assert.equal(f.executes(),0)],
  ['runtime unavailable latch',()=>assert.equal(f.batch.repair.phase,'unavailable')],
  ['durable unavailable state',()=>assert.equal(run.phase,'unavailable')],
  ['visible generation-pinned error exactly once',()=>{assert.equal(notices.length,1);assert.deepEqual(clone(notices[0].message.generation),clone(a.ctx.generation));assert.equal(a.runtime.badges().length,1);assert.equal(notices[0].ack.ok,true);assert.notEqual(notices[0].ack.stale,true);}],
  ['journal read diagnostic has bounded schema and classification',()=>{
   assert.equal(classified.length,1);
   assert.deepEqual(classified[0].value,{schema:'tp.checkpoint-failure/1',
    scope:{runId:f.run.id,batchId:f.batch.id},code:'CHECKPOINT_READ_FAILED',stage:'journal_read',transferredPages:0});
  }],
  ['classified diagnostic excludes raw error source and credential',()=>{
   assert.equal(classified.length,1);
   const diagnostic=classified[0].value,serialized=JSON.stringify(diagnostic);
   assert.deepEqual(Object.keys(diagnostic).sort(),['schema','scope','code','stage','transferredPages'].sort());
   assert.deepEqual(Object.keys(diagnostic.scope).sort(),['runId','batchId'].sort());
   assert.equal(serialized.includes(syntheticSecret),false);
   assert.equal(serialized.includes(syntheticSource),false);
   assert.equal('message' in diagnostic,false);assert.equal('api_key' in diagnostic,false);
   assert.equal('sourceText' in diagnostic,false);
  }],
 ];
 const checkResults=[];for(const [name,check] of checks){try{check();checkResults.push({name,passed:true});}catch(e){checkResults.push({name,passed:false,message:e.message});}}
 observed.push({name:fault+(diagnosticSinkThrows?' throwing diagnostic sink':'')+' factual state',passed:checkResults.every(x=>x.passed),readRejections,sourcePreserved,receiptPreserved,
  deletedFamilies:f.removed.map(k=>k.split(':')[0]),notSentIds,apiActions:f.apiCalls.map(c=>({action:c.action,method:c.method})),providerCalls:f.executes(),
  runtimePhase:f.batch.repair.phase,durablePhase:run.phase,noticeCount:notices.length,visibleBadges:a.runtime.badges().length,
  diagnosticSinkThrows,classifiedDiagnostic:classified.map(x=>({schema:x.value.schema,code:x.value.code,
   stage:x.value.stage,transferredPages:x.value.transferredPages,scopePinned:x.value.scope.runId===f.run.id&&x.value.scope.batchId===f.batch.id})),
  sourceBeforeSha256:createHash('sha256').update(JSON.stringify(before[preparedKey])).digest('hex'),
  receiptBeforeSha256:createHash('sha256').update(JSON.stringify(before[dispatchKey])).digest('hex'),checkResults});
 const bad=checkResults.filter(x=>!x.passed);
 assert.equal(bad.length,0,bad.map(x=>x.name+': '+x.message).join('\n'));
 return {sourcePreserved,receiptPreserved,readRejections,runtimePhase:f.batch.repair.phase,providerCalls:f.executes()};
});
const afterHashes=await hashSource();const sourceUnchanged=JSON.stringify(beforeHashes)===JSON.stringify(afterHashes);
if(!sourceUnchanged)failures.push({name:'production source changed during fixture',message:'Production SHA256 snapshot differs.'});
const factual=observed.filter(x=>x.checkResults);
console.log(JSON.stringify({scope:'Actual coordinator/store/journals/result delivery/batch completion/content generation consumer; synthetic journal get(null) failure only. No live accounts/providers/charges.',
 source:root,passed:factual.filter(x=>x.passed).length,total:factual.length,sourceUnchanged,sourceHashes:afterHashes,
 observed:factual,failures,unhandled},null,2));
process.exitCode=failures.length||unhandled.length?1:0;
