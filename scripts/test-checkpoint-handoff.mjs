import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
import {translateLensPage} from '../src/background/pipeline/page-translation.js';
import {createTranslationSessionStore,TRANSLATION_SESSION_KEY} from '../src/background/translation-session-store.js';
import {createRepairCoordinator} from '../src/background/repair/coordinator.js';
import {ensureBatch} from '../src/background/batches.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture({cancel=false,planningFailure=false}={}) {
 const id=crypto.randomUUID(),ac=new AbortController(),entered=deferred(),release=deferred();
 let saved={},writes=0,providerCalls=0,observations=0,nextCalls=0,epoch=7;
 const checkpoints=[],snapshots=[];
 const area={get:async key=>({[key]:structuredClone(saved[key])}),set:async patch=>{
  writes++;
  const page=Object.values(patch[TRANSLATION_SESSION_KEY].runs)[0]?.pages?.page;
  if(page?.accepted?.length===2 && page.inFlight?.length===2){entered.resolve();await release.promise;}
  saved=structuredClone(patch);
 }};
 const sessions=createTranslationSessionStore({area:()=>area});
 const batch=ensureBatch(id,777,0),payload={engine:'extension',mode:'lens_text',source:'ai',lang:'th',src:'http://fixture/page.png',metadata:{image_id:'page'},context:{}};
 batch.items.set('page',{attempt:1,status:'queued',phase:'waiting',payload});
 const ctx={jobId:'job',imageKey:'page',tabId:777,frameId:0,imgUrl:payload.src,mode:'lens_text',source:'ai',lang:'th',sessionId:'tab',settingsEpoch:7,generation:{pageInstanceId:'p'}};
 const coordinator=createRepairCoordinator({sessions,api:async()=>({}),getBase:async()=> 'http://fixture',currentEpoch:()=>epoch,currentSession:()=> 'tab',getContext:()=>ctx,insert:async()=>({ok:true}),emit:()=>{}});
 const run=await coordinator.registerBatch(batch,[payload]);await sessions.flush();writes=0;
 const units=Array.from({length:12},(_,i)=>({id:`g${i}`,text:'こんにちは',translatable:true,paragraphIds:[`p${i}`]}));
 const doc={schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'ja',target:'th'},paragraphs:units.map((u,i)=>({id:`p${i}`,sourceText:u.text,items:[]}))};
 const controller={open:async()=>({key:'f'.repeat(64),next(all,offset){
  nextCalls++;if(planningFailure&&nextCalls===2)throw Object.assign(Error('controlled planning failure'),{code:'ai_workload_budget_insufficient'});
  return {units:all.slice(offset,offset+2),splitReason:offset+2<all.length?'learned_output_target':'end_of_page',estimate:{predictedOutput:100,target:203,recordTarget:10,sourceChars:10,revision:2,samples:20,reasoningReserve:0,estimatedInput:500,completionAvailable:8192,limits:{source:'fixture'},planningContract:'json_schema_object_v1'}};
 },observe(){observations++;return {outcome:'ok'};},flush:async()=>{}})};
 const result={lensDocument:doc,eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}};
 const args={base:'http://fixture',payload,result,jobId:'job',cancelBatchId:id,signal:ac.signal,plan:{route:'direct-local',ai:{provider:'ollama',model:'fixture',prompt:'EXACT STYLE',thinking:'off'}},
 onCheckpoint:async data=>{checkpoints.push(structuredClone({stage:data.stage,nextDispatch:data.nextDispatch}));await coordinator.capture(id,data);},
 dependencies:{workloadController:controller,translationUnits:()=>units,requireAiLensDocument:r=>r.lensDocument,
 requireTranslationConservation:()=>({ok:true,eligibleParagraphCount:12,excludedBlankParagraphCount:0,unitCount:12}),
 translateUnits:async(selected,request)=>{
  providerCalls++;const recovered=await createTranslationSessionStore({area:()=>area}).get(run.id),page=recovered.pages.page;snapshots.push(page);
  assert.equal(page.accepted.length,(providerCalls-1)*2,'every previous answer durable before next provider');
  assert.deepEqual(page.inFlight,selected.map(u=>u.id));assert.equal(page.currentOperation,request.operationId);
  assert.equal(request.ai.prompt,'EXACT STYLE');
  return {translations:selected.map(u=>({id:u.id,text:'คำแปล'})),meta:{generationAttempts:1}};
 },diagnoseTargetScripts:()=>[],summarizeUnitScripts:()=>[],
 applyTranslations:(d,translations)=>({document:{...d,applied:translations},report:{translated:translations.length,missing:[],complete:true}}),
 classifyAiTranslationReport:r=>({usable:r.translated>0,complete:r.complete,translated:r.translated,missing:[]}),eraseBoxesForAiPartial:()=>({ok:true,eraseBoxes:[]})}};
 const pending=translateLensPage(args);
 if(planningFailure){await assert.rejects(pending,/controlled planning failure/);}
 else {
  await entered.promise;assert.equal(providerCalls,1,'next provider blocked on combined durable write');
  assert.equal(saved[TRANSLATION_SESSION_KEY].runs[run.id].pages.page.accepted.length,0,'uncommitted answer is not published');
  if(cancel)ac.abort();release.resolve();
  if(cancel)await assert.rejects(pending);else await pending;
 }
 const final=await sessions.get(run.id);
 if(cancel||planningFailure){assert.equal(providerCalls,1);assert.equal(final.pages.page.accepted.length,2,'completed answer survives cancellation/planning failure');}
 if(!cancel&&!planningFailure){
  assert.equal(providerCalls,6);assert.equal(observations,6);assert.equal(nextCalls,6);
  assert.equal(writes,9,'prepared + first dispatch + six progress + finished');
  assert.equal(checkpoints.filter(c=>c.stage==='dispatch').length,1);
  assert.equal(checkpoints.filter(c=>c.nextDispatch).length,5);
  assert.equal(final.pages.page.accepted.length,12);assert.equal(final.pages.page.phase,'finished');assert.deepEqual(final.pages.page.inFlight,[]);
  const before=structuredClone(final.pages.page);epoch++;
  await coordinator.capture(id,{stage:'dispatch',payload,ids:['stale'],operationId:'stale'});
  assert.deepEqual((await sessions.get(run.id)).pages.page,before,'stale epoch cannot update checkpoint');
 }
 if(planningFailure)assert.deepEqual(final.pages.page.inFlight,[]);
 return {writes,providerCalls};
}
await fixture();await fixture({cancel:true});await fixture({planningFailure:true});
console.log('PASS checkpoint handoff: six chunks use nine durable writes versus fourteen separate-transition writes. No provider passes blocked storage; restart snapshots conserve accepted/current operation; cancellation/planning failure/stale epoch verified.');
