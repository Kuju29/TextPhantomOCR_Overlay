import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
const {createTranslationSessionStore,sessionSafe}=await import('../src/background/translation-session-store.js');
const {normalizeModelCapabilities}=await import('../src/shared/model-capabilities.js');
const {translationSettingsChanged}=await import('../src/background/translation-settings.js');
const {createAiProfiles,updateAiProfile}=await import('../src/shared/ai-profiles.js');
const {executeRepairPool,acceptedRepairIds}=await import('../src/background/repair/executor.js');
const {createWorkloadController}=await import('../src/background/ai/workload-controller.js');
const {createRepairCoordinator}=await import('../src/background/repair/coordinator.js');
const {ensureBatch}=await import('../src/background/batches.js');
const {translationUnits}=await import('../src/shared/lens-document.js');
const {buildPatchedResult,makePageCheckpoint}=await import('../src/background/repair/page-checkpoint.js');
const {translateLensPage}=await import('../src/background/pipeline/page-translation.js');

let checks=0;
function memory(){let value={};return {async get(k){return {[k]:structuredClone(value[k])}},async set(v){Object.assign(value,structuredClone(v))}}}
{
 const area=memory(),store=createTranslationSessionStore({area:()=>area});
 await store.update('r',()=>({createdAt:Date.now(),phase:'collecting',count:0,ai:{api_key:'SECRET',prompt:'STYLE'}}));
 await Promise.all(Array.from({length:40},()=>store.update('r',r=>({...r,count:r.count+1}))));
 assert.equal((await store.get('r')).count,40);assert.doesNotMatch(JSON.stringify(await store.get('r')),/SECRET/);
 assert.equal((await createTranslationSessionStore({area:()=>area}).get('r')).count,40);
 assert.equal((await createTranslationSessionStore({area:()=>memory()}).list()).length,0);
 const tiny=createTranslationSessionStore({area:()=>memory(),maxBytes:100});
 await assert.rejects(tiny.update('r',()=>({text:'x'.repeat(1000)})),e=>e.code==='session_checkpoint_limit');
 assert.equal(await tiny.get('r'),null);
 await assert.rejects(createTranslationSessionStore({area:()=>null}).list(),e=>e.code==='session_storage_unavailable');
 assert.deepEqual(sessionSafe({images:['xxx'],apiKey:'abc',nested:{authorization:'SECRET',safe:1}}),{nested:{safe:1}});checks+=7;
}
{
 const caps={structured_output:{supported:true,source:'catalog'},reasoning:{supported:false},limits:{contextTokens:8192},ignored:'dynamic'};
 const normalized=normalizeModelCapabilities(caps);
 assert.equal(normalized.structured_output.supported,true);assert.deepEqual(normalizeModelCapabilities(normalized),normalized);
 const defaults={thinking:'off',tokenPolicy:{mode:'dynamic',maxOutputTokens:0},temperature:0.2,pageImage:'off',memoryMode:'off',concurrency:{mode:'auto',max:0},providerOptions:{}};
 const before=updateAiProfile(createAiProfiles(),{provider:'openrouter',endpoint:'https://openrouter.ai/api/v1',model:'test',defaults,patch:{},select:true,now:1});
 // Some profile APIs return state directly, follow the actual contract.
 assert.ok(before);
 const changed=structuredClone(before);const active=changed.active;
 changed.providers[active.providerIdentity].models[active.model].profile.providerOptions.modelCapabilities=normalized;
 changed.providers[active.providerIdentity].updatedAt=999;
 assert.equal(translationSettingsChanged({aiProfilesV1:{oldValue:before,newValue:changed}},'local'),false);
 changed.providers[active.providerIdentity].models[active.model].profile.temperature=0.9;
 assert.equal(translationSettingsChanged({aiProfilesV1:{oldValue:before,newValue:changed}},'local'),true);
 assert.equal(translationSettingsChanged({lang:{oldValue:'th',newValue:'en'}},'session'),false);
 assert.equal(translationSettingsChanged({lang:{oldValue:'th',newValue:'en'}},'local'),true);checks+=6;
}
function bridge(){
 const child=spawn('python',['-u','scripts/repair-ledger-fixture.py'],{cwd:new URL('..',import.meta.url),stdio:['pipe','pipe','inherit']});
 const queue=[];createInterface({input:child.stdout}).on('line',line=>{const p=queue.shift();const out=JSON.parse(line);out.ok?p.resolve(out.value):p.reject(Object.assign(new Error(out.code),out));});
 return {api(run,action='',body,options={}){return new Promise((resolve,reject)=>{queue.push({resolve,reject});child.stdin.write(JSON.stringify({run,action:options.method==='DELETE'?'delete':action,body})+'\n');});},close(){child.stdin.end()}};
}
function doc(count=3){return {schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'ja',target:'th'},paragraphs:Array.from({length:count},(_,i)=>({id:`p${i}`,sourceText:`こんにちは、続けてください ${i}`,items:[]}))};}
function erase(count=3){return {schema:'tp.erase-boxes/1',boxes:Array.from({length:count},(_,i)=>({l:0.1,t:0.1+i*0.1,w:0.2,h:0.1,p:`p${i}`}))};}
{
 const d=doc(); const page=await makePageCheckpoint({payload:{metadata:{image_id:'p'},lang:'th'},result:{lensDocument:d,eraseBoxes:erase()},plan:{route:'server',ai:{}},units:translationUnits(d),ctx:{jobId:'gen'},operationId:'op'});
 page.accepted=[{id:'g0',text:'ของดีเดิม'}];
 const repaired=[{id:'R0',unitId:'g1',translation:'ซ่อมแล้ว',sourceHash:page.units[1].sourceHash,generationId:'gen'},
 {id:'R1',unitId:'g0',translation:'อย่าทับ',sourceHash:page.units[0].sourceHash,generationId:'gen'},
 {id:'R2',unitId:'g2',translation:'ผิดรุ่น',sourceHash:page.units[2].sourceHash,generationId:'old'}];
 const patch=buildPatchedResult(page,repaired);
 assert.equal(patch.result.lensDocument.paragraphs[0].aiText,'ของดีเดิม');assert.equal(patch.result.lensDocument.paragraphs[1].aiText,'ซ่อมแล้ว');
 assert.deepEqual(patch.missing,['g2']);assert.deepEqual(patch.result.eraseBoxes.boxes.map(x=>x.p),['p0','p1']);checks+=4;
}
{
 const b=bridge();try{
  // Real executor + source-character planner + real SQLite state. 32 pages, 20 failed.
  const run={id:'executor',token:'a'.repeat(64)};await b.api(run,'register',{manifest:Array.from({length:32},(_,i)=>`p${i}`)});
  const ai={provider:'ollama',model:'fixture',prompt:'KEEP STYLE',thinking:'off'};
  const pages=new Map();
  for(let i=0;i<32;i++){
   const p=await makePageCheckpoint({payload:{metadata:{image_id:`p${i}`},lang:'th'},result:{lensDocument:doc(),eraseBoxes:erase()},plan:{route:'direct-local',ai},units:translationUnits(doc()),ctx:{jobId:`g${i}`},operationId:`op${i}`});pages.set(p.pageId,p);
   await b.api(run,'pages',{pageId:p.pageId,generationId:p.generationId,groupKey:p.groupKey,status:'finished',initialAccepted:i<16?3:2,
    failed:i<20?[{id:'g0',text:p.units[0].text,sourceHash:p.units[0].sourceHash,reason:'wrong_language'}]:[]});
  }
  const snapshot=await b.api(run,'seal',{});const calls=[],checkpoints={};
  const end=await executeRepairPool({run,snapshot,executor:'w',signal:new AbortController().signal,api:b.api,
   getPage:async id=>pages.get(id),resolveAi:async p=>p.ai,checkpointTask:async t=>checkpoints[t.id]={...checkpoints[t.id],...t},
   onProgress:()=>{},applyResults:async()=>{},withCapacity:async(_p,_a,_s,f)=>f(),
   planner:createWorkloadController({read:async()=>({}),write:async()=>{}}),
   translate:async (units,options)=>{calls.push(units);assert.equal(options.ai.prompt,'KEEP STYLE');return {translations:units.map(u=>({id:u.id,text:'สวัสดี'})),meta:{generationAttempts:1}}}});
  assert.equal(end.phase,'done');assert.equal(end.repaired,20);assert.equal(end.initialAccepted,80);
  assert.ok(calls.length>1);assert.equal(calls.flat().length,20);assert.equal(new Set(calls.flat().map(u=>u.id)).size,20);
  console.log('Real planner repair batches:',calls.map(x=>x.length));checks+=6;
 }finally{b.close()}
}
{
 const b=bridge();try{
  const run={id:'local-recovery',token:'a'.repeat(64)};
  await b.api(run,'register',{manifest:['p']});
  const p=await makePageCheckpoint({payload:{metadata:{image_id:'p'},lang:'th'},result:{lensDocument:doc(),eraseBoxes:erase()},plan:{route:'direct-local',ai:{}},units:translationUnits(doc()),ctx:{jobId:'gen'},operationId:'op'});
  await b.api(run,'pages',{pageId:'p',generationId:'gen',groupKey:p.groupKey,status:'finished',failed:[{id:'g0',text:p.units[0].text,sourceHash:p.units[0].sourceHash}]});
  await b.api(run,'seal',{});await b.api(run,'claim',{taskId:'t',executor:'old',route:'direct-local',ids:['R0']});await b.api(run,'tasks/t/start',{executor:'old'});
  const end=await executeRepairPool({run,snapshot:await b.api(run),executor:'new',api:b.api,signal:new AbortController().signal,
   getPage:async()=>p,readTask:async()=>({state:'answered',answer:{translations:[{id:'R0',text:'ผลเดิม'}]}}),
   checkpointTask:async()=>{},onProgress:()=>{},applyResults:async()=>{},translate:async()=>{throw Error('Must not invoke provider')}});
  assert.equal(end.repaired,1);assert.equal(end.phase,'done');checks+=2;
 }finally{b.close()}
}
{
 const source=await readFile(new URL('../src/content/overlay/message-controller.js',import.meta.url),'utf8');const image={},seen=[];
 const TP={findTargetImage:()=>image,isStillCurrent:()=>({ok:true}),log:{info(){},warn(){}},applyHtmlOverlay:async(_img,r)=>seen.push(r),nextFrame:async()=>{}};
 vm.runInNewContext(source,{window:{__TP:TP},setTimeout,Promise,WeakMap});
 const stamp=(run,phase='initial',rev='')=>({runId:run,pageId:'p',generationId:run,phase,revision:rev});
 const bind=run=>TP.applyInsertMessage({type:'TP_TRANSLATION_BIND',original:'url',translationRun:stamp(run)});
 const insert=(run,phase,revision)=>TP.applyInsertMessage({type:'OVERLAY_HTML',mode:'lens_text',source:'ai',original:'url',result:run+phase,translationRun:stamp(run,phase,revision)});
 await bind('a');await insert('a','initial','');await insert('a','repair','v1');assert.equal((await insert('a','repair','v1')).replayed,true);
 assert.equal((await insert('a','initial','')).stale,true);await bind('b');assert.equal((await insert('a','repair','v2')).stale,true);
 assert.equal((await insert('b','repair','v1')).applied,true);assert.equal(seen.at(-1),'brepair');checks+=5;
}
{
 const b=bridge();try{
  const area=memory(),sessions=createTranslationSessionStore({area:()=>area});
  const contexts=new Map(), rendered=[], providerCalls=[],trace=[];
  const batch=ensureBatch('coordinator',777,0);batch.total1=4;
  const payloads=Array.from({length:4},(_,i)=>({engine:'extension',mode:'lens_text',source:'ai',lang:'th',src:`http://fixture/${i}.png`,metadata:{image_id:`page${i}`},context:{},ai:{}}));
  for(const p of payloads)batch.items.set(p.metadata.image_id,{attempt:1,status:'queued',phase:'waiting',payload:p});
  const coordinator=createRepairCoordinator({sessions,api:b.api,getBase:async()=> 'http://fixture',
   currentEpoch:()=>7,currentSession:()=> 'tab-session',getContext:id=>contexts.get(id),getCapabilitiesFor:async()=>({}),
   insert:async(_tab,msg)=>{if(msg.type==='OVERLAY_HTML')rendered.push(msg);return {ok:true,applied:true}},emit:(ev,data)=>trace.push({ev,data}),
   execute:options=>executeRepairPool({...options,withCapacity:async(_p,_a,_s,fn)=>fn(),
    planner:createWorkloadController({read:async()=>({}),write:async()=>{}}),
    translate:async(units)=>{providerCalls.push(units);return {translations:units.map(u=>({id:u.id,text:'คำแปลที่ซ่อม'})),meta:{generationAttempts:1}}}})});
  const run=await coordinator.registerBatch(batch,payloads);assert.ok(run);
  for(let i=0;i<payloads.length;i++){
   const p=payloads[i],id=`job${i}`,result={metadata:p.metadata,lensDocument:doc(2),eraseBoxes:erase(2)};
   contexts.set(id,{jobId:id,imageKey:p.metadata.image_id,tabId:777,frameId:0,imgUrl:p.src,mode:'lens_text',source:'ai',lang:'th',sessionId:'tab-session',settingsEpoch:7,generation:{pageInstanceId:'p'}});
   await translateLensPage({base:'http://fixture',payload:p,result,jobId:id,cancelBatchId:batch.id,
    plan:{route:'direct-local',ai:{provider:'ollama',model:'fixture',prompt:'STYLE',thinking:'off'}},
    onCheckpoint:data=>coordinator.capture(batch.id,data),
    dependencies:{translateUnits:async(units)=>({translations:units.map(u=>({id:u.id,text:u.id==='g0'?'ของดีเดิม':'原文'})),meta:{generationAttempts:1}})}});
   await coordinator.markDelivered(contexts.get(id),true);
   assert.equal(providerCalls.length,0,'no pooled repair until the initial batch barrier');
  }
  assert.equal((await b.api(run)).initialPages,0);
  await Promise.all([coordinator.finishInitial(batch),coordinator.finishInitial(batch)]);
  const complete=await sessions.get(run.id);
  assert.equal(complete.phase,'done',JSON.stringify(complete));assert.equal(complete.summary.repaired,4);
  assert.equal(providerCalls.flat().length,4);assert.equal(new Set(providerCalls.flat().map(u=>u.id)).size,4);
  assert.equal(rendered.length,4);
  for(const msg of rendered){assert.equal(msg.result.lensDocument.paragraphs[0].aiText,'ของดีเดิม');assert.equal(msg.result.lensDocument.paragraphs[1].aiText,'คำแปลที่ซ่อม');}
  assert.deepEqual(complete.pages,{});assert.deepEqual(complete.tasks,{});checks+=14;
 }finally{b.close()}
}
console.log(`Session/UI/repair checks: ${checks} passed (no live providers).`);
