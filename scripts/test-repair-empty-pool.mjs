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
const {makePageCheckpoint}=await import(root+'/src/background/repair/page-checkpoint.js');
const {ensureBatch}=await import(root+'/src/background/batches.js');
const {translationUnits}=await import(root+'/src/shared/lens-document.js');
const {reserveConversationJob}=await import(root+'/src/background/ai/translation-paths/order.js');
function memory(){let value={};return {async get(k){return {[k]:structuredClone(value[k])}},async set(v){Object.assign(value,structuredClone(v))}}}
function bridge(){
 const child=spawn(process.env.TP_TEST_PYTHON || 'python',['-u','scripts/repair-ledger-fixture.py'],{cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','inherit']});const queue=[];
 createInterface({input:child.stdout}).on('line',line=>{const p=queue.shift(),out=JSON.parse(line);out.ok?p.resolve(out.value):p.reject(Object.assign(new Error(out.code),out));});
 return {api(run,action='',body,options={}){return new Promise((resolve,reject)=>{queue.push({resolve,reject});child.stdin.write(JSON.stringify({run,action:options.method==='DELETE'?'delete':action,body})+'\n');});},close(){child.stdin.end()}};
}
for (const scenario of ['empty-pool','empty-undelivered']) {
 const phase='collecting'; let capabilities=0, executions=0;
 const sessions=createTranslationSessionStore({area:()=>area}),area=memory();let b=bridge();const actions=[],calls=[],cleared=[],insertions=[];
 const api=(...args)=>{actions.push(args[3]?.method==='DELETE'?'DELETE':args[1]||'GET');return b.api(...args)};
 const batch=ensureBatch(`restart-${scenario}`,980+['empty-pool','empty-undelivered'].indexOf(scenario),0);
 const ai={provider:'ollama',model:'fixture',translation_mode:'conversation',conversation:{documentId:`doc-${phase}`,owner:'tab-session'},thinking:'off'};
 const payload={engine:'extension',mode:'lens_text',source:'ai',lang:'th',src:`http://fixture/${phase}.png`,metadata:{image_id:'p'},context:{tp_tab_session:'tab-session'},ai};
 reserveConversationJob(payload,batch.tabId);batch.items.set('p',{attempt:1,status:'done',phase:'finished',payload});
 const d={schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'en',target:'th'},paragraphs:[{id:'p0',sourceText:'Original source',items:[]}]};
 const p=await makePageCheckpoint({payload,result:{lensDocument:d,eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}},plan:{route:'direct-local',ai:payload.ai},units:translationUnits(d),ctx:{jobId:'g',imageKey:'p',tabId:batch.tabId,frameId:0,imgUrl:payload.src,mode:'lens_text',source:'ai',sessionId:'tab-session'},operationId:'op'});
 p.phase='finished';p.failures=[];p.accepted=p.units.map(u=>({id:u.id,text:'คำแปล'}));p.delivered=scenario==='empty-pool';
 const coordinator=createRepairCoordinator({sessions,api,getBase:async()=> 'http://fixture',currentEpoch:()=>7,currentSession:()=> 'tab-session',getCapabilitiesFor:async()=>{capabilities++;return {}},insert:async(...args)=>{insertions.push(args);return {ok:true,applied:true}},emit:()=>{},readSettings:async()=>({}),
  preparedPages:{listRun:async()=>[],clearRun:async()=>{cleared.push('prepared')}},dispatchJournal:{listRun:async()=>[],clearRun:async()=>{cleared.push('dispatch')}},
  execute:options=>{executions++;return executeRepairPool({...options,withCapacity:async(_p,_a,_s,fn)=>fn(),
   planner:{open:async({ai})=>({ai,key:'fixture',nextRepair:rows=>({units:rows,estimate:{limits:{}}}),observe:()=>({outcome:'ok'})}),flush:async()=>{}},
   translate:async(units)=>{calls.push(units.map(u=>u.id));return {translations:units.map(u=>({id:u.id,text:'คำแปล'})),meta:{generationAttempts:1}};}})}});
 const run=await coordinator.registerBatch(batch,[payload]);
 await sessions.update(run.id,r=>({...r,phase,pages:{p},tasks:{}}));
 actions.length=0;
 await coordinator.finishInitial(batch);
 let after=await sessions.get(run.id);
 assert.equal(after.phase,'done');
 assert.equal(calls.length,0);assert.equal(capabilities,0);assert.equal(executions,0);
 assert.ok(actions.includes('seal'));assert.ok(actions.includes('GET'));assert.ok(actions.includes('DELETE'));
 assert.deepEqual(after.pages,{});assert.deepEqual(after.tasks,{});assert.ok(!actions.includes('claim'));
 assert.equal(insertions.length,scenario==='empty-pool'?0:1,'accepted results still get placed without a repair request');
 if(scenario==='empty-pool') assert.notEqual(batch.items.get('p').presentation?.repairPhase,'done','healthy image is not relabeled Repair complete');
 assert.equal(batch.repair.phase,'done');assert.equal(batch.repair.failedUnits,0);
 console.log(JSON.stringify({scenario,phase:after.phase,providerCalls:calls.length,actions}));
 b.close();
}
console.log('PASS empty pool: no executor, capabilities, claim or AI; terminal cleanup preserved');
