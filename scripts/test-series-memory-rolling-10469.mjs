/** .69 owner rule: Local Independent cannot see earlier requests, so every
 * request carries Series memory read at planning time: prior chapters plus this
 * chapter's accepted summaries so far. Memory changes never split ready pages. */
import assert from 'node:assert/strict';

let disk = {};
globalThis.chrome = {runtime:{lastError:null,getManifest:()=>({version:'2026.10.4.69'}),sendMessage:(_m,cb)=>cb?.({})},
  storage:{local:{get(keys,cb){const out=keys==null?structuredClone(disk):Object.fromEntries([].concat(keys).map(k=>[k,structuredClone(disk[k])]));cb?.(out);return Promise.resolve(out);},
    set(patch,cb){Object.assign(disk,structuredClone(patch));cb?.();return Promise.resolve();}}}};
const {getSeriesMemory,accumulateSeriesMemory,independentPromptMemory}=await import('../src/background/series-memory.js');
const {createReadyQueue}=await import('../src/background/ai/translation-paths/ready-queue.js');
const {planIndependentReady}=await import('../src/background/ai/translation-paths/batch-dispatch.js');
const {createWorkloadController}=await import('../src/background/ai/workload-controller.js');
const {reserveLocalIndependentJob,finishLocalIndependentJob,localIndependentTicket,localIndependentTickets,
  onLocalIndependentReady}=await import('../src/background/ai/translation-paths/independent-order.js');
let checks=0;

const key='reader.test/manga/alpha',one='https://reader.test/manga/alpha/chapter-1',two='https://reader.test/manga/alpha/chapter-2';
const result=(text,index)=>({Ai:{meta:{pageIndex:index,seriesSummaryRecords:[{text,sourceIds:['P0']}]}}});
await accumulateSeriesMemory(key,result('ตอนหนึ่ง: พระเอกย้ายบ้าน',0),'th',one);
// Chapter 2, first request summarised.
await accumulateSeriesMemory(key,result('ตอนสอง ช่วงแรก: นางเอกมาพัก',0),'th',two);
const payload=(index,url=two)=>({lang:'th',context:{series_key:key,page_url:url,page_index:index,batch_id:'run'},metadata:{batch_id:'run'}});

// Conversation and other callers keep prior chapters only.
assert.equal((await getSeriesMemory(key,'th',two)).state,'ตอนหนึ่ง: พระเอกย้ายบ้าน');checks++;
// Local Independent: prior chapters + this chapter so far, in order.
const memory=await independentPromptMemory(payload(3),'full');
assert.equal(memory.series_state,'ตอนหนึ่ง: พระเอกย้ายบ้าน\nตอนสอง ช่วงแรก: นางเอกมาพัก');checks++;
// It keeps rolling: the next request's summary is attached to the request after it.
await accumulateSeriesMemory(key,result('ตอนสอง ช่วงกลาง: ทะเลาะกัน',4),'th',two);
assert.ok((await independentPromptMemory(payload(8),'full')).series_state.endsWith('ทะเลาะกัน'));checks++;
// Bounded to 1,200 characters, newest kept.
for(let i=0;i<30;i++) await accumulateSeriesMemory(key,result(`สรุปยาว ${i} `+'ก'.repeat(80),10+i),'th',two);
const long=(await independentPromptMemory(payload(50),'full')).series_state;
assert.ok([...long].length<=1200 && long.includes('สรุปยาว 29'));checks++;
// Terms mode: glossary only, no summary; Off: nothing.
assert.equal((await independentPromptMemory(payload(3),'terms')).series_state,'');
assert.deepEqual(await independentPromptMemory(payload(3),'off'),{});checks+=2;

// Planning reads memory per request (not the snapshot from when the page was queued).
{
  const controller=createWorkloadController({read:async()=>({}),write:async()=>{},emit:()=>{}});
  const ai={provider:'ollama',base_url:'http://127.0.0.1:11434',model:'fixture',translation_mode:'independent',memory_mode:'full',
    series_state:'STALE',thinking:'off',model_capabilities:{reasoning:{supported:false},limits:{contextTokens:32768,source:'runtime',scope:'runtime'}}};
  const rows=[{id:'I1_P0',text:'Hello there'}];
  const plan=await planIndependentReady(rows,{ai,route:'direct-local',sourceLang:'en',targetLang:'th',payload:payload(3),conversationPageSizes:[1]},
    {refresh:async v=>v,open:controller.open});
  assert.equal(plan.session.ai.series_state,(await independentPromptMemory(payload(3),'full')).series_state);
  assert.ok(!plan.session.ai.series_state.includes('STALE'));checks++;
  await plan.session.flush?.();
}

// Memory that differs between pages (previous-page context, newer summary) no
// longer splits ready pages into separate requests.
{
  const sent=[];let release,entered=false;
  const q=createReadyQueue({mode:'independent',ordering:{ticketFor:localIndependentTicket,list:localIndependentTickets,onReady:onLocalIndependentReady},
    choose:async rows=>({units:rows,splitReason:'ready_queue_drained',estimate:{estimatedInput:1,predictedOutput:1},pageCount:1}),
    dispatch:async(us,o,p)=>{sent.push(p.origins.map(x=>x.pageId));if(sent.length===1){entered=true;await new Promise(r=>release=r);}
      return {translations:us.map(u=>({id:u.id,text:'แปล'})),missing:[],meta:{}};}});
  const page=i=>{const p={source:'ai',lang:'th',context:{page_url:two,tp_tab_session:'tab',page_index:i,series_key:key},metadata:{image_id:`p${i}`,batch_id:'mem-run'},
    engine:'extension',ai:{provider:'ollama',base_url:'http://127.0.0.1:11434',model:'fixture',translation_mode:'independent',memory_mode:'full',series_state:'S'+i,prev_context:[{src:'x'+i,tgt:'y'+i}],glossary:[{src:'g'+i,tgt:'h'}]}};
    reserveLocalIndependentJob(p,1);return {payload:p,ai:p.ai,imageId:`p${i}`,targetLang:'th',sourceLang:'en',route:'direct-local',batchId:'mem-run'};};
  const ps=[0,1,2,3].map(page);
  const first=q.submit([{id:'a',text:'Where did you go yesterday?'}],ps[0]);
  for(let i=0;i<100&&!entered;i++)await new Promise(r=>setTimeout(r,5));
  const rest=[1,2,3].map(i=>q.submit([{id:'a',text:'I went to the old market '+i}],ps[i]));
  release();await first;await Promise.all(rest);
  assert.deepEqual(sent,[['p0'],['p1','p2','p3']],'different memory, same request');checks++;
  for(const p of ps)finishLocalIndependentJob(p.payload);q.close();
}
console.log(`PASS ${checks} rolling Series memory checks: prior + current chapter per Independent request, newest kept, terms/off, planning-time read, memory never splits ready pages`);
