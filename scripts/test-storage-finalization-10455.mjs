// Read-only production integration: no OCR, provider request or charge.
// TP_PAID_SOURCE selects an immutable release; only session storage is fictional.
import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

globalThis.crypto ||= webcrypto;
const root=process.env.TP_PAID_SOURCE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleAt=rel=>import(pathToFileURL(path.join(root,rel)).href);
const [{createRepairCoordinator},{createTranslationSessionStore},{createPreparedPageJournal},
  {createDispatchJournal},{createResultDelivery},{imageErrorMessage},batches,
  {createBatchRetryCoordinator},{completeBatch}]=await Promise.all([
  moduleAt('src/background/repair/coordinator.js'),moduleAt('src/background/translation-session-store.js'),
  moduleAt('src/background/repair/prepared-page-journal.js'),moduleAt('src/background/repair/dispatch-journal.js'),
  moduleAt('src/background/jobs/result-delivery.js'),moduleAt('src/background/error-message.js'),
  moduleAt('src/background/batches.js'),moduleAt('src/background/jobs/batch-retry.js'),
  moduleAt('src/background/reader-placement.js'),
]);
const noop=()=>{},clone=structuredClone,tick=()=>new Promise(resolve=>setImmediate(resolve));
const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const observations=[],failures=[];

export async function imageRuntime(original){
  const badges=[];
  const element=(tag='div')=>({tagName:tag.toUpperCase(),dataset:{},
    style:{setProperty(key,value){this[key]=value;}},isConnected:false,
    setAttribute(key,value){this[key]=String(value);},removeAttribute(key){delete this[key];},
    addEventListener(){},remove(){this.isConnected=false;},
    getBoundingClientRect:()=>({left:12,top:18,width:300,height:500})});
  const image=element('img');image.src=image.currentSrc=original;image.isConnected=true;
  const body={appendChild(node){node.parentNode=body;node.isConnected=true;body.lastElementChild=node;badges.push(node);}};
  const document={images:[image],documentElement:{},body,createElement:element,
    addEventListener(){},getElementById:()=>null,
    querySelectorAll:selector=>selector==='[data-tp-image-error="1"]'?badges.filter(b=>b.isConnected):[]};
  const TP={bail:false,normUrl:value=>String(value||''),imageIdentity:value=>String(value||''),
    getBestImgUrl:img=>img.currentSrc||img.src,truncate:value=>String(value||''),
    log:{info(){},debug(){},warn(){}},clearToasts(){},clearImageStatuses(){},
    isMangaDexHost:()=>false,mdKeyFromUrl:()=>'',emitViewerEvent(){},showToast(){},
    dataUriToBlobUrl:async()=>null};
  const context=vm.createContext({window:{__TP:TP,scrollX:0,scrollY:0},document,
    Date,Math,Map,Set,WeakMap,Array,String,Number,crypto:webcrypto,
    setTimeout,clearTimeout,queueMicrotask});
  for(const rel of ['src/content/image-finder.js','src/content/target-key.js','src/content/overlay/message-controller.js']){
    vm.runInContext(await readFile(path.join(root,rel),'utf8'),context,{filename:rel});
  }
  return {TP,image,badges:()=>badges.filter(b=>b.isConnected)};
}

