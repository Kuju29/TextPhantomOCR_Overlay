import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
const storedToken=process.env.TP_TEST_SWITCH_PAID === '1' ? 'synthetic-other-session' : 'synthetic-session';
globalThis.chrome={runtime:{},storage:{local:{get:(keys,cb)=>cb(Object.fromEntries([].concat(keys).map(k=>[k,k==='paidSessionToken'?storedToken:k==='paidApiBase'?'http://fixture.invalid':undefined]))),remove:(_keys,cb)=>cb?.()},session:{get:(_keys,cb)=>cb({})}}};
const rootUrl=new URL('../',import.meta.url);const root=fileURLToPath(rootUrl);
const from=p=>import(new URL('src/'+p,rootUrl));
const {translateLensPage}=await from('background/pipeline/page-translation.js');
const {createRepairCoordinator}=await from('background/repair/coordinator.js');
const {executeRepairPool}=await from('background/repair/executor.js');
const {createTranslationSessionStore}=await from('background/translation-session-store.js');
const {createDispatchJournal}=await from('background/repair/dispatch-journal.js');
const {createPreparedPageJournal}=await from('background/repair/prepared-page-journal.js');
const {ensureBatch}=await from('background/batches.js');
const {reserveConversationJob,finishConversationJob}=await from('background/ai/translation-paths/order.js');
function memory(){const values={};return {get:async key=>key==null?structuredClone(values):{[key]:structuredClone(values[key])},set:async patch=>Object.assign(values,structuredClone(patch)),remove:async keys=>{for(const k of [].concat(keys))delete values[k]}};}
const child=spawn(process.env.TP_TEST_PYTHON || 'python',['-X','utf8','-u','scripts/repair-ledger-fixture.py'],{cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','inherit']});const pending=[];
createInterface({input:child.stdout}).on('line',line=>{const q=pending.shift(),r=JSON.parse(line);r.ok?q.resolve(r.value):q.reject(Object.assign(new Error(r.code),r));});
const api=(run,action='',body,options={})=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify({run,action:options.method==='DELETE'?'delete':action,body})+'\n');});
const area=memory(),sessions=createTranslationSessionStore({area:()=>area}),dispatchJournal=createDispatchJournal({area:()=>area}),preparedPages=createPreparedPageJournal({area:()=>area});
const ai={provider:'paid',model:'fixture-paid',api_key:'synthetic-session',thinking:'minimum',translation_mode:'conversation',style_examples:false,conversation:{documentId:'synthetic-document',owner:'fixture-session'}};
const payload={engine:'extension',mode:'lens_text',source:'ai',lang:'th',src:'http://fixture.invalid/p.png',metadata:{image_id:'p'},context:{tp_tab_session:'fixture-session',page_index:0},ai};
reserveConversationJob(payload,91218);
const batch=ensureBatch('proof-paid-repair',91218,0);batch.items.set('p',{attempt:1,status:'queued',phase:'waiting',payload});
const ctx={jobId:'proof-job',imageKey:'p',tabId:91218,frameId:0,imgUrl:payload.src,mode:'lens_text',source:'ai',sessionId:'fixture-session',settingsEpoch:7};
const document={schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'en',target:'th'},paragraphs:[{id:'p0',sourceText:'Hello my friend',items:[]},{id:'p1',sourceText:'THIS IS A LONG ENGLISH SENTENCE',items:[]},{id:'p2',sourceText:'Where are you going?',items:[]}]};
const result={lensDocument:document,eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}};
const insertions=[],events=[];let initialCalls=0,repairCalls=0;
const coordinatorOptions={sessions,dispatchJournal,preparedPages,api,getBase:async()=> 'http://fixture.invalid',currentEpoch:()=>7,currentSession:()=> 'fixture-session',getContext:()=>ctx,getCapabilitiesFor:async()=>({}),readSettings:async()=>({}),insert:async(_t,message)=>{insertions.push(message);return {ok:true,applied:true}},emit:(name,value)=>events.push({name,value}),
 execute:options=>executeRepairPool({...options,withCapacity:async(_p,_a,_s,fn)=>fn(),planner:{open:async()=>({key:'repair-profile',nextRepair:rows=>({units:rows,estimate:{predictedOutput:256,estimatedInput:1000,reasoningReserve:0,completionAvailable:1024}}),observe:()=>({outcome:'ok'})})},translate:async(units,opts)=>{
  repairCalls++;assert.equal(opts.ai.provider,'paid');assert.equal(opts.ai.repair_reason,'wrong_target_script');assert.equal(opts.repairClaim.runId,options.run.id);
  const current=await api(options.run);const task=current.tasks.find(t=>t.id===opts.repairClaim.taskId);await api(options.run,`tasks/${task.id}/start`,{executor:task.executor});
  const answer={translations:task.units.map((u,i)=>({id:u.id,text:i===0?'นี่คือประโยคที่ต้องแปล':'จะไปที่ไหน'})),missing:[],meta:{provider:'paid',model:'fixture-paid',generationAttempts:1,providerAttempts:1,usage:{inputTokens:1000,cachedInputTokens:500,outputTokens:100,totalTokens:1100,source:'provider'}}};
  await api(options.run,`tasks/${task.id}/answer`,answer);return answer;
 }})};

