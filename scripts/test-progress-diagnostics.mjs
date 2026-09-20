// Batch progress diagnostics: durable sequencing + one page status board; no live provider.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
const root=pathToFileURL(`${process.env.TP_TEST_ROOT || process.cwd()}/`);
const messages=[];
globalThis.chrome={runtime:{get lastError(){return null;},sendMessage(_m,cb){cb?.();}},
 tabs:{sendMessage(_t,m,_opts,cb){messages.push(m);cb?.({ok:true});}}};
const {ensureBatch,batchToast,batchUpdateToast,serializeBatchSnapshot,restoreBatchSnapshot}=await import(new URL('src/background/batches.js',root));
const results=[];
async function check(name,fn){try{await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.stack});}}
const b=ensureBatch('repair-progress',23,0);b.total1=10;
for(let i=0;i<10;i++)b.items.set(`i${i}`,{attempt:1,status:'done',phase:'done',payload:{generation:{pageInstanceId:'page-a'}}});
function send(phase,label){b.repair={phase,label};batchUpdateToast(b,label,true);return messages.filter(x=>x.type==='BATCH_STATUS_UPDATE').at(-1)?.batch;}
await check('finished initial pages remain visibly active while repair owns the batch',()=>{
 const m=send('repairing','Repairing 34 unit(s); 15 fixed');assert.equal(m.repair.phase,'repairing');assert.equal(m.terminal,10);assert.equal(m.total,10);assert.match(m.message,/Repairing 34/);
});
await check('apply/blocked/pending repair phases remain explicit in batch status',()=>{
 for(const phase of ['applying','blocked','apply_pending','repair_wave','repair_circuit_open']){const m=send(phase,`Repair ${phase}`);assert.equal(m.repair.phase,phase);assert.match(m.message,new RegExp(phase));
  batchToast(b,`Repair ${phase}`,2000,true);assert.equal(messages.filter(x=>x.type==='TP_TOAST').at(-1).progress.active,true);
 }
});
await check('real compact panel keeps repair waves and circuit settlement active after initial completion',()=>{
 const code=readFileSync(new URL('src/content/progress-panel.js',root),'utf8');
 // Execute the actual compact presenter and activity predicate without mounting DOM.
 const prefix=code.slice(0,code.indexOf('  function setCollapsed'));
 const runtime={};vm.runInNewContext(prefix+'Object.assign(TP,{compactText,batchActive});})();',
   {window:{__TP:runtime},Date,Map,Set,Object,Number,String,Math,Array,Boolean});
 for(const phase of ['repair_wave','repair_circuit_open']) {
  const batch={total:1,terminal:1,startedAt:Date.now()-8000,repair:{phase,failedUnits:4,repaired:0},
   items:[{terminal:true,progress:{overall:{state:'done'},ai:{state:'done'},result:{state:'error'}}}]};
  assert.equal(runtime.batchActive(batch),true,phase+' must not expire as done');
  const text=runtime.compactText(batch);assert.match(text,/Repair active/);assert.doesNotMatch(text,/done /);
  batch.repair={phase:'done',failedUnits:4,repaired:3,unresolved:1};
  assert.equal(runtime.batchActive(batch),false);assert.match(runtime.compactText(batch),/unresolved 1/);
 }
});
await check('progress sequence is monotonic and survives worker checkpoint restore',()=>{
 const before=Number(b.progressSequence)||0;const first=send('repairing','Repairing');assert.ok(first.sequence>before);
 const snap=serializeBatchSnapshot(b);assert.equal(snap.progressSequence,first.sequence);
 const restored=restoreBatchSnapshot(snap);assert.equal(restored.progressSequence,first.sequence);
 batchUpdateToast(restored,'Repairing restored',true);const second=messages.filter(x=>x.type==='BATCH_STATUS_UPDATE').at(-1)?.batch;assert.ok(second.sequence>first.sequence);
});
await check('status board source rejects stale packets, preserves active repair and coalesces DOM paints',()=>{
 const code=readFileSync(new URL('src/content/progress-panel.js',root),'utf8');
 assert.match(code,/pageInstanceId/);assert.match(code,/pageStarted/);assert.match(code,/seq&&seq<=prev/);
 assert.match(code,/repairActive/);assert.match(code,/batchStates/);assert.match(code,/chooseVisible/);
 assert.match(code,/setTimeout\(\(\)=>\{paintTimer=0/);assert.match(code,/80\)/);
 assert.match(code,/setInterval\(tick,500\)/);
 assert.match(code,/collapsed=true/);assert.match(code,/getToastProgressHost/);
 assert.match(code,/AI \/ queue/);assert.match(code,/waiting response/);assert.match(code,/onDocumentKeydown/);assert.match(code,/onDocumentPointerDown/);assert.match(code,/Show per-image TextPhantom progress/);
 const domCode=readFileSync(new URL('src/content/dom-utils.js',root),'utf8');
 assert.match(domCode,/toastProgressMode && toastTimer/);assert.match(domCode,/!toastProgressMode && !liveToasts\.size/);
});
await check('live batch progress does not compete with a second TP_TOAST presenter',()=>{
 const before=messages.filter(x=>x.type==='TP_TOAST').length;send('repairing','Repairing visible');const after=messages.filter(x=>x.type==='TP_TOAST').length;assert.equal(after,before);
});
await check('group diagnostics are trace-only; actual render failure is still visible',async()=>{
 let code=readFileSync(new URL('src/content/overlay/local-render.js',root),'utf8').replace(/import\(\s*chrome\.runtime\.getURL\("processors\/render\/renderer\.js"\)\s*\)/,'Promise.resolve(__renderer)');
 const warnings=[],traces=[];let enabled=false;const report={aiUnanswered:[],missingLayer:['p-missing'],aiBlocksOverlapping:1,aiOverlapPairs:['p0|p1']};
 const local={ensureOverlayStyle(){},log:{warn:(...a)=>warnings.push(a),debug(){}},traceNote:(...a)=>{if(enabled)traces.push(a);}};
 vm.runInNewContext(code,{window:{__TP:local},Promise,__renderer:{OVERLAY_CSS:'',renderOverlay:()=>({root:{},report})}});
 await local.overlayLocalRender.build({lensDocument:{paragraphs:[]}},'ai');assert.equal(warnings.length,0);assert.equal(traces.length,0);
 enabled=true;await local.overlayLocalRender.build({lensDocument:{paragraphs:[]}},'ai');assert.equal(warnings.length,0);assert.ok(traces.some(a=>a[1]==='aiBlockOverlap'));assert.ok(traces.some(a=>a[1]==='groupingDocumentMismatch'));
 report.error='invalid schema';const r=await local.overlayLocalRender.build({lensDocument:{paragraphs:[]}},'ai');assert.equal(r.root,null);assert.equal(warnings.length,1);
});

console.log(JSON.stringify({schema:'tp.progress-diagnostics/2',passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results},null,2));
process.exitCode=results.some(x=>!x.pass)?1:0;
