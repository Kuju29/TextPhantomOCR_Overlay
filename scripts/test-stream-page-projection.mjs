import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createReadyQueue} from '../src/background/ai/translation-paths/ready-queue.js';
import {createStreamRecords} from '../src/background/ai/translation-paths/stream-records.js';
import {reserveConversationJob,finishConversationJob} from '../src/background/ai/translation-paths/order.js';
import {translateLensPage} from '../src/background/pipeline/page-translation.js';
import {createResultDelivery} from '../src/background/jobs/result-delivery.js';
import {renderOverlay} from '../src/processors/render/renderer.js';
import {translationUnits} from '../src/shared/lens-document.js';
const tick=()=>new Promise(r=>setImmediate(r));
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await tick();}throw Error('Boundary not reached');};
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
const fixture=JSON.parse(await readFile(new URL('./fixtures/renderer-golden.json',import.meta.url),'utf8'));
function documentFor(count=1){const paragraphs=Array.from({length:count},(_,i)=>{const p=structuredClone(fixture.paragraphs[0]);delete p.aiText;p.id=`para${i}`;p.items=p.items.map(item=>({...item,baseline:item.baseline.map(([x,y])=>[x,y+i*0.03])}));return p});return {schema:'tp.lens-document/1',image:fixture.image,languages:fixture.languages,paragraphs,groups:[],uncoveredParagraphIds:[]};}
function element(tag){const node={tag,children:[],attrs:{},_classes:[],textContent:'',style:{cssText:''},set className(v){node._classes=String(v).split(/\s+/)},get className(){return node._classes.join(' ')},classList:{add:(...v)=>node._classes.push(...v)},appendChild(c){node.children.push(c);return c},setAttribute(k,v){node.attrs[k]=String(v)}};return node;}
const ownerDocument={createElement:element};
function renderedText(node){return [node.textContent,...node.children.map(renderedText)].join('');}
let checks=0;
// Split delimiters, missing close, duplicate and nested islands cannot count complete.
{
 const units=[{id:'I1_P0',text:'a'},{id:'I2_P0',text:'b'}],p=createStreamRecords(units);
 for(const ch of '<<I1_P0:แปลแล้ว>>')p.push(ch);
 assert.equal(p.accepted.get('I1_P0'),'แปลแล้ว');checks++;
 p.push('<<I2_P0:ไม่จบ');assert.equal(p.accepted.has('I2_P0'),false);checks++;
 const duplicate=createStreamRecords(units);duplicate.push('<<I1_P0:ดี>><<I1_P0:ซ้ำ>>');assert.equal(duplicate.accepted.has('I1_P0'),false);checks++;
 const cut=createStreamRecords(units);cut.push('<<I1_P0:ดี>><<I2_P0:ดีด้วย>><<I1_P0:ยังไม่จบ');cut.finish();assert.equal(cut.accepted.has('I1_P0'),false);assert.equal(cut.accepted.get('I2_P0'),'ดีด้วย');checks+=2;
 const nested=createStreamRecords(units);nested.push('<<I1_P0:ก่อน<<I2_P0:ซ้อน>>หลัง>>');assert.equal(nested.accepted.size,0);checks++;
}
async function scenario(kind){
 const contexts=new Map(),renders=[],badges=[],checkpoints=[],traces=[];
 const gate=deferred(),started=deferred(),images=new Map(),aborts=new Map();let providerCalls=0,terminal=false;
 const TP={traceNote:(_f,_n,d)=>traces.push(d),log:{info(){},warn(){}},isStillCurrent:()=>({ok:true}),findTargetImage:url=>images.get(url),isMangaDexHost:()=>false,
  markImageError:(url,message)=>badges.push({url,message}),
  applyHtmlOverlay:async(img,result,source)=>{const rendered=renderOverlay(result.lensDocument,{source,ownerDocument});assert.equal(rendered.report.error,undefined);renders.push({url:img.url,text:renderedText(rendered.root),result,terminal});return {};}};
 vm.runInNewContext(await readFile(new URL('../src/content/overlay/message-controller.js',import.meta.url),'utf8'),{window:{__TP:TP},setTimeout,Promise});
 let removed=0,finalized=0;
 const delivery=createResultDelivery({pendingByJob:contexts,findContext:id=>contexts.get(id),getTabSessionId:()=>kind,getSettingsEpoch:()=>0,ensureBatch:()=>null,
  enqueueDomInsert:async(_tab,msg)=>TP.applyInsertMessage(msg),removeJob:()=>removed++,finalizeBatch:()=>finalized++,
  traceNote:(_f,_n,data)=>traces.push(data),log:{warn(){}},workflow:{}});
 let streamOptions,selected;
 const queue=createReadyQueue({choose:async rows=>({units:rows,estimate:{},splitReason:'ready_queue_drained'}),dispatch:async(rows,_options,plan)=>{
  providerCalls++;selected=rows;streamOptions=plan;started.resolve();await gate.promise;
  terminal=true;
  if(['failure','open-duplicate'].includes(kind))throw Object.assign(new Error('stream disconnected'),{code:'provider_stream_incomplete',requestDispatched:true});
  return {translations:rows.filter((_,i)=>kind!=='missing'||i===0).map((u,i)=>({id:u.id,text:i===0?'คำแปลภาพแรก':'คำแปลภาพถัดไป'})),meta:{conversation:{commitStatus:'committed',historyTurns:1}}};
 }});
 const pages=[0,1].map(i=>{
  const id=`${kind}-${i}`,controller=new AbortController();aborts.set(id,controller);images.set(id,{url:id});
  const payload={source:'ai',lang:'th',context:{page_url:kind,tp_tab_session:kind,page_index:i},metadata:{image_id:id},ai:{provider:'ollama',model:'fixture',translation_mode:'conversation'}};
  reserveConversationJob(payload,1);
  const ctx={imgUrl:id,tabId:1,frameId:0,mode:'lens_text',source:'ai',sessionId:kind,settingsEpoch:0,metadata:payload.metadata};contexts.set(id,ctx);
  return {id,payload,result:{lensDocument:documentFor(kind==='ten-fifteen'?(i===0?10:15):1),eraseBoxes:[],metadata:payload.metadata},controller};
 });
 const run=p=>translateLensPage({base:'http://fixture',payload:p.payload,result:p.result,plan:{route:'direct-local',ai:p.payload.ai},jobId:p.id,signal:p.controller.signal,
  conversationSubmit:queue.submit,onCheckpoint:d=>checkpoints.push({id:p.id,...d}),
  onProvisionalResult:(result,state)=>delivery.handleProvisionalResult(p.id,result,state)});
 // B is prepared first, A's earlier reservation preserves source order and batches both.
 const b=run(pages[1]);b.catch(()=>{});await until(()=>checkpoints.some(c=>c.id===pages[1].id));await tick();await tick();
 const a=run(pages[0]);a.catch(()=>{});await started.promise;
 assert.equal(selected.length,kind==='ten-fifteen'?25:2);checks++;
 if(kind==='ten-fifteen'){
  for(const row of selected.slice(0,9))streamOptions.onProgress({state:'translation_delta',text:`<<${row.id}:คำแปลภาพแรก>>`});
  await tick();assert.equal(renders.length,0);checks++;
  streamOptions.onProgress({state:'translation_delta',text:`<<${selected[9].id}:คำแปลภาพแรก>>`});
  await until(()=>renders.length===1);assert.equal(renders[0].terminal,false);assert.equal(renders[0].url,pages[0].id);checks+=2;
  for(const row of selected.slice(10,24))streamOptions.onProgress({state:'translation_delta',text:`<<${row.id}:คำแปลภาพถัดไป>>`});
  await tick();assert.equal(renders.length,1);assert.equal(checkpoints.some(c=>c.stage==='finished'),false);checks+=2;
  streamOptions.onProgress({state:'translation_delta',text:`<<${selected[24].id}:คำแปลภาพถัดไป>>`});await until(()=>renders.length===2);
  assert.equal(renders[1].terminal,false);checks++;
  gate.resolve();await Promise.all([a,b]);assert.equal(providerCalls,1);checks++;
  queue.close();pages.forEach(p=>finishConversationJob(p.payload));return;
 }
 const emit=(id,text)=>streamOptions.onProgress({state:'translation_delta',text:`<<${id}:${text}>>`});
 emit(selected[0].id,kind==='wrong-language'?'原文です':'คำแปลภาพแรก');
 if(kind==='wrong-language'){
  await tick();await tick();assert.equal(renders.length,0);checks++;
 }else{
  await until(()=>renders.length===1);
  assert.equal(renders[0].terminal,false);assert.ok(renders[0].text.includes('คำแปลภาพแรก'));assert.equal(renders[0].url,pages[0].id);checks+=3;
  assert.equal(checkpoints.some(c=>c.stage==='finished'),false);assert.equal(removed+finalized,0);assert.equal(providerCalls,1);checks+=3;
 }
 if(kind==='duplicate'){
  emit(selected[0].id,'คำแปลซ้ำ');await until(()=>renders.length===2);
  assert.ok(!renders.at(-1).text.includes('คำแปลภาพแรก'));assert.equal(badges.length,1);checks+=2;
 }
 if(kind==='open-duplicate')streamOptions.onProgress({state:'translation_delta',text:`<<${selected[0].id}:ยังไม่จบ`});
 if(kind==='cancel'){
  pages[1].controller.abort();emit(selected[1].id,'คำแปลภาพถัดไป');await tick();assert.equal(renders.length,1);checks++;
 }else if(!['missing','failure','open-duplicate'].includes(kind))emit(selected[1].id,'คำแปลภาพถัดไป');
 gate.resolve();const results=await Promise.allSettled([a,b]);
 if(kind==='missing'){assert.equal(results[1].value.complete,false);assert.ok(checkpoints.find(c=>c.id===pages[1].id&&c.stage==='finished').failures.length);checks+=2;}
 if(kind==='duplicate'){assert.equal(results[0].value.complete,false);assert.ok(checkpoints.find(c=>c.id===pages[0].id&&c.stage==='finished').failures.length);checks+=2;}
 if(kind==='open-duplicate'){assert.equal(results[0].value.complete,false);assert.ok(!renders.at(-1).text.includes('คำแปลภาพแรก'));assert.ok(badges.length);checks+=3;}
 if(kind==='failure'){assert.equal(results[0].value.complete,true);assert.equal(pages[0].result.aiRoute.streamFailure.code,'provider_stream_incomplete');assert.ok(badges.length);checks+=3;}
 if(kind==='normal'){assert.equal(results[0].value.complete,true);assert.equal(results[1].value.complete,true);checks+=2;}
 if(kind==='normal'){
  const render=traces.find(d=>d.event==='page_stream_timing'&&d.renderFinishedAt);
  const ack=traces.find(d=>d.event==='page_stream_timing'&&d.domAckAt&&d.operationId===render?.operationId);
  assert.ok(render&&ack,'completion -> validation -> DOM -> ACK trace is present');checks++;
  assert.ok(render.recordsCompleteAt<=render.validatedAt&&render.validatedAt<=render.domEnqueuedAt&&
    render.domEnqueuedAt<=render.contentReceivedAt&&render.contentReceivedAt<=render.renderStartedAt&&
    render.renderStartedAt<=render.renderFinishedAt);checks++;
  assert.equal(ack.recordsCompleteAt,render.recordsCompleteAt);checks++;
  assert.equal(ack.completeToAckMs,ack.domAckAt-ack.recordsCompleteAt);checks++;
 }

 assert.equal(providerCalls,1);checks++;
 queue.close();for(const p of pages)finishConversationJob(p.payload);
}
for(const kind of ['normal','missing','duplicate','cancel','wrong-language','failure','open-duplicate','ten-fifteen'])await scenario(kind);
// A single page split across provider turns must not appear complete after turn one.
{
 const payload={source:'ai',lang:'th',context:{page_url:'split',tp_tab_session:'split',page_index:0},metadata:{image_id:'split'},ai:{provider:'ollama',model:'fixture',translation_mode:'conversation'}};
 reserveConversationJob(payload,1);const gates=[deferred(),deferred()],started=[deferred(),deferred()];let calls=0,projections=0;
 const q=createReadyQueue({choose:async rows=>({units:rows.slice(0,1),estimate:{}}),dispatch:async(rows,_o,p)=>{
  const i=calls++;p.onProgress({state:'translation_delta',text:`<<${rows[0].id}:แปลแล้ว>>`});started[i].resolve();await gates[i].promise;
  return {translations:[{id:rows[0].id,text:'แปลแล้ว'}],meta:{conversation:{commitStatus:'committed'}}};
 }});
 const pending=q.submit([{id:'a',text:'a'},{id:'b',text:'b'}],{payload,ai:payload.ai,imageId:'split',route:'direct-local',targetLang:'th',sourceFingerprint:'f'.repeat(64),onProvisionalResult:()=>projections++});
 await started[0].promise;await tick();assert.equal(projections,0);checks++;
 gates[0].resolve();await started[1].promise;await until(()=>projections===1);assert.equal(calls,2);checks++;
 gates[1].resolve();assert.equal((await pending).translations.length,2);checks++;q.close();finishConversationJob(payload);
}
// An image's slow DOM work must not block the next provider turn for another image.
{
 const renderGate=deferred(),firstGate=deferred(),firstStarted=deferred(),secondStarted=deferred();let calls=0;
 const ps=[0,1].map(i=>{const payload={source:'ai',lang:'th',context:{page_url:'slow-dom',tp_tab_session:'slow-dom',page_index:i},metadata:{image_id:`slow${i}`},ai:{provider:'ollama',model:'fixture',translation_mode:'conversation'}};reserveConversationJob(payload,1);return {payload,ai:payload.ai,imageId:`slow${i}`,route:'direct-local',targetLang:'th',sourceFingerprint:'f'.repeat(64),onProvisionalResult:async()=>{if(i===0)await renderGate.promise}}});
 const q=createReadyQueue({choose:async rows=>({units:rows.slice(0,1),estimate:{}}),dispatch:async(rows,_o,p)=>{
  const i=calls++;p.onProgress({state:'translation_delta',text:`<<${rows[0].id}:แปลแล้ว>>`});
  if(i===0){firstStarted.resolve();await firstGate.promise}else secondStarted.resolve();
  return {translations:[{id:rows[0].id,text:'แปลแล้ว'}],meta:{conversation:{commitStatus:'committed'}}};
 }});
 const a=q.submit([{id:'a',text:'a'}],ps[0]),b=q.submit([{id:'b',text:'b'}],ps[1]);
 await firstStarted.promise;await tick();firstGate.resolve();await secondStarted.promise;assert.equal(calls,2);checks++;
 renderGate.resolve();await Promise.all([a,b]);q.close();ps.forEach(p=>finishConversationJob(p.payload));
}
console.log(`PASS ${checks} stream projection checks: actual ready queue → page validation → delivery → content message → geometry renderer; blocked B, duplicate invalidation, missing repair, cancellation, target script, EOF survivors`);