const {providerPressure}=await from('background/repair/provider-pressure.js');
let coordinator=createRepairCoordinator(coordinatorOptions);
try {
 const run=await coordinator.registerBatch(batch,[payload]);assert(run);
 await translateLensPage({base:'http://fixture.invalid',payload,result,plan:{route:'server',ai:payload.ai},
   jobId:ctx.jobId,cancelBatchId:batch.id,onCheckpoint:data=>coordinator.capture(batch.id,data),
   conversationSubmit:async(units,opts)=>{
     initialCalls++;await opts.beforeBatchDispatch({units,batchId:'initial-proof',estimate:{}});
     return {translations:[{id:units[0].id,text:'สวัสดีเพื่อน'},{id:units[1].id,text:units[1].text}],
       missing:[units[2].id],meta:{generationAttempts:1,providerAttempts:1,omittedIds:[units[2].id]}};
   }});
 await coordinator.capture(batch.id,{stage:'pressure',imageId:'p',providerPressure:providerPressure({
   code:'provider_rate_limited',upstreamStatus:429,retryAfterMs:60000,creditState:'released'})});
 finishConversationJob(payload);
 coordinator=createRepairCoordinator(coordinatorOptions);
 await coordinator.resume(); await coordinator.finishInitial(batch);
 const paused=await sessions.get(run.id);
 assert.equal(paused.phase,'blocked');assert.equal(paused.lastError,'repair_provider_cooldown');
 assert(paused.retryAt>Date.now());assert.equal(repairCalls,0);
 const ledger=await api(run);assert.equal(ledger.tasks.length,0);assert.equal(ledger.pending.length,2);
 assert.equal(paused.pages.p.accepted.length,1,'accepted initial result must survive cooldown');
 await sessions.update(run.id,value=>({...value,providerPressure:Object.fromEntries(
   Object.entries(value.providerPressure).map(([key,row])=>[key,{...row,until:Date.now()-1}]))}));
 coordinator=createRepairCoordinator(coordinatorOptions);
 await coordinator.resume(); await coordinator.finishInitial(batch);
 const done=await sessions.get(run.id);assert.equal(done.phase,'done');assert.equal(done.summary.unresolved,0);
 assert.equal(repairCalls,1);assert.equal(initialCalls,1);
 console.log(JSON.stringify({passed:true,initial429CooldownRestored:true,claimsBeforeExpiry:0,
   repairCallsAfterExpiry:repairCalls,retainedInitialUnits:1,unresolved:0}));
} finally {finishConversationJob(payload);child.stdin.end();}
