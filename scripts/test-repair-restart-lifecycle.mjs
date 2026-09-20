import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
process.chdir(root);globalThis.crypto ||= webcrypto;
const {createTranslationSessionStore}=await import(root+'/src/background/translation-session-store.js');
const {createRepairCoordinator}=await import(root+'/src/background/repair/coordinator.js');
const {executeRepairPool}=await import(root+'/src/background/repair/executor.js');
const {makePageCheckpoint,pageInitialReport}=await import(root+'/src/background/repair/page-checkpoint.js');
const {ensureBatch}=await import(root+'/src/background/batches.js');
const {translationUnits}=await import(root+'/src/shared/lens-document.js');
const {reserveConversationJob}=await import(root+'/src/background/ai/translation-paths/order.js');
function memory(){let value={};return {async get(k){return {[k]:structuredClone(value[k])}},async set(v){Object.assign(value,structuredClone(v))}}}
function bridge(){
 const child=spawn(process.env.TP_TEST_PYTHON || 'python',['-u','scripts/repair-ledger-fixture.py'],{cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','inherit']});const queue=[];
 createInterface({input:child.stdout}).on('line',line=>{const p=queue.shift(),out=JSON.parse(line);out.ok?p.resolve(out.value):p.reject(Object.assign(new Error(out.code),out));});
 return {api(run,action='',body,options={}){return new Promise((resolve,reject)=>{queue.push({resolve,reject});child.stdin.write(JSON.stringify({run,action:options.method==='DELETE'?'delete':action,body})+'\n');});},close(){child.stdin.end()}};
}
for (const scenario of ['collecting','repairing','same-process-receipt','collecting-deferred','collecting-delivered']) {
 const phase=scenario.startsWith('collecting')?'collecting':'repairing';
 const sessions=createTranslationSessionStore({area:()=>area}),area=memory();let b=bridge();const actions=[],calls=[],cleared=[],insertions=[];
 const api=(...args)=>{actions.push(args[1]||'GET');return b.api(...args)};
 const batch=ensureBatch(`restart-${scenario}`,980+['collecting','repairing','same-process-receipt','collecting-deferred','collecting-delivered'].indexOf(scenario),0);
 const ai={provider:'ollama',model:'fixture',translation_mode:'conversation',conversation:{documentId:`doc-${phase}`,owner:'tab-session'},thinking:'off'};
 const payload={engine:'extension',mode:'lens_text',source:'ai',lang:'th',src:`http://fixture/${phase}.png`,metadata:{image_id:'p'},context:{tp_tab_session:'tab-session'},ai};
 reserveConversationJob(payload,batch.tabId);batch.items.set('p',{attempt:1,status:'done',phase:'finished',payload});
 const d={schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'en',target:'th'},paragraphs:[{id:'p0',sourceText:'Original source',items:[]}]};
 const p=await makePageCheckpoint({payload,result:{lensDocument:d,eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}},plan:{route:'direct-local',ai:payload.ai},units:translationUnits(d),ctx:{jobId:'g',imageKey:'p',tabId:batch.tabId,frameId:0,imgUrl:payload.src,mode:'lens_text',source:'ai',sessionId:'tab-session'},operationId:'op'});
 p.phase='finished';p.failures=[{id:p.units[0].id,reason:'missing'}];
 if(scenario==='collecting-deferred'||scenario==='collecting-delivered') {
  batch.items.get('p').deferredImageError={type:'IMAGE_ERROR',error:'original_provider_failure'};
  p.delivered=scenario==='collecting-delivered';
 }
 const coordinator=createRepairCoordinator({sessions,api,getBase:async()=> 'http://fixture',currentEpoch:()=>7,currentSession:()=> 'tab-session',getCapabilitiesFor:async()=>({}),insert:async(...args)=>{insertions.push(args);return {ok:true,applied:true}},emit:()=>{},readSettings:async()=>({}),
  preparedPages:{listRun:async()=>[],clearRun:async()=>{cleared.push('prepared')}},dispatchJournal:{listRun:async()=>[],clearRun:async()=>{cleared.push('dispatch')}},
  execute:options=>executeRepairPool({...options,withCapacity:async(_p,_a,_s,fn)=>fn(),
   planner:{open:async({ai})=>({ai,key:'fixture',nextRepair:rows=>({units:rows,estimate:{limits:{}}}),observe:()=>({outcome:'ok'})}),flush:async()=>{}},
   translate:async(units)=>{calls.push(units.map(u=>u.id));return {translations:units.map(u=>({id:u.id,text:'คำแปล'})),meta:{generationAttempts:1}};}})});
 const run=await coordinator.registerBatch(batch,[payload]);
 await sessions.update(run.id,r=>({...r,phase,pages:{p},tasks:{}}));
 if(phase==='repairing'){await api(run,'pages',pageInitialReport(p));await api(run,'seal',{});}
 if(scenario==='same-process-receipt') {
  const snap=await api(run,'');
  await api(run,'claim',{taskId:'saved',executor:'old-worker',route:'direct-local',ids:snap.pending.map(u=>u.id)});
  await api(run,'tasks/saved/start',{executor:'old-worker'});
  await api(run,'tasks/saved/answer',{translations:snap.pending.map(u=>({id:u.id,text:'คำแปล'})),meta:{generationAttempts:1}});
 } else {b.close();b=bridge();}
 actions.length=0;
 if(scenario==='same-process-receipt') await coordinator.resume();
 await coordinator.finishInitial(batch);
 let after=await sessions.get(run.id);
 if(scenario==='same-process-receipt') {
  assert.equal(after.phase,'done','existing answered receipt still completes after worker recovery');
  assert.equal(calls.length,0,'saved receipt never resends AI');
  assert.ok(actions.includes('tasks/saved/complete'),'existing answer is committed');
 } else {
  assert.equal(after.phase,'unavailable');
  assert.equal(after.lastError,'repair_run_not_found');
  assert.equal(calls.length,0,'lost ownership must not resurrect any AI work');
  assert.equal(insertions.length,scenario==='collecting-deferred'?1:0,'only undelivered initial error may be flushed; partial display is preserved');
  if(scenario==='collecting-deferred'||scenario==='collecting-delivered')
   assert.equal(batch.items.get('p').deferredImageError,null,'terminal run cannot retain deferred errors');
  assert.deepEqual(actions,['GET'],'only read old ownership, no register or mutations');
  assert.deepEqual(after.pages,{});assert.deepEqual(after.tasks,{});
  assert.ok(cleared.includes('prepared')&&cleared.includes('dispatch'));
  assert.equal(batch.repair.phase,'unavailable');
  const before=actions.length;
  await coordinator.resume();await coordinator.finishInitial(batch);await coordinator.resume();
  after=await sessions.get(run.id);
  assert.equal(after.phase,'unavailable');assert.equal(actions.length,before,'terminal resumes do no API work');
  assert.equal(calls.length,0);
 }
 console.log(JSON.stringify({scenario,phase:after.phase,providerCalls:calls.length,actions}));
 b.close();
}
console.log('PASS API restart lifecycle: no resurrection, terminal stale checkpoints, live receipt recovery');
