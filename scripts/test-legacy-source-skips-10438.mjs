import assert from 'node:assert/strict';
import {createReadyQueue} from '../src/background/ai/translation-paths/ready-queue.js';
import {reserveConversationJob,finishConversationJob} from '../src/background/ai/translation-paths/order.js';
import {createTranslationService} from '../src/background/ai/translation-service.js';
import {buildPatchedResult,digestText} from '../src/background/repair/page-checkpoint.js';
import {repairValidation,executeRepairPool} from '../src/background/repair/executor.js';
import {createRepairCoordinator} from '../src/background/repair/coordinator.js';
import {createTranslationSessionStore} from '../src/background/translation-session-store.js';
import {ensureBatch} from '../src/background/batches.js';
const failures=[];
async function check(name,work){try{await work();console.log(`PASS ${name}`);}catch(error){failures.push(error);console.error(`FAIL ${name}: ${error.message}`);}}
await check('Legacy/raw Conversation noise is a source passthrough with zero calls/attempts',async()=>{
  let providerCalls=0,dispatches=0;
  const service=createTranslationService({server:async rows=>{providerCalls++;return {translations:rows.map(x=>({id:x.id,text:'คำแปล'})),missing:[],meta:{providerAttempts:1,generationAttempts:1}};}});
  const payload={source:'ai',lang:'th',context:{page_url:'legacy-source-skip',tp_tab_session:'fixture-owner'},metadata:{image_id:'legacy-noise'},ai:{provider:'login',translation_mode:'conversation'}};
  reserveConversationJob(payload,1);
  const queue=createReadyQueue({choose:async rows=>({units:rows,splitReason:'ready_queue_drained'}),dispatch:(rows,options,plan)=>{
    dispatches++;return service(rows,{...options,ai:{...options.ai,conversation:{...options.ai.conversation,origins:plan.origins}}});
  }});
  try{
    const result=await queue.submit([{id:'g4',text:'A',translatable:true}],{payload,ai:payload.ai,route:'server',imageId:'legacy-noise',targetLang:'th',sourceLang:'en'});
    assert.deepEqual(result.missing,[]);assert.deepEqual(result.translations,[{id:'g4',text:'A'}]);
    assert.deepEqual(result.meta.skippedUnitIds,['g4']);assert.equal(result.meta.generationAttempts,0);assert.equal(result.meta.providerAttempts,0);
    assert.equal(providerCalls,0);assert.equal(dispatches,0);
  }finally{finishConversationJob(payload);queue.close();}
});
const source={id:'g0',text:'A',translatable:true,paragraphIds:['p0'],sourceHash:await digestText('A')};
const doc={schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'en',target:'th'},paragraphs:[{id:'p0',sourceText:'A',items:[]}]};
const page={pageId:'legacy-page',generationId:'legacy-gen',groupKey:'a'.repeat(64),units:[source],accepted:[],failures:[{id:'g0',reason:'missing'}],repaired:[],
  result:{lensDocument:doc,eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}},originalEraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]},
  route:'direct-local',sourceLang:'en',targetLang:'th',ai:{provider:'ollama',model:'fixture',translation_mode:'independent',style_examples:false}};
