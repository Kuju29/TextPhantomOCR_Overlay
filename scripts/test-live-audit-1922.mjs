// Production modules with synthetic DOM, storage and Provider I/O only.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
const messages=[];
globalThis.chrome={runtime:{sendMessage(_m,cb){cb?.();},get lastError(){return null;}},tabs:{sendMessage(_t,m,_o,cb){messages.push(m);cb?.({ok:true});}}};
const {ensureBatch,batchPassStats,batchProgressSnapshot,batchUpdateToast,updateImagePresentation,serializeBatchSnapshot,restoreBatchSnapshot,batchMark,markImagePhase}=await import('../src/background/batches.js');
const {createResultDelivery}=await import('../src/background/jobs/result-delivery.js');
const {createReadyQueue}=await import('../src/background/ai/translation-paths/ready-queue.js');
const {reserveConversationJob,finishConversationJob}=await import('../src/background/ai/translation-paths/order.js');
const {orderRepairUnits,prepareConversationRepairWire}=await import('../src/background/repair/conversation-repair-wire.js');
const results=[];
async function check(name,fn){await fn();results.push(name);console.log(`PASS ${name}`);}
const tick=()=>new Promise(r=>setTimeout(r,0));
function progressFixture(){
 const batch=ensureBatch(crypto.randomUUID(),17,0);batch.total1=26;
 for(let i=1;i<=26;i++)batch.items.set(`image-${i}`,{attempt:1,status:i===1?'done':'processing',phase:i===1?'done':'ai_generating',payload:{context:{page_index:i-1}}});
 updateImagePresentation(batch.id,'image-1',{insertionAck:{present:true,provisional:false,acknowledgedAt:Date.now()}});
 const jobs=new Map([2,3,4].map(i=>[`job-${i}`,{batchId:batch.id,tabId:17,frameId:0,imageKey:`image-${i}`,imgUrl:`https://fixture.invalid/${i}`,metadata:{image_id:`image-${i}`},settingsEpoch:7,sessionId:'session'}]));
 let epoch=7, session='session',reply={ok:true,applied:true,drawn:true};
 const acked=[];
 const delivery=createResultDelivery({pendingByJob:jobs,findContext:id=>jobs.get(id),getTabSessionId:()=>session,getSettingsEpoch:()=>epoch,ensureBatch,batchUpdateToast,updateImagePresentation,traceNote(){},workflow:{},log:{warn(){}},enqueueDomInsert:async(_tab,msg)=>{acked.push(msg.result.metadata.image_id);return typeof reply==='function'?await reply():reply;}});
 return {batch,jobs,acked,send:(i,state={complete:true})=>delivery.handleProvisionalResult(`job-${i}`,{metadata:{image_id:`image-${i}`}},state),setReply:v=>reply=v,setEpoch:v=>epoch=v,setSession:v=>session=v};
}
await check('ACK count is 3 while finished remains 1; only inserted is displayed and ownership stays live',async()=>{
 const f=progressFixture();await f.send(2);await f.send(3);batchUpdateToast(f.batch,'',true);
 const stats=batchPassStats(f.batch),snapshot=batchProgressSnapshot(f.batch);
 assert.equal(stats.inserted,3);assert.equal(stats.finished,1);assert.equal(f.jobs.size,3);
 assert.equal(f.batch.items.get('image-2').phase,'ai_generating');
 const code=await readFile(new URL('../src/content/progress-panel.js',import.meta.url),'utf8'),TP={};
 vm.runInNewContext(code.slice(0,code.indexOf('  function setCollapsed'))+'Object.assign(TP,{compactText,batchActive});})();',{window:{__TP:TP},Date,Map,Set,Object,Number,String,Math,Array,Boolean});
 const text=TP.compactText(snapshot);assert.match(text,/inserted 3\/26/);assert.doesNotMatch(text,/\bfinished\b/i);assert.equal(TP.batchActive(snapshot),true);
 const broadcast=messages.filter(m=>m.type==='BATCH_STATUS_UPDATE').at(-1);
 assert.match(broadcast.batch.message,/inserted 3\/26/);assert.doesNotMatch(broadcast.batch.message,/\bfinished\b/i);
 console.log(JSON.stringify({inserted:stats.inserted,finishedInternal:stats.finished,total:stats.total,text,backgroundMessage:broadcast.batch.message}));
});
await check('repeat ACK / final reuse cannot increment twice; saved count retained and a new attempt resets it',async()=>{
 const f=progressFixture();await f.send(2);await f.send(2);assert.equal(batchPassStats(f.batch).inserted,2);
 updateImagePresentation(f.batch.id,'image-2',{insertionAck:{present:true,provisional:false}});
 assert.equal(batchPassStats(f.batch).inserted,2);
 const restored=restoreBatchSnapshot(serializeBatchSnapshot(f.batch));assert.equal(batchPassStats(restored).inserted,2);
 batchMark(f.batch.id,'image-2',{status:'queued',attempt:2});
 assert.equal(f.batch.items.get('image-2').presentation?.insertionAck,null);
});
await check('actual final delivery reuses insertion count before slow receipt; duplicate final never repeats accounting',async()=>{
 const f=progressFixture(),ctx=f.jobs.get('job-2');ctx.mode='lens_text';ctx.source='ai';ctx.serverQueued=true;
 let release,receipts=0,inserts=0;const receipt=new Promise(r=>release=r);
 const no=()=>{};
 const delivery=createResultDelivery({pendingByJob:f.jobs,findContext:id=>f.jobs.get(id),getTabSessionId:()=> 'session',getSettingsEpoch:()=>7,
 ensureBatch,batchUpdateToast,updateImagePresentation,markImagePhase,removeJob:id=>f.jobs.delete(id),finalizeBatch:no,
 traceNote:no,log:{warn:no},workflow:{renderReady:async()=>{},applyRequested:async()=>{},applied:async()=>{},failed:async()=>{}},
 summarizeResultPresentation:()=>({hasHtml:true,newImg:null,skipReason:'',shouldShowSkipBadge:false}),
 enqueueDomInsert:async()=>{inserts++;return {ok:true,applied:true,drawn:true,reused:true};},
 accountingQueue:{enqueue:()=>{receipts++;return receipt;}},resolveSeriesKey:async()=>'',accumulateSeriesMemory:async()=>{},
 mdCacheKey:()=>'',mdKeyFromUrl:x=>x,normImgSrc:x=>x,setCachedDataUri:no,setCachedResult:no,stripImageFields:x=>x,
 classifyJobError:()=>({permanent:false}),evaluateTextNoOverlaySkippable:()=>false,imageErrorMessage:()=>({}),markDomainNeedsDataUri:no});
 await f.send(2);const final=delivery.handleResult('job-2',{metadata:{image_id:'image-2'}});await tick();
 assert.equal(batchPassStats(f.batch).inserted,2);assert.equal(batchPassStats(f.batch).finished,1);assert.ok(f.jobs.has('job-2'));
 await delivery.handleResult('job-2',{metadata:{image_id:'image-2'}});assert.equal(receipts,1);assert.equal(inserts,1);
 release();await final;assert.equal(batchPassStats(f.batch).inserted,2);assert.equal(batchPassStats(f.batch).finished,2);
 assert.equal(f.jobs.has('job-2'),false);
});
await check('badge-only invalidation clears applied count without ending stream/repair barrier',async()=>{
 const f=progressFixture();await f.send(2);f.setReply({ok:true,applied:true,drawn:false});
 await f.send(2,{invalidated:true,missing:['I2_P0']});
 assert.equal(batchPassStats(f.batch).inserted,1);assert.equal(batchPassStats(f.batch).finished,1);
 assert.equal(f.jobs.size,3);assert.equal(f.batch.items.get('image-2').progress.insert.state,'skipped');
});
await check('failed/stale ACK and settings or navigation during rendering never add an inserted image',async()=>{
 for(const why of ['reject','epoch','navigation','cancel']){
  const f=progressFixture();
  f.setReply(async()=>{if(why==='epoch')f.setEpoch(8);if(why==='navigation')f.setSession('new');if(why==='cancel')f.batch.cancelled=true;
   return why==='reject'?{ok:false,applied:false,stale:true}:{ok:true,applied:true,drawn:true};});
  if(why==='reject')await assert.rejects(f.send(2));else await f.send(2);
  assert.equal(batchPassStats(f.batch).inserted,1,why);assert.equal(batchPassStats(f.batch).finished,1);
 }
});
function page(i,doc,extra={}){const payload={source:'ai',lang:'th',context:{page_url:doc,tp_tab_session:'owner',page_index:i},metadata:{image_id:`${doc}-${i}`},ai:{provider:'huggingface',model:'fixture',api_key:'fixture-key',translation_mode:'conversation',thinking:'minimum',...extra}};reserveConversationJob(payload,17);return {payload,ai:payload.ai,imageId:payload.metadata.image_id,targetLang:'th',route:'api-cloud',sourceFingerprint:'a'.repeat(64)};}
const units=[{id:'P0',text:'source unit'}];
const billing=()=>Object.assign(new Error('Monthly included credits depleted'),{code:'billing_required',failureKind:'billing_required',requestDispatched:true,providerAttempts:1,generationAttempts:0,upstreamStatus:402,httpStatus:502,usage:{inputTokens:99},operationId:'original-operation'});
await check('billing failure stops queued and late-OCR reservations with no duplicated usage or attempts',async()=>{
 const pages=[0,1,2,3].map(i=>page(i,'billing-run'));let calls=0;
 const q=createReadyQueue({choose:async rows=>({units:rows.slice(0,1)}),dispatch:async()=>{calls++;throw billing();}});
 try{
  const out=await Promise.allSettled(pages.slice(0,3).map(p=>q.submit(units,p)));
  assert.equal(calls,1);assert.ok(out.every(o=>o.status==='rejected'));
  assert.equal(out[0].reason.providerAttempts,1);
  for(const row of out.slice(1)){assert.equal(row.reason.providerAttempts,0);assert.equal(row.reason.requestDispatched,false);assert.equal(row.reason.usage,undefined);assert.equal(row.reason.operationId,undefined);}
  await assert.rejects(q.submit(units,pages[3]),e=>e.code==='billing_required'&&e.providerAttempts===0);assert.equal(calls,1);
 }finally{pages.forEach(p=>finishConversationJob(p.payload));q.close();}
});
await check('billing fence covers reserved same-key documents/models, not another key/provider or fresh run',async()=>{
 const a=page(0,'scope-a'),b=page(0,'scope-a',{api_key:'different-fixture-key'}),c=page(0,'scope-c',{provider:'openrouter'}),late=page(0,'scope-late',{model:'other-model'});let calls=0;
 const q=createReadyQueue({choose:async rows=>({units:rows}),dispatch:async()=>{calls++;throw billing();}});
 try{await Promise.allSettled([a,b,c].map(p=>q.submit(units,p)));assert.equal(calls,3);
  await assert.rejects(q.submit(units,late),e=>e.providerAttempts===0);assert.equal(calls,3);finishConversationJob(late.payload);
  [a,b,c].forEach(p=>finishConversationJob(p.payload));await tick();
  const fresh=page(0,'scope-a');try{await assert.rejects(q.submit(units,fresh));assert.equal(calls,4);}finally{finishConversationJob(fresh.payload);}
 }finally{[a,b,c,late].forEach(p=>finishConversationJob(p.payload));q.close();}
});
await check('late billing error from a cancelled run cannot poison a new reservation with the same key',async()=>{
 const old=page(0,'restart-same-key');let release,entered=false;
 const hold=new Promise(r=>release=r);
 const q=createReadyQueue({choose:async rows=>({units:rows}),dispatch:async()=>{entered=true;await hold;throw billing();}});
 const pending=q.submit(units,old).catch(e=>e);
 while(!entered)await tick();
 finishConversationJob(old.payload);await pending;
 const fresh=page(0,'restart-same-key');release();await tick();await tick();let calls=0;
 const next=createReadyQueue({choose:async rows=>({units:rows}),dispatch:async()=>{calls++;throw Object.assign(new Error('request fixture'),{httpStatus:400,providerAttempts:1});}});
 try{await assert.rejects(next.submit(units,fresh),e=>e.providerAttempts===1);assert.equal(calls,1);}
 finally{finishConversationJob(fresh.payload);q.close();next.close();}
});
await check('fresh work submitted to the same queue while a cancelled billing reply is pending still dispatches',async()=>{
 const old=page(0,'reuse-live-queue');let release,calls=0;
 const hold=new Promise(r=>release=r);
 const q=createReadyQueue({choose:async rows=>({units:rows}),dispatch:async()=>{calls++;
   if(calls===1){await hold;throw billing();}
   throw Object.assign(new Error('new request reached Provider fixture'),{httpStatus:400,providerAttempts:1});}});
 const abandoned=q.submit(units,old).catch(e=>e);while(calls===0)await tick();
 finishConversationJob(old.payload);await abandoned;await tick();
 const fresh=page(0,'reuse-live-queue');const pending=q.submit(units,fresh).catch(e=>e);
 release();const result=await pending;
 assert.equal(calls,2);assert.equal(result.providerAttempts,1);assert.notEqual(result.schema,'tp.ai.result/1','unsent work must never falsely succeed');
 finishConversationJob(fresh.payload);q.close();
});
await check('ordinary request/429 failures are not mistaken for account billing failure',async()=>{
 for(const status of [400,429,502]){
  const pages=[0,1,2].map(i=>page(i,`not-billing-${status}`));let calls=0;
  const q=createReadyQueue({choose:async rows=>({units:rows.slice(0,1)}),dispatch:async()=>{calls++;throw Object.assign(new Error('fixture rejection'),{httpStatus:status,providerAttempts:1});}});
  try{await Promise.allSettled(pages.map(p=>q.submit(units,p)));assert.equal(calls,3);}finally{pages.forEach(p=>finishConversationJob(p.payload));q.close();}
 }
});
await check('repair ordering uses immutable original unit order, keeps IDs and source contexts through slicing',async()=>{
 const pages=new Map([26,13].map(n=>{const id=`p${n}`;return [id,{pageId:id,generationId:`gen-${n}`,ai:{conversation:{pageId:id,pageOrder:n,pageIndex:n-1}},units:Array.from({length:40},(_,i)=>({id:`g${i}`,text:`source ${n}.${i}`,sourceHash:'a'.repeat(64)}))}];}));
 const rows=[[26,38],[26,7],[13,11],[26,17],[26,10]].map(([n,i],k)=>({id:`R${k}`,pageId:`p${n}`,unitId:`g${i}`,generationId:`gen-${n}`,text:`source ${n}.${i}`,sourceHash:'a'.repeat(64)}));
 const original=JSON.stringify(rows),sorted=orderRepairUnits(pages,rows);
 assert.deepEqual(sorted.map(r=>r.id),['R2','R1','R4','R3','R0']);assert.equal(JSON.stringify(rows),original);
 const all=[];
 for(let i=0;i<sorted.length;i+=2){const wire=prepareConversationRepairWire(pages,sorted.slice(i,i+2),true);all.push(...wire.wireUnits.map(u=>u.id));
  assert.deepEqual(wire.wireUnits.map(u=>wire.wireToAlias.get(u.id)),sorted.slice(i,i+2).map(r=>r.id));}
 assert.deepEqual(all,['I13_P11','I26_P7','I26_P10','I26_P17','I26_P38']);
 const legacy=prepareConversationRepairWire(pages,rows,false);assert.deepEqual(legacy.wireUnits.map(r=>r.id),rows.map(r=>r.id));
 assert.throws(()=>prepareConversationRepairWire(pages,[{...rows[0],text:'wrong source'}],true),e=>e.code==='repair_source_evidence_conflict');
});
console.log(JSON.stringify({suite:'live-audit-1922',scenarios:results.length,passed:results.length,liveProviderCalls:0}));