export async function fixture(quota){
  let stored={},quotaBytes=Infinity;const inserted=[],events=[],apiCalls=[],rejectedWrites=[];
  const area={
    get:async key=>key==null?clone(stored):({[key]:clone(stored[key])}),
    set:async patch=>{
      const next={...stored,...clone(patch)};
      if(size(next)>quotaBytes){
        rejectedWrites.push({keys:Object.keys(patch),before:size(stored),after:size(next),limit:quotaBytes});
        throw Object.assign(new Error('QUOTA_BYTES exceeded'),{code:'session_storage_quota'});
      }
      stored=next;
    },
    remove:async keys=>{for(const key of(Array.isArray(keys)?keys:[keys]))delete stored[key];},
  };
  const sessions=createTranslationSessionStore({area:()=>area});
  const preparedPages=createPreparedPageJournal({area:()=>area});
  const dispatchJournal=createDispatchJournal({area:()=>area});
  const batch=batches.ensureBatch(crypto.randomUUID(),70555,0),pageId='paid-page',jobId='paid-job';
  const payload={engine:'extension',mode:'lens_text',source:'ai',lang:'th',
    src:'https://fixture.invalid/paid-page.png',metadata:{image_id:pageId},
    ai:{provider:'paid',model:'synthetic/paid-model',translation_mode:'conversation',memory_mode:'off'}};
  const runtime=await imageRuntime(payload.src);
  batch.items.set(pageId,{attempt:1,status:'processing',phase:'ai_generating',payload,
    presentation:{repairPhase:'collecting'}});batch.total1=1;
  const ctx={jobId,batchId:batch.id,imageKey:pageId,tabId:70555,frameId:0,imgUrl:payload.src,
    sessionId:'fixture-tab',settingsEpoch:7,mode:'lens_text',source:'ai',aiGenerationAttempted:true,
    generation:runtime.TP.generationFor(runtime.image)};
  const coordinator=createRepairCoordinator({sessions,preparedPages,dispatchJournal,
    currentEpoch:()=>7,currentSession:()=> 'fixture-tab',getBase:async()=> 'http://fixture.invalid',
    getContext:()=>ctx,getCapabilitiesFor:async()=>({}),emit:(event,data)=>events.push({event,data}),
    api:async(_run,action)=>{apiCalls.push(action);return action==='seal'
      ?{phase:'done',tasks:[],results:[],unresolved:1}:{};},
    insert:async(_tab,message)=>{inserted.push(message);return runtime.TP.applyInsertMessage(message);},
    execute:async()=>{throw Error('Fixture must never generate or repair through a provider.');},
  });
  const run=await coordinator.registerBatch(batch,[payload]);assert(run);
  const doc={schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'en',target:'th'},
    paragraphs:[{id:'p0',sourceText:'Synthetic paid source dialogue',items:[]}]};
  const plan={route:'server',ai:payload.ai};
  await coordinator.capture(batch.id,{stage:'prepared',payload,
    result:{lensDocument:doc,eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}},plan,
    units:[{id:'g0',text:'Synthetic paid source dialogue',translatable:true,paragraphIds:['p0']}],jobId});
  await coordinator.capture(batch.id,{stage:'dispatch',payload,plan,jobId,
    ids:['g0'],operationId:'synthetic-paid-operation'});
  await coordinator.capture(batch.id,{stage:'finished',payload,plan,jobId,
    accepted:[],failures:[{id:'g0',reason:'missing'}]});
  assert.equal((await preparedPages.listRun(run.id)).length,1);
  assert.equal((await sessions.get(run.id)).phase,'collecting',
    'The fixture must reach a healthy pre-merge owner, not an earlier unavailable checkpoint.');
  assert.equal((await dispatchJournal.listRun(run.id)).length,1);
  const pending=new Map([[jobId,ctx]]);
  const retry=createBatchRetryCoordinator({batchPassStats:batches.batchPassStats,
    selectRetryCandidates:()=>({failed:[pageId],permanentErrors:0}),
    onComplete:(owner,label)=>completeBatch(owner,label,coordinator)});
  const delivery=createResultDelivery({pendingByJob:pending,getTabSessionId:()=> 'fixture-tab',
    getSettingsEpoch:()=>7,ensureBatch:()=>batch,classifyJobError:()=>({permanent:true}),imageErrorMessage,
    sendToTab:(_tab,message)=>{inserted.push(message);void runtime.TP.applyInsertMessage(message);},removeJob:id=>pending.delete(id),
    markImagePhase:batches.markImagePhase,batchUpdateToast:noop,
    finalizeBatch:retry.finalizeBatch,isUrlOnlyPayload:()=>false,log:{warn:noop},
    shouldDeferImageError:({batch,imageKey,terminalAiError})=>terminalAiError&&coordinator.ownsInitialFailure(batch.id,imageKey),
    accountingQueue:{enqueue:async()=>{},flush:async()=>{},describe:()=>({})}});
  // Initial generation has definitively failed; this is not an unknown wire
  // outcome and must never be resent automatically by the failure handler.
  inserted.length=0;apiCalls.length=0;
  if(quota)quotaBytes=size(stored); // All components share the browser's area quota.
  const unhandled=[];
  const onUnhandled=reason=>unhandled.push({name:reason?.name||'Error',code:reason?.code||'',message:String(reason?.message||reason)});
  process.on('unhandledRejection',onUnhandled);
  try{
    delivery.handleJobError(jobId,{code:'invalid_model_output',message:'Paid model returned no attributable translation',
      stage:'ai',generationAttempts:1,providerAttempts:1,requestDispatched:true});
    for(let n=0;n<40;n++)await tick();
    await sessions.flush();
    const saved=await sessions.get(run.id);
    const visibleBadges=runtime.badges();
    const observed={quota,noticeCount:inserted.filter(m=>m.type==='IMAGE_ERROR').length,
      visibleBadgeCount:visibleBadges.length,
      badgePositions:visibleBadges.map(b=>({left:b.style.left,top:b.style.top,text:b.textContent})),
      jobRemoved:!pending.has(jobId),storedPhase:saved.phase,batchRepairPhase:batch.repair?.phase,
      batchLifecycle:batch.lifecycle||'',deferredNotice:!!batch.items.get(pageId)?.deferredImageError,
      sourceCheckpointRetained:(await preparedPages.listRun(run.id)).length===1,
      apiCalls:[...apiCalls],rejectedWrites,unhandled:[...unhandled],
      mergeFailureEvent:events.some(e=>e.event==='repairLifecycle'&&e.data.reason==='repair_checkpoint_merge'&&e.data.persistence==='failed')};
    return observed;
  }finally{process.off('unhandledRejection',onUnhandled);}
}

if(path.resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)){
for(const quota of [false,true]){
  const observed=await fixture(quota);observations.push(observed);
  try{
    assert.equal(observed.noticeCount,1,'A known initial Paid failure must reach its saved current-generation image notice.');
    assert.equal(observed.visibleBadgeCount,1,'The real content consumer must show the image-corner error badge.');
    assert.deepEqual(observed.badgePositions.map(b=>[b.left,b.top]),[['16px','22px']]);
    assert.equal(observed.unhandled.length,0,'Finalization must own its storage failure; no detached rejection.');
    assert.equal(observed.deferredNotice,false,'The actual acknowledged notice must settle the saved error.');
    if(quota){assert(observed.sourceCheckpointRetained,'Failed transfer must retain original source authority.');
      assert.equal(observed.apiCalls.length,0,'Quota failure cannot dispatch a blind repair.');}
  }catch(error){failures.push({quota,message:error.message});}
}
console.log(JSON.stringify({scope:'Actual Paid generated-failure → result-delivery → fire-and-forget batch finalizer → repair coordinator; real shared session stores/journals, synthetic quota only',source:root,observations,failures},null,2));
process.exitCode=failures.length?1:0;
}
