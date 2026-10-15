import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {pathToFileURL,fileURLToPath} from 'node:url';
const testDirectory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(process.env.TP_LIFECYCLE_SOURCE||(path.basename(testDirectory)==='scripts'?path.join(testDirectory,'..'):'inspection/v56/TextPhantom')); 
const messages=[];
globalThis.chrome={runtime:{sendMessage(_m,cb){cb?.();}},tabs:{sendMessage(_t,m,_o,cb){messages.push(m);cb?.({ok:true});}}};
const b=await import(pathToFileURL(path.join(root,'src/background/batches.js')));
const code=fs.readFileSync(path.join(root,'src/content/progress-panel.js'),'utf8');
const prefix=code.slice(0,code.indexOf('  function setCollapsed')),consumer={};
vm.runInNewContext(prefix+'Object.assign(TP,{compactText,batchActive});})();',{window:{__TP:consumer},Date,Map,Set,Object,Number,String,Math,Array,Boolean});
const checks=[];const check=(name,fn)=>{try{fn();checks.push({name,pass:true});}catch(e){checks.push({name,pass:false,error:e.message});}};
function owner(id){const batch=b.ensureBatch(id,76561,0);b.registerBatchPayload(batch,{source:'ai',src:`https://fixture.invalid/${id}.png`,ai:{provider:'paid',translation_mode:'conversation'}},'page');b.markImagePhase(id,'page','ai_generating');b.markImagePhase(id,'page','error',{lastError:'Initial model response incomplete'});return batch;}
const active=(row)=>['overall','lens','grouping','ai','insert'].filter(k=>['queued','running'].includes(row.progress[k].state));
for(const phase of ['blocked','unavailable','apply_failed']){
 const batch=owner('failure-'+phase);b.updateImagePresentation(batch.id,'page',{repairPhase:'repair_request',repairEvent:'instruction_selected',pending:1});
 if(phase==='apply_failed')b.updateImagePresentation(batch.id,'page',{repairPhase:'applying',pending:1});
 batch.repair={phase,failedUnits:1,unresolved:1};b.updateImagePresentation(batch.id,'page',{repairPhase:phase,pending:1});
 check(phase+': completed failing request stops every active lane',()=>{const row=b.batchProgressSnapshot(batch).items[0];assert.deepEqual(active(row),[]);assert(row.progress.ai.finishedAt>0,'Finished AI request retains its terminal clock');if(phase==='apply_failed')assert(row.progress.insert.finishedAt>0,'Failed placement retains its terminal clock');});
 check(phase+': consumer no longer calls settled request active',()=>assert.equal(consumer.batchActive(b.batchProgressSnapshot(batch)),false));
 if(phase==='blocked'){
  check('paused shared-toast metadata stops reporting active generation',()=>{b.batchToast(batch,'Repair paused',2000,true);assert.equal(messages.filter(m=>m.type==='TP_TOAST').at(-1).progress.active,false);});
  check('blocked scope still recoverable without new owner',()=>{assert.equal(batch.repair.phase,'blocked');b.updateImagePresentation(batch.id,'page',{repairPhase:'repair_request',repairEvent:'instruction_selected',pending:1});assert.equal(b.batchProgressSnapshot(batch).items[0].progress.ai.state,'running');});
  batch.repair={phase:'done',failedUnits:1,repaired:1,unresolved:0};b.updateImagePresentation(batch.id,'page',{repairPhase:'done',pending:0});
  check('accepted full repair becomes done after prior pause',()=>assert.equal(b.batchProgressSnapshot(batch).items[0].progress.result.state,'done'));
 }
}
const partial=owner('partial-done');partial.repair={phase:'done',failedUnits:1,repaired:0,unresolved:1};b.updateImagePresentation(partial.id,'page',{repairPhase:'done',pending:1});
check('partial done initially separates processing completion from success',()=>{const s=b.batchProgressSnapshot(partial);assert.equal(s.items[0].phase,'done');assert.equal(s.items[0].progress.result.state,'error');assert.equal(s.active,0);});
b.batchMark(partial.id,'page',{deferredImageError:null});
check('acknowledged error notice metadata preserves partial Result.error',()=>assert.equal(b.batchProgressSnapshot(partial).items[0].progress.result.state,'error'));
const complete=owner('full-done');complete.repair={phase:'done',failedUnits:1,repaired:1,unresolved:0};b.updateImagePresentation(complete.id,'page',{repairPhase:'done',pending:0});b.batchMark(complete.id,'page',{deferredImageError:null});
check('metadata preserves successful full Result.done',()=>assert.equal(b.batchProgressSnapshot(complete).items[0].progress.result.state,'done'));
const cancelled=owner('cancelled-reader');b.batchMark(cancelled.id,'page',{phase:'cancelled',status:'aborted',lastError:'page_unloaded'});cancelled.cancelled=true;cancelled.lifecycle='cancelled';cancelled.repair={phase:'cancelled'};b.updateImagePresentation(cancelled.id,'page',{repairPhase:'repair_request',pending:1});
check('late repair presentation cannot reopen canceled owner',()=>{const s=b.batchProgressSnapshot(cancelled);assert.equal(s.items[0].phase,'cancelled');assert.deepEqual(active(s.items[0]),[]);assert.equal(s.items[0].progress.result.state,'cancelled');assert.equal(consumer.batchActive(s),false);});
const reader=owner('pending-reader');reader.reader={runId:'fixture-reader',released:true,processingComplete:true};reader.lifecycle='completed';reader.repair={phase:'apply_pending',failedUnits:1,repaired:1,unresolved:0};b.updateImagePresentation(reader.id,'page',{repairPhase:'apply_pending',placementPending:true,pending:0});b.batchMark(reader.id,'page',{deferredImageError:null});
check('saved reader placement remains honestly pending',()=>{const s=b.batchProgressSnapshot(reader);assert.equal(s.placement.waiting,1);assert.equal(s.items[0].progress.insert.state,'queued');assert.equal(s.items[0].progress.result.state,'pending');assert.equal(consumer.batchActive(s),true);});
const result={root,total:checks.length,passed:checks.filter(x=>x.pass).length,checks};if(process.env.TP_LIFECYCLE_OUT)fs.writeFileSync(process.env.TP_LIFECYCLE_OUT,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exitCode=checks.some(x=>!x.pass)?1:0;
