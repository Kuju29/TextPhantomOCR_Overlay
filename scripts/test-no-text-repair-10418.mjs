import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
const rootUrl=new URL('../',import.meta.url);const root=fileURLToPath(rootUrl);const from=p=>import(new URL('src/'+p,rootUrl));
const {translateLensPage}=await from('background/pipeline/page-translation.js');const {createRepairCoordinator}=await from('background/repair/coordinator.js');const {createTranslationSessionStore}=await from('background/translation-session-store.js');const {ensureBatch}=await from('background/batches.js');
function memory(){const value={};return {get:async k=>k==null?structuredClone(value):{[k]:structuredClone(value[k])},set:async p=>Object.assign(value,structuredClone(p)),remove:async keys=>{for(const k of [].concat(keys))delete value[k]}};}
function bridge(){const child=spawn(process.env.TP_TEST_PYTHON || 'python',['-u','scripts/repair-ledger-fixture.py'],{cwd:root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','inherit']});const queue=[];createInterface({input:child.stdout}).on('line',s=>{const q=queue.shift(),r=JSON.parse(s);r.ok?q.resolve(r.value):q.reject(Object.assign(new Error(r.code),r));});return {api:(run,action='',body,options={})=>new Promise((resolve,reject)=>{queue.push({resolve,reject});child.stdin.write(JSON.stringify({run,action:options.method==='DELETE'?'delete':action,body})+'\n');}),close:()=>child.stdin.end()};}
const scenarios=[['blank page','pipeline',[],0,1,'succeeded'],['digits and symbols','pipeline',[{id:'p0',sourceText:'1234567890',items:[]},{id:'p1',sourceText:'...!?',items:[]}],0,1,'succeeded'],['standalone OCR characters','pipeline',['A','L','-','A\u0301',' \u200bA\u200d ','我'].map((sourceText,i)=>({id:`p${i}`,sourceText,items:[]})),0,1,'succeeded'],['genuine missing source','missing',[],1,0,'failed'],['invalid skip reason','invalid',[],1,0,'failed'],['out of manifest skip','out-of-manifest',[],1,0,'failed'],['direct authoritative OCR receipt','direct',[],0,1,'succeeded']];
const results=[];
for(let index=0;index<scenarios.length;index++){
 const [name,kind,paragraphs,unavailable,skipCount,outcome]=scenarios[index];const area=memory(),sessions=createTranslationSessionStore({area:()=>area}),ledger=bridge(),events=[],reports=[],insertions=[];let aiCalls=0,capabilityCalls=0,repairExecutions=0;
 const batch=ensureBatch('skip-proof-'+index,92600+index,0),payload={engine:'extension',mode:'lens_text',source:'ai',lang:'th',src:'http://fixture.invalid/'+index+'.png',metadata:{image_id:'p'},context:{}};batch.items.set('p',{attempt:1,status:'done',phase:'done',payload});
 const api=async(...args)=>{if(args[1]==='pages')reports.push(...(args[2].pages||[args[2]]));return ledger.api(...args)};
 const coordinator=createRepairCoordinator({sessions,api,getBase:async()=> 'http://fixture.invalid',currentEpoch:()=>7,currentSession:()=> 'fixture-session',insert:async(...a)=>{insertions.push(a);return {ok:true,applied:true}},getCapabilitiesFor:async()=>{capabilityCalls++;return {}},readSettings:async()=>({}),preparedPages:{listRun:async()=>[],clearRun:async()=>{}},dispatchJournal:{listRun:async()=>[],clearRun:async()=>{}},emit:(name,value)=>events.push({name,value}),execute:async()=>{repairExecutions++;assert.fail('Empty pool must not execute repair')}});
 try{
  const run=await coordinator.registerBatch(batch,[payload]);assert(run);
  if(kind==='pipeline'){
   const result={lensDocument:{schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'en',target:'th'},paragraphs},eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}};
   const translated=await translateLensPage({base:'http://fixture.invalid',payload,result,plan:{route:'server',ai:{provider:'paid',model:'fixture',translation_mode:'conversation'}},jobId:'skip-job',cancelBatchId:batch.id,onCheckpoint:data=>coordinator.capture(batch.id,data),dependencies:{translateUnits:async()=>{aiCalls++;assert.fail('A no-text page must not invoke AI')}}});
   assert.equal(translated.skipped,true);const saved=(await createTranslationSessionStore({area:()=>area}).get(run.id));assert.equal(saved.initialSkips.p,paragraphs.length?'no_translatable_text':'no_text');
  }else if(kind==='direct')await coordinator.capture(batch.id,{stage:'skipped',imageId:'p',reason:'no_translatable_text'});
  else if(kind==='invalid')await coordinator.capture(batch.id,{stage:'skipped',imageId:'p',reason:'source_unavailable'});
  else if(kind==='out-of-manifest')await coordinator.capture(batch.id,{stage:'skipped',imageId:'fake',reason:'no_text'});
  await coordinator.finishInitial(batch);const state=await sessions.get(run.id),final=events.findLast(e=>e.name==='repairProgress'&&e.value.phase==='done');
  assert.equal(state.phase,'done');assert.equal(reports.length,1);assert.equal(reports[0].status,unavailable?'no_source':'finished');assert.equal(state.summary.unavailablePages,unavailable);assert.equal(final.value.counts.skippedPages,skipCount);assert.equal(final.value.outcome,outcome);assert.equal(aiCalls,0);assert.equal(repairExecutions,0);assert.equal(capabilityCalls,0);assert.equal(insertions.length,0);
  results.push({name,passed:true,unavailablePages:unavailable,skippedPages:skipCount,outcome,providerCalls:aiCalls,repairExecutions,domInsertions:insertions.length});
 }finally{ledger.close()}
}
console.log(JSON.stringify({passed:true,scenarioCount:results.length,scope:'real Lens-document no-text pipeline + durable session receipts + production Python repair ledger + coordinator final classification',results}));
