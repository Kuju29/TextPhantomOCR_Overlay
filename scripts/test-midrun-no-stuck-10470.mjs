// .70 evidence for the owner's question "no stuck jobs when the UI changes
// mid-translation". A run whose settings changed now takes the SAME terminal
// path as a run nobody touched. This drives the real ordering lanes, image
// claims and repair registration through overlapping old/new runs, with
// random delays and failures, and asserts nothing is left waiting or owned.
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
globalThis.crypto ||= webcrypto;
const noop=()=>{};
globalThis.chrome ||= {runtime:{lastError:null,sendMessage:async()=>({}),getURL:x=>x},
  tabs:{sendMessage:(_t,_m,_o,cb)=>{cb?.({ok:true});return Promise.resolve({ok:true});},get:async()=>({})},storage:{local:{get:async()=>({}),set:async()=>{}},
  session:{get:async()=>({}),set:async()=>{}},onChanged:{addListener:noop}},alarms:{create:noop,clear:async()=>true}};
const root=fileURLToPath(new URL('..',import.meta.url));
const from=p=>import(pathToFileURL(root+p));
const order=await from('src/background/ai/translation-paths/order.js');
const independent=await from('src/background/ai/translation-paths/independent-order.js');
const life=await from('src/background/jobs/lifecycle.js');
const {createRepairCoordinator}=await from('src/background/repair/coordinator.js');
const {ensureBatch,getBatch}=await from('src/background/batches.js');

let checks=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const within=(promise,ms,label)=>Promise.race([promise,
  sleep(ms).then(()=>{throw new Error(`STUCK: ${label} did not finish within ${ms} ms`);})]);
let rnd=Number(process.env.TP_SEED)||0x5eed;
const random=()=>((rnd=(rnd*1103515245+12345)>>>0)%1000)/1000;

function conversationPayload(batch,i,ai={}) {
  return {source:'ai',mode:'lens_text',lang:'th',src:`https://img.test/${i}.jpg`,
    context:{tp_tab_session:'tab-session-1',page_url:'https://site.test/chapter-1',page_index:i},
    metadata:{batch_id:batch,image_id:`${batch}-${i}`},
    ai:{provider:'paid',base_url:'https://api.test',model:'m1',api_key:'k',prompt:'P',thinking:'off',...ai}};
}
// One image job exactly as jobs.js enqueue() + processJob() own it.
function runJob(payload,events,{fail=false,cancelBeforeEnter=false}={}) {
  order.reserveConversationJob(payload,1);
  return new Promise(done=>{
    const scheduled=life.scheduleOwnedImageJob({
      identity:{batchId:payload.metadata.batch_id,imageKey:payload.src,sessionId:'tab-session-1',
        engine:'extension',settingsEpoch:life.getSettingsEpoch(),tabId:1},
      isAdmissible:()=>true,
      schedule:task=>setTimeout(task,Math.floor(random()*5)),
      work:async()=>{
        try {
          if(cancelBeforeEnter) return events.push(['skipped',payload.metadata.image_id]);
          await order.enterConversationJob(payload,null);
          events.push(['enter',payload.metadata.image_id]);
          await sleep(2+Math.floor(random()*12));
          if(fail) throw new Error('provider failed');
          events.push(['done',payload.metadata.image_id]);
        } catch(error){ events.push(['error',payload.metadata.image_id]); }
        finally { order.finishConversationJob(payload); done(); }
      },
      onRelease:()=>order.finishConversationJob(payload)});
    assert.equal(scheduled,true);
  });
}
const keyOf=payload=>order.conversationTicket(payload).key;