await check('Legacy repair checkpoint no longer treats source-filtered text as a missing translation',async()=>{
  const patched=buildPatchedResult(page,[]);assert.deepEqual(patched.missing,[]);assert.equal(patched.result.lensDocument.paragraphs[0].aiText,'A');
});
await check('Repair validator verifies source skips and refuses a fabricated meaningful-source skip',async()=>{
  const units=[{id:'R0',text:'A'},{id:'R1',text:'Hello there'}];
  const validation=repairValidation({translations:[{id:'R0',text:'A'}],meta:{skippedUnitIds:['R0','R1','phantom']}},units,'th');
  assert.deepEqual(validation.skipped,['R0']);assert.deepEqual(validation.accepted,[]);
  for(const meta of [{skippedUnitIds:['R0'],alignmentUncertainIds:['R0']},{skippedUnitIds:['R0']}]){
    const quarantined=repairValidation({translations:meta.alignmentUncertainIds?[]:[{id:'R0',text:'A'},{id:'R0',text:'A'}],meta},units,'th');
    assert.deepEqual(quarantined.skipped,[]);assert.deepEqual(quarantined.accepted,[]);
  }
});
await check('Actual legacy repair consumer commits a scoped skip receipt without provider use or missing defects',async()=>{
  const row={id:'R0',pageId:page.pageId,unitId:'g0',text:'A',sourceHash:source.sourceHash,generationId:page.generationId,groupKey:page.groupKey,reason:'missing'};
  let snapshot={phase:'repairing',pending:[row],tasks:[],results:[],skipped:[],repaired:0,unresolved:0},calls=0,complete,applied,observations=0;
  const service=createTranslationService({directLocal:async()=>{calls++;throw Error('Noise reached provider');}});
  const api=async(_run,path='',body)=>{
    if(!path)return structuredClone(snapshot);
    if(path==='claim'){const task={id:body.taskId,state:'ready',route:'direct-local',ids:['R0'],units:[row]};snapshot.tasks=[task];snapshot.pending=[];return structuredClone(task);}
    if(path.endsWith('/start')){snapshot.tasks[0].state='running';return {dispatch:true};}
    if(path.endsWith('/complete')){complete=body;assert.deepEqual(body.answer.meta.skippedUnitIds,['R0']);assert.deepEqual(body.accepted,[]);
      snapshot={...snapshot,phase:'done',tasks:[{...snapshot.tasks[0],state:'done',answer:body.answer}],skipped:[{...row,state:'skipped'}],skippedUnits:1};return structuredClone(snapshot);}
    throw Error(`Unexpected ${path}`);
  };
  const result=await executeRepairPool({run:{id:'legacy-run',token:'b'.repeat(64)},snapshot,executor:'fixture',api,getPage:async()=>page,resolveAi:async()=>page.ai,
    withCapacity:async(_p,_a,_s,fn)=>fn(),checkpointTask:async()=>{},readTask:async()=>null,translate:service,onProgress:()=>{},
    applyResults:async rows=>{applied=rows;},planner:{open:async()=>({setRepairReason(){},next:rows=>({units:rows,estimate:{predictedOutput:64,reasoningReserve:0,estimatedInput:64,completionAvailable:1000}}),
      observe:({defects})=>{observations++;assert.deepEqual(defects.missing,[],'Deliberate skips must not train a capacity failure or open the repair circuit.');return {outcome:'ok'};}})}});
  assert.ok(complete);assert.equal(calls,0);assert.equal(complete.answer.meta.providerAttempts,0);assert.equal(complete.answer.meta.generationAttempts,0);
  assert.equal(result.unresolved,0);assert.equal(result.skippedUnits,1);assert.equal(applied[0].state,'skipped');
  assert.equal(observations,0,'No provider attempt means no capacity sample.');
});
await check('All-source-skipped Conversation still validates supplied ownership and mode',async()=>{
  const service=createTranslationService({server:async()=>{throw Error('Provider must not run');}});
  const source=[{id:'I1_P0',text:'A'}];
  const invalid={route:'server',ai:{translation_mode:'conversation',conversation:{origins:[{pageId:'p',pageOrder:1,unitIds:['I1_P1'],originalIds:['g0']}]}}};
  await assert.rejects(()=>service(source,invalid),error=>error.code==='ai_conversation_origin_invalid');
  await assert.rejects(()=>service(source,{route:'server',ai:{translation_mode:'invalid'}}),/Invalid translation mode/);
});
await check('Coordinator places owned terminal skips and reports zero repaired/unresolved translations',async()=>{
  const value={},area={get:async key=>key==null?structuredClone(value):{[key]:structuredClone(value[key])},set:async patch=>Object.assign(value,structuredClone(patch)),remove:async keys=>[].concat(keys).forEach(key=>delete value[key])};
  const sessions=createTranslationSessionStore({area:()=>area}),events=[],overlays=[];
  const batch=ensureBatch('legacy-skip-coordinator',97500,0),payload={engine:'extension',mode:'lens_text',source:'ai',lang:'th',src:'https://fixture.invalid/source-skip.png',metadata:{image_id:page.pageId}};
  batch.items.set(page.pageId,{attempt:1,status:'done',phase:'done',payload});
  const row={id:'R0',pageId:page.pageId,unitId:'g0',generationId:page.generationId,sourceHash:source.sourceHash,text:'A',state:'skipped'};
  const coordinator=createRepairCoordinator({sessions,currentEpoch:()=>7,currentSession:()=> 'fixture-session',getBase:async()=> 'http://fixture.invalid',
    preparedPages:{listRun:async()=>[],clearRun:async()=>{}},dispatchJournal:{listRun:async()=>[],clearRun:async()=>{}},
    getCapabilitiesFor:async()=>({}),readSettings:async()=>({}),emit:(name,data)=>events.push({name,data}),
    api:async(_run,path)=>path==='seal'?{phase:'repairing',pending:[row]}:{},
    insert:async(_tab,message)=>{if(message.type==='OVERLAY_HTML')overlays.push(message);return {ok:true,applied:true};},
    execute:async options=>{await options.applyResults([row]);return {phase:'done',repaired:0,unresolved:0,skippedUnits:1,initialAccepted:0,failedUnits:1,unverified:0,results:[],skipped:[row]};}
  });
  const run=await coordinator.registerBatch(batch,[payload]);assert.ok(run);
  await sessions.update(run.id,current=>({...current,pages:{[page.pageId]:{...structuredClone(page),delivered:true,phase:'finished',blocked:[],inFlight:[],
    ctx:{tabId:97500,frameId:0,imgUrl:payload.src,mode:'lens_text',source:'ai',sessionId:'fixture-session',settingsEpoch:7}}}}));
  await coordinator.finishInitial(batch);await sessions.flush();
  const saved=await sessions.get(run.id);assert.equal(saved.phase,'done');assert.equal(saved.summary.repaired,0);assert.equal(saved.summary.unresolved,0);assert.equal(saved.summary.skippedUnits,1);
  assert.equal(overlays.length,1);assert.equal(overlays[0].result.lensDocument.paragraphs[0].aiText,'A');assert.equal(overlays[0].result.aiRoute.translated,0);assert.equal(overlays[0].result.aiRoute.contentRepairAttempts,0);
  const patch=events.find(e=>e.name==='repairPatch');assert.equal(patch.data.fixedUnits,0);assert.equal(patch.data.skippedUnits,1);
  const final=events.findLast(e=>e.name==='repairProgress'&&e.data.phase==='done');assert.equal(final.data.counts.skippedUnits,1);assert.equal(final.data.outcome,'succeeded');
});
if(failures.length)throw new AggregateError(failures,'Legacy source-skip consumer regressions failed.');
console.log('PASS legacy queue, checkpoint, scoped repair receipt and apply boundary.');
