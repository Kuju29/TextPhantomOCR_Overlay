/** Production ready-data queue and Local HTTP boundary. No real model. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {translationUnits} from '../src/shared/lens-document.js';
import {once} from 'node:events';
import {createReadyQueue} from '../src/background/ai/translation-paths/ready-queue.js';
import {reserveConversationJob,finishConversationJob,conversationTickets} from '../src/background/ai/translation-paths/order.js';
import {BUNDLED_CANONICAL_PROMPT_PLANS as plans} from '../src/generated/canonical-prompt-plans.js';
const store={};
globalThis.chrome={runtime:{getManifest:()=>({version:'2026.9.14.10'}),sendMessage:(_m,cb)=>cb?.({}),lastError:null},storage:{local:{
 get(keys,cb){const names=Array.isArray(keys)?keys:typeof keys==='object'&&keys?Object.keys(keys):[keys];const out=keys==null?structuredClone(store):Object.fromEntries(names.map(k=>[k,store[k]??(typeof keys==='object'&&!Array.isArray(keys)?keys[k]:undefined)]));cb?.(out);return Promise.resolve(out);},
 set(value,cb){Object.assign(store,structuredClone(value));cb?.();return Promise.resolve();}}}};
const tick=()=>new Promise(r=>setImmediate(r));
const until=async(fn)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Test did not reach expected boundary');};
let cases=0;
function page(id,doc='fixture-doc',extra={}){
 const payload={source:'ai',lang:'th',context:{page_url:doc,tp_tab_session:'private-owner',page_index:id},metadata:{image_id:`page-${id}`},
  ai:{provider:'ollama',model:'fixture',translation_mode:'conversation',thinking:'off',style_examples:true,...extra}};
 reserveConversationJob(payload,1);
 return {payload,ai:payload.ai,imageId:`page-${id}`,targetLang:'th',sourceLang:'en',route:'direct-local',sourceFingerprint:'a'.repeat(64)};
}
const units=(prefix,n=2)=>Array.from({length:n},(_,i)=>({id:`P${i}`,text:`${prefix} ${i}`}));
// Optional/malformed indices use a stable numeric reservation key, never a
// pairwise fallback comparator (which can create A<B<C<A cycles).
{
 const indices=[5,undefined,0,2,-1,1.5,10000000];
 const payloads=indices.map((index,i)=>({source:'ai',lang:'th',context:{page_url:'mixed-index-order',tp_tab_session:'private-owner',...(index===undefined?{}:{page_index:index})},metadata:{image_id:`mixed-${i}`},ai:{provider:'ollama',model:'fixture',translation_mode:'conversation'}}));
 const tickets=payloads.map(p=>reserveConversationJob(p,1));
 const expected=[3,2,4,1,5,6,7];
 assert.deepEqual(conversationTickets(tickets[0].key).map(t=>t.order),expected);
 const rank=t=>Number.isInteger(t.descriptor.pageIndex)&&t.descriptor.pageIndex>=0&&t.descriptor.pageIndex<10000000?t.descriptor.pageIndex:t.order;
 const ordered=conversationTickets(tickets[0].key);
 for(let i=0;i<ordered.length;i++)for(let j=i+1;j<ordered.length;j++)assert.ok(rank(ordered[i])<=rank(ordered[j]),'all pairs respect total numeric key');
 for(const p of payloads)finishConversationJob(p);cases+=2;
}
// Webpage order, aggregation, mapping, cancel projection, no artificial delay.
{
 let unblock,entered=false;const events=[],sent=[];
 const q=createReadyQueue({choose:async rows=>({units:rows.slice(0,32),splitReason:'ready_queue_drained',estimate:{estimatedInput:1000,predictedOutput:300}}),
  trace:v=>events.push(v),dispatch:async(us,o,p)=>{sent.push({us,p});if(sent.length===1){entered=true;await new Promise(r=>unblock=r);}
   return {translations:us.map(u=>({id:u.id,text:`แปล ${u.text}`})),missing:[],meta:{conversation:{historyTurns:sent.length-1,commitStatus:'pending_commit'}}};}});
 const ps=[0,1,2,3].map(i=>page(i,'queue-ready-arrival'));
 const a=q.submit(units('A'),ps[0]);await until(()=>entered);
 const c=q.submit(units('C'),ps[2]),d=q.submit(units('D'),ps[3]);
 unblock();await a;await tick();
 assert.equal(sent.length,1,'unready earlier page blocks later ready pages');
 const b=q.submit(units('B'),ps[1]);const [br,cr,dr]=await Promise.all([b,c,d]);
 assert.equal(sent.length,2);
 assert.deepEqual(sent[1].p.origins.map(p=>p.pageId),['page-1','page-2','page-3']);
 assert.deepEqual(cr.translations.map(t=>t.text),['แปล C 0','แปล C 1']);assert.deepEqual(dr.translations.map(t=>t.id),['P0','P1']);
 assert.equal(br.meta.usage,undefined,'shared full usage must not be copied to per-page accounting');
 assert.equal(new Set([cr,dr].map(r=>r.meta.sharedRequestRefs[0].operationId)).size,1);
 assert.ok(events.some(e=>e.pageCount===3&&e.providerRequestCount===1));for(const p of ps)finishConversationJob(p.payload);q.close();cases+=7;
}
// Later OCR completion waits for the earlier webpage reservation; both ready
// pages share a turn without waiting for the rest of the document.
{
 const sent=[];const q=createReadyQueue({choose:async rows=>({units:rows,splitReason:'ready_queue_drained',estimate:{estimatedInput:1000,predictedOutput:300}}),
  dispatch:async(us,o,p)=>{sent.push({ids:us.map(u=>u.id),origins:p.origins.map(x=>x.pageId)});return {translations:us.map(u=>({id:u.id,text:`แปล ${u.text}`})),missing:[],meta:{}};}});
 const p0=page(0,'first-ready-wins'),p1=page(1,'first-ready-wins');
 const later=q.submit(units('Second'),p1);await tick();
 assert.equal(sent.length,0,'later OCR completion must wait for webpage predecessor');
 const first=q.submit(units('First'),p0);
 const [r0,r1]=await Promise.all([first,later]);
 assert.equal(sent.length,1);
 assert.deepEqual(sent[0].origins,['page-0','page-1']);
 assert.equal(r0.translations.length,2);assert.equal(r1.translations.length,2);
 for(const p of [p0,p1])finishConversationJob(p.payload);q.close();cases+=4;
}
{
 let release;const controller=new AbortController(),live=new AbortController();let shared;
 const q=createReadyQueue({choose:async rows=>({units:rows,splitReason:'ready_queue_drained'}),dispatch:async(us,o,p)=>{
  shared=p.signal;await new Promise(r=>release=r);return {translations:us.map(u=>({id:u.id,text:'คำแปล'})),meta:{}};}});
 const p0=page(0,'cancel-one'),p1=page(1,'cancel-one');p0.signal=controller.signal;p1.signal=live.signal;
 const a=q.submit(units('A'),p0);a.catch(()=>{});const b=q.submit(units('B'),p1);await until(()=>release);
 controller.abort();assert.equal(shared.aborted,false,'one cancelled image must not abort the other image');release();
 await assert.rejects(a,{name:'AbortError'});assert.equal((await b).translations.length,2);
 for(const p of [p0,p1])finishConversationJob(p.payload);q.close();cases+=3;
}
{
 const calls=[];const q=createReadyQueue({choose:async rows=>({units:rows.slice(0,3),splitReason:'output_target'}),dispatch:async(us,o,p)=>{calls.push(p.origins);return {translations:us.filter(u=>u.id!=='I1_P1').map(u=>({id:u.id,text:'คำแปล'})),meta:{}};}});
 const p0=page(0,'split-and-partial'),p1=page(1,'split-and-partial');
 const [a,b]=await Promise.all([q.submit(units('Long',5),p0),q.submit(units('Next',2),p1)]);
 assert.equal(calls.length,3);assert.equal(calls[1].length,2,'remaining page units and next READY page can share one request');
 assert.deepEqual(a.missing,['P1']);assert.equal(b.missing.length,0);assert.equal(a.meta.sharedRequestRefs.length,2);
 for(const p of [p0,p1])finishConversationJob(p.payload);q.close();cases+=4;
}
// A structurally unusable first answer must never retry the whole anchor or
// cascade one page failure across every queued page. The page becomes missing
// and repair/future source may establish a fresh anchor without a loop.
{
 let calls=0;const sent=[];const q=createReadyQueue({choose:async rows=>({units:rows.slice(0,2),splitReason:'ready_queue_drained',estimate:{estimatedInput:1000,predictedOutput:300}}),dispatch:async us=>{
  calls++;sent.push(us.map(u=>u.id));
  return {translations:[],missing:us.map(u=>u.id),meta:{conversation:{historyTurns:0,commitStatus:'not_committed_invalid_output'}}};
 }});
 const p0=page(0,'anchor-no-loop');const r=await q.submit(units('Anchor'),p0);
 assert.equal(calls,1,'invalid anchor must not trigger an automatic whole-anchor retry');
 assert.deepEqual(r.missing,['P0','P1']);
 finishConversationJob(p0.payload);q.close();cases+=2;
}
// Cancellation of a queued reservation without a separate AbortSignal.
{
 let release;const sent=[];
 const q=createReadyQueue({choose:async rows=>({units:rows,splitReason:'ready_queue_drained'}),dispatch:async(us,o,p)=>{
  sent.push(us);if(sent.length===1)await new Promise(r=>release=r);return {translations:us.map(u=>({id:u.id,text:'คำแปล'})),meta:{}};}});
 const ps=[0,1,2].map(i=>page(i,'reservation-cancel'));
 const a=q.submit(units('First'),ps[0]);await until(()=>release);
 const b=q.submit(units('Cancelled'),ps[1]);b.catch(()=>{});const c=q.submit(units('Last'),ps[2]);
 finishConversationJob(ps[1].payload);await assert.rejects(b,{name:'AbortError'});
 release();await Promise.all([a,c]);assert.equal(sent.length,2);assert.equal(sent[1].length,2);
 for(const p of ps)finishConversationJob(p.payload);q.close();cases+=3;
}
// Terminal/no-text predecessors unblock immediately; unrelated documents proceed.
{
 const sent=[];const q=createReadyQueue({choose:async rows=>({units:rows,splitReason:'ready_queue_drained'}),
  dispatch:async(us,o,p)=>{sent.push({doc:o.payload.context.page_url,ids:us.map(u=>u.id)});return {translations:us.map(u=>({id:u.id,text:'แปล'})),meta:{}};}});
 const a=page(0,'empty-gate'),b=page(1,'empty-gate'),other=page(0,'unrelated-gate');
 const later=q.submit(units('Later'),b);await tick();assert.equal(sent.length,0);
 await q.submit(units('Other'),other);assert.equal(sent[0].doc,'unrelated-gate');
 const empty=await q.submit([],a);await later;
 assert.equal(empty.translations.length,0);assert.equal(sent.length,2);
 assert.deepEqual(sent[1].ids,['I2_P0','I2_P1']);
 for(const p of [a,b,other])finishConversationJob(p.payload);
 const c=page(0,'terminal-gate'),d=page(1,'terminal-gate');
 const last=q.submit(units('After failed OCR'),d);await tick();assert.equal(sent.length,2);
 finishConversationJob(c.payload);await last;assert.equal(sent.length,3);
 finishConversationJob(d.payload);q.close();cases+=7;
}
// A per-page post-dispatch checkpoint failure cannot replay the shared call.
{
 let calls=0;const q=createReadyQueue({choose:async rows=>({units:rows,splitReason:'ready_queue_drained'}),dispatch:async us=>{
  calls++;return {translations:us.map(u=>({id:u.id,text:'คำแปล'})),meta:{}};}});
 const a=page(0,'callback-failure'),b=page(1,'callback-failure');a.afterBatchResult=()=>{throw new Error('checkpoint fixture');};
 const [x,y]=await Promise.allSettled([q.submit(units('A'),a),q.submit(units('B'),b)]);
 assert.equal(x.status,'rejected');assert.equal(y.status,'fulfilled');assert.equal(calls,1);
 for(const p of [a,b])finishConversationJob(p.payload);q.close();cases+=3;
}
// Post-provider page projections must start together. Serial projection makes one
// chrome.storage.session round-trip per page and dominated 14.26 batch latency.
{
 let entered=0,releaseBoth;const bothEntered=new Promise(r=>releaseBoth=r);
 const q=createReadyQueue({choose:async rows=>({units:rows,splitReason:'ready_queue_drained'}),dispatch:async us=>({
  translations:us.map(u=>({id:u.id,text:'คำแปล'})),meta:{}
 })});
 const a=page(0,'parallel-projection'),b=page(1,'parallel-projection');
 const checkpoint=async()=>{entered++;if(entered===2)releaseBoth();await bothEntered;};
 a.afterBatchResult=checkpoint;b.afterBatchResult=checkpoint;
 const work=Promise.all([q.submit(units('A'),a),q.submit(units('B'),b)]);
 await Promise.race([bothEntered,new Promise((_,reject)=>setTimeout(()=>reject(new Error('page projections serialized')),250))]);
 await work;assert.equal(entered,2,'both page checkpoints start before either finishes');
 for(const p of [a,b])finishConversationJob(p.payload);q.close();cases+=2;
}
// API advertisement must survive the actual capability parser, not only fixtures.
{
 const fetch=globalThis.fetch;const {getCapabilities,forgetCapabilities}=await import('../src/background/capabilities.js');
 const {requireConversationApi}=await import('../src/shared/ai/conversation/support.js');
 try {
  const ai={translation_mode:'conversation',conversation:{origins:[{pageId:'p'}]}};
  globalThis.fetch=async()=>new Response(JSON.stringify({apiVersion:'2',features:{aiConversation:'tp.conversation/1',aiConversationBatch:'tp.conversation_batch/1'}}),{status:200,headers:{'Content-Type':'application/json'}});
  const caps=await getCapabilities('https://fixture.example',{forceRefresh:true});
  assert.equal(caps.aiConversationBatch,'tp.conversation_batch/1');assert.doesNotThrow(()=>requireConversationApi(ai,caps));
  globalThis.fetch=async()=>new Response(JSON.stringify({features:{aiConversation:'tp.conversation/1'}}),{status:200});
  const old=await getCapabilities('https://fixture.example',{forceRefresh:true});assert.throws(()=>requireConversationApi(ai,old),{code:'ai_conversation_unsupported'});
  cases+=3;
 } finally {globalThis.fetch=fetch;forgetCapabilities();}
}
// True production submit → learned planner → scheduler → Local route → HTTP →
// decoder → raw assistant history → ledger. Initial is held to accumulate ready data.
const sourceUnits=label=>translationUnits({paragraphs:[{id:'p0',sourceText:label+' first'},{id:'p1',sourceText:label+' second'}]});
const requests=[],traces=[];let firstRelease,firstOpened=false;
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const x of req)raw+=x;const b=JSON.parse(raw);requests.push(b);
 if(requests.length===1){firstOpened=true;await new Promise(r=>firstRelease=r);}
 const last=b.messages.at(-1).content;
 const ids=[...last.matchAll(/<<(?:TP_(P\d+)|(I[1-9][0-9]{0,6}_P[0-9]{1,6})):/g)].map(m=>m[1]||m[2]);assert.ok(ids.length,'actual current source must be identifiable');
 const text=ids.map((id,i)=>id.startsWith('I')?`<<${id}:คำแปล${i}>>`:`<<TP_${id}:คำแปล${i}>>`).join('\r\n')+'\n';
 res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({model:b.model,message:{role:'assistant',content:text},done:false})+'\n'+JSON.stringify({model:b.model,done:true,done_reason:'stop',prompt_eval_count:1000,eval_count:ids.length*20,total_duration:20000000})+'\n');
});server.listen(0,'127.0.0.1');await once(server,'listening');
try{
 const url=`http://127.0.0.1:${server.address().port}`;
 const {submitConversationPage}=await import('../src/background/ai/translation-paths/batch-dispatch.js');
 const extra={base_url:url,local_adapter:{protocol:'ollama',baseUrl:url},prompt:'',thinking:'off',style_examples:true,
  model_capabilities:{limits:{scope:'runtime',source:'ollama-api-show+ps',contextTokens:12288,runtimeContextTokens:12288,modelContextTokens:32768,maxOutputTokens:4096},reasoning:{supported:true,control:'boolean'},structuredOutput:{supported:true,contract:'tp.translation.schema-object/1',source:'fixture'}}};
 const ps=[0,1,2,3,4].map(i=>({...page(i,'production-batch',extra),base:'',capabilities:{},trace:(_e,v)=>traces.push(v)}));
 const a=submitConversationPage(sourceUnits('First'),ps[0]);await until(()=>firstOpened);
 const rest=ps.slice(1,4).map((p,i)=>submitConversationPage(sourceUnits('Next '+i),p));
 firstRelease();const results=await Promise.all([a,...rest]);
 assert.equal(requests.length,2,'four pages produce two actual requests, not warmup plus four requests');
 assert.ok(requests.every(r=>r.format==null),'Conversation image records stay marker-only even when structured output is supported');
 assert.deepEqual(requests[1].messages.map(m=>m.role),['system','user','assistant','user']);
 assert.deepEqual(requests[1].messages[0],requests[0].messages[0]);
 assert.ok(!requests[0].messages[1].content.includes('H01\nEN:'),'Conversation anchor must not inject Human Bootstrap Examples');
 const anchor=requests[0].messages[1].content;
 assert.ok(anchor.includes('tp.translation.image-records/1'),'Conversation Local anchor must advertise I#_P# protocol');
 assert.ok(!anchor.includes('แต่ละรายการเป็น <<TP_Pn:ข้อความต้นฉบับ>>'),'Conversation Local anchor must not advertise legacy TP_Pn input');
   assert.deepEqual(requests[1].messages[1],requests[0].messages[1]);
 assert.ok(!requests[1].messages.at(-1).content.includes('H01\nEN:'));
 assert.equal(requests[1].messages[2].content,'<<I1_P0:คำแปล0>>\r\n<<I1_P1:คำแปล1>>\n');
 assert.ok(!requests[1].messages.at(-1).content.includes('ขอบเขตภาพ'));
 assert.ok(requests[1].messages.at(-1).content.startsWith('<<I2_P0:'));
 assert.ok(!requests[1].messages.at(-1).content.includes('ข้อความต้นฉบับ'));
 assert.equal(requests[1].think,false);assert.ok(requests[1].options.num_ctx>=12288);
 assert.deepEqual(results[2].translations.map(t=>t.id),['g0','g1']);
 assert.equal(results[2].translations[0].text,'คำแปล2');
 assert.equal(results[3].translations[1].text,'คำแปล5');
 const tail=await submitConversationPage(sourceUnits('Last'),ps[4]);assert.equal(requests[2].messages.length,6);
 assert.equal(tail.meta.conversation.historyTurns,2);assert.equal(tail.meta.conversation.commitStatus,'committed');
 assert.equal(tail.meta.conversation.providerCacheStatus,'not_reported');
 assert.equal(traces.filter(x=>x.schema==='tp.conversation_batch/1'&&x.phase==='dispatch').length,3);
 const {AI_USAGE_STORAGE_KEY,currentUsage,flushUsageReceiptJournal}=await import('../src/shared/ai-usage.js');
   await flushUsageReceiptJournal({recover:true});
 const ledger=store[AI_USAGE_STORAGE_KEY];
 assert.ok(ledger,'transport persisted usage');
 const stats=currentUsage(ledger,{runtime:'local',provider:'ollama',model:'fixture'});
 assert.equal(stats.requests,3,'one ledger receipt per provider request, never per projected image');
 assert.equal(stats.totalTokens,3200,'1000 inputs per request + 10 units x20 outputs');
 console.log(JSON.stringify({fixture:'local-ready-production-http',requestUnits:[2,6,2],messageCounts:requests.map(r=>r.messages.length),requests:stats.requests,totalTokens:stats.totalTokens}));
 for(const p of ps)finishConversationJob(p.payload);cases+=15;
}finally{firstRelease?.();server.closeAllConnections();server.close();await once(server,'close');}
console.log(`PASS ${cases} ready queue/Local HTTP checks; private source ownership, cancellation, append, no warmup and once-only usage`);