// 1. Model changed mid-run: different lane, the new run starts at once and
//    the old run still completes; no ticket, tail or claim is left behind.
{
  const events=[];
  const A=[0,1,2,3].map(i=>conversationPayload('A',i));
  const jobsA=A.map((p,i)=>runJob(p,events,{fail:i===1}));
  await sleep(3);
  life.bumpSettingsEpoch();
  const B=[0,1,2,3].map(i=>conversationPayload('B',i,{model:'m2'}));
  const jobsB=B.map(p=>runJob(p,events));
  const keyA=keyOf(A[3]),keyB=keyOf(B[3]);
  assert.notEqual(keyA,keyB);
  await within(Promise.all([...jobsA,...jobsB]),5000,'old and new runs after a model change');
  const firstB=events.findIndex(([e,id])=>e==='enter'&&id.startsWith('B'));
  const lastA=events.findLastIndex(([e,id])=>id.startsWith('A')&&e!=='enter');
  assert.ok(firstB<lastA,'the new run did not queue behind the old run');
  assert.equal(events.filter(([e])=>e!=='enter').length,8,'all 8 images reached a terminal state');
  assert.deepEqual([order.conversationTickets(keyA).length,order.conversationTickets(keyB).length],[0,0]);
  checks+=4;
}
// 2. A change outside the request (same lane key): the new run waits for the
//    old run's pages in order, then finishes. Waiting, never stuck; an old page
//    failing or skipped still lets the chain continue.
{
  const events=[];
  const A=[0,1,2].map(i=>conversationPayload('C',i,{model:'m3'}));
  const jobsA=A.map((p,i)=>runJob(p,events,{fail:i===0,cancelBeforeEnter:i===1}));
  life.bumpSettingsEpoch();
  const B=[0,1,2].map(i=>conversationPayload('D',i,{model:'m3'}));
  const jobsB=B.map(p=>runJob(p,events));
  const lane=keyOf(B[0]);
  assert.equal(keyOf(A[2]),lane);
  await within(Promise.all([...jobsA,...jobsB]),5000,'same-lane old and new runs');
  assert.equal(events.filter(([e])=>e!=='enter').length,6);
  const firstNew=events.findIndex(([e,id])=>e==='enter'&&id.startsWith('D'));
  const lastOld=events.findLastIndex(([e,id])=>id.startsWith('C')&&e!=='enter');
  assert.ok(firstNew>lastOld,'same lane keeps page order: new pages follow the old ones');
  assert.deepEqual(order.conversationTickets(lane),[]);
  checks+=4;
}
// 3. Image claims: old (epoch n) and new (epoch n+1) runs on the same image
//    both own a claim; every claim is released when its job ends.
{
  for(const batch of ['A','B','C','D'])for(const i of [0,1,2,3]){
    const claim=life.claimImageJob({batchId:batch,imageKey:`https://img.test/${i}.jpg`,sessionId:'tab-session-1',
      engine:'extension',settingsEpoch:life.getSettingsEpoch(),tabId:1});
    // The current epoch is free for A..D because their claims were released.
    assert.equal(claim.claimed,true,`claim ${batch}/${i} was released`);life.releaseImageJob(claim);
  }
  let released=0;
  life.scheduleOwnedImageJob({identity:{batchId:'E',imageKey:'x',sessionId:'s',settingsEpoch:life.getSettingsEpoch()},
    isAdmissible:()=>false,schedule:(task,{shouldStart})=>shouldStart(),work:async()=>{},onRelease:()=>released++});
  assert.equal(released,1,'a job refused at start releases its lane tickets');
  checks+=2;
}
// 4. Local Independent (story examples on): lanes are per run, so the new run
//    is not blocked by the old run's unfinished page.
{
  const local=(batch,i)=>({source:'ai',engine:'extension',mode:'lens_text',lang:'th',
    context:{tp_tab_session:'tab-session-1',page_url:'https://site.test/c',page_index:i},metadata:{batch_id:batch},
    ai:{translation_mode:'independent',provider:'ollama',base_url:'http://127.0.0.1:11434',model:'q',prompt:'P',style_examples:true}});
  const oldPage=local('L1',0),newPage=local('L2',0);
  independent.reserveLocalIndependentJob(oldPage,1);
  await independent.enterLocalIndependentJob(oldPage,null);
  life.bumpSettingsEpoch();
  independent.reserveLocalIndependentJob(newPage,1);
  await within(independent.enterLocalIndependentJob(newPage,null),500,'new Local run behind an unfinished old page');
  const keys=[oldPage,newPage].map(p=>independent.localIndependentTicket(p).key);
  independent.finishLocalIndependentJob(oldPage);independent.finishLocalIndependentJob(newPage);
  assert.deepEqual(keys.map(k=>independent.localIndependentTickets(k).length),[0,0],'Local tickets released');
  checks+=1;
}
// 5. Repair registration: after a settings change the old run stays live; a
//    new run on the SAME images supersedes (ends) it so two results never
//    fight over one image; a new run on other images leaves it running.
{
  const rows=new Map();
  const sessions={list:async()=>[...rows.values()],get:async id=>rows.get(id),
    update:async(id,fn)=>{const v=fn(rows.get(id));if(v)rows.set(id,v);return v;},remove:async id=>{rows.delete(id);}};
  const journal={clearRun:async()=>{}};
  const coordinator=createRepairCoordinator({sessions,api:async()=>({}),getBase:async()=>'https://api.test',
    currentSession:()=>'tab-session-1',emit:noop,dispatchJournal:journal,preparedPages:journal});
  const batch=(id,images)=>{const b=ensureBatch(id,7,0);for(const k of images)b.items.set(k,{status:'queued',phase:'queued'});return b;};
  const payloads=images=>images.map(src=>({engine:'extension',mode:'lens_text',source:'ai',src}));
  const one=['https://img.test/p1.jpg','https://img.test/p2.jpg'],other=['https://img.test/p9.jpg'];
  await coordinator.registerBatch(batch('R1',one),payloads(one));
  life.bumpSettingsEpoch();
  await coordinator.registerBatch(batch('R2',other),payloads(other));
  assert.equal(Boolean(getBatch('R1').cancelled),false,'other images: old run keeps running');
  await coordinator.registerBatch(batch('R3',one),payloads(one));
  assert.equal(getBatch('R1').cancelled,true,'same images: old run is superseded and ends');
  assert.ok([...getBatch('R1').items.values()].every(item=>item.status==='aborted'),'superseded images are terminal');
  checks+=3;
}
console.log(`PASS ${checks} no-stuck checks: old runs finish or are superseded; new runs never wait on a cancelled lane; every ticket and claim is released`);
process.exit(0);
