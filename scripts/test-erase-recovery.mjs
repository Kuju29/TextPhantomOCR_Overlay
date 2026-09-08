/** Regression: real Lens decode -> owned masks -> partial AI -> repaired patch.
 * No provider/network. Captured Lens fixture; fake storage and DOM ACK only.
 * TP_TEST_ROOT can point at the unmodified release to demonstrate the regression.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
globalThis.crypto ||= webcrypto;
const toasts=[];
globalThis.chrome={runtime:{get lastError(){return null;},sendMessage(_m,cb){cb?.();}},
 tabs:{sendMessage(_t,m,_opts,cb){toasts.push(m);cb?.({ok:true});}}};
const root=pathToFileURL(`${process.env.TP_TEST_ROOT||process.cwd()}/`);
const load=p=>import(new URL(p,root));
const {decodeLensResponse}=await load('src/shared/lens-decode.js');
const erase=await load('src/shared/erase-boxes.js');
const {flattenSpans}=await load('src/shared/lens-tree.js');
const {translationUnits,applyTranslations}=await load('src/shared/lens-document.js');
const {translateLensPage}=await load('src/background/pipeline/page-translation.js');
const {createWorkloadController}=await load('src/background/ai/workload-controller.js');
const {makePageCheckpoint,buildPatchedResult,pageInitialReport}=await load('src/background/repair/page-checkpoint.js');
const {executeRepairPool}=await load('src/background/repair/executor.js');
const {createRepairCoordinator}=await load('src/background/repair/coordinator.js');
const {createTranslationSessionStore}=await load('src/background/translation-session-store.js');
const {ensureBatch}=await load('src/background/batches.js');
const policy=await load('src/background/pipeline/result-policy.js');
const {reportTranslationFailure}=await load('src/shared/diagnostic-policy.js');
const {userMessageForCode}=await load('src/shared/error-contract.js');
const fixture=JSON.parse(readFileSync(new URL('scripts/fixtures/lens-display-recorded.json',root),'utf8'));
const results=[];
async function test(name,fn){try{await fn();results.push({name,pass:true});console.log('PASS '+name);}catch(e){results.push({name,pass:false,error:e.stack});console.error('FAIL '+name+': '+e.message);}}
const decode=()=>decodeLensResponse(fixture.lens,{...fixture.image,targetLang:'th',source:'ai'});
const rawResult=d=>({lensDocument:d.document,eraseBoxes:d.eraseBoxes,backgroundMode:'boxes',layout:{relayout_translated:false}});
const ai={provider:'ollama',model:'fixture',base_url:'http://127.0.0.1:11434',thinking:'off',memory_mode:'off'};
const cleanGeometry=box=>{const {p,...g}=box;return g;};

await test('captured Lens producer assigns all 85 spans to surviving document paragraphs',()=>{
 const d=decode(),known=new Set(d.document.paragraphs.map(p=>p.id));
 assert.equal(d.eraseBoxes.boxes.length,85);assert.equal(d.document.paragraphs.length,30);
 assert(d.eraseBoxes.boxes.every(b=>known.has(b.p)),'producer emitted unowned erase boxes');
 assert.deepEqual(d.eraseBoxes.boxes.map(cleanGeometry),erase.buildEraseBoxes(flattenSpans(d.trees.original)).boxes,'ownership must not change geometry');
});
await test('ruby paragraph deletion uses the NEW source indices, not the old Lens index',()=>{
 const d=decode();assert(d.trees.original.furigana_filter.rawToFiltered.includes(null));
 const expected=d.trees.original.paragraphs.flatMap((p,i)=>erase.buildEraseBoxes(flattenSpans({paragraphs:[p]})).boxes.map(g=>({...g,p:`p${i}`})));
 assert.deepEqual(d.eraseBoxes.boxes,expected);
});
await test('grouped partial owns all leader members and never erases the unanswered paragraphs',()=>{
 const d=decode(),doc=structuredClone(d.document);
 doc.paragraphs[0].aiText='คำแปลกลุ่ม';doc.paragraphs[0].aiGroupParagraphIds=['p0','p1'];doc.paragraphs[1].aiCoveredBy='p0';
 const r=erase.eraseBoxesForAiPartial(doc,d.eraseBoxes);
 assert.equal(r.ok,true,r.reason);assert.deepEqual(new Set(r.eraseBoxes.boxes.map(b=>b.p)),new Set(['p0','p1']));
 assert.equal(r.eraseBoxes.boxes.length,d.eraseBoxes.boxes.filter(b=>['p0','p1'].includes(b.p)).length);
});
async function initial(unowned=false){
 const d=decode(),raw=rawResult(d);if(unowned)raw.eraseBoxes.boxes=raw.eraseBoxes.boxes.map(cleanGeometry);
 const before=structuredClone(raw);let page;const events=[],calls=[];
 const outcome=await translateLensPage({base:'http://fixture.invalid',payload:{lang:'th',metadata:{image_id:'recorded'},context:{}},result:raw,
  plan:{route:'direct-local',ai},jobId:'captured-job',trace:(event,data)=>events.push({event,data}),
  onCheckpoint:async row=>{
   if(row.stage==='prepared')page=await makePageCheckpoint({...row,ctx:{jobId:'captured-job'}});
   if(row.stage==='finished'){page.accepted=row.accepted;page.failures=row.failures;page.phase='finished';}
  },dependencies:{workloadController:createWorkloadController({read:async()=>({}),write:async()=>{}}),translateUnits:async units=>{
   calls.push(units.map(u=>u.id));return {schema:'tp.ai.result/1',translations:units.map(u=>({id:u.id,text:['g0','g1'].includes(u.id)?'日本語のままです':'คำแปลที่ถูกภาษาไทย'})),missing:[],meta:{finishReason:'stop',providerAttempts:1,generationAttempts:1}};
  }}});
 return {outcome,page,raw,before,events,calls};
}
await test('actual decode -> initial language validation produces a usable partial, no AI_OUTPUT_INVALID',async()=>{
 const r=await initial();assert.equal(r.outcome.usable,true,r.outcome.reason);assert.equal(r.outcome.complete,false);
 assert.deepEqual(r.outcome.missing,['g0','g1']);assert.equal(r.page.failures.length,2);
 assert(!r.raw.eraseBoxes.boxes.some(b=>b.p==='p0'||b.p==='p1'));
 assert.deepEqual(r.page.originalEraseBoxes,r.before.eraseBoxes,'checkpoint keeps complete source map for later repair');
});
await test('partial repair retains good text and erased pixels while another unit stays unresolved',async()=>{
 const r=await initial(),p=r.page,unit=p.units.find(u=>u.id==='g1');
 const repairs=[{id:'R1',unitId:'g1',translation:'คำแปลที่ซ่อมแล้ว',sourceHash:unit.sourceHash,generationId:p.generationId}];
 const patched=buildPatchedResult(p,repairs);
 assert.deepEqual(patched.missing,['g0']);assert.equal(patched.result.lensDocument.paragraphs[1].aiText,'คำแปลที่ซ่อมแล้ว');
 assert.equal(patched.result.lensDocument.paragraphs[2].aiText,r.raw.lensDocument.paragraphs[2].aiText);
 assert(!patched.result.eraseBoxes.boxes.some(b=>b.p==='p0'));assert(patched.result.eraseBoxes.boxes.some(b=>b.p==='p1'));
 assert.equal(patched.result.backgroundMode,'boxes');assert.deepEqual(buildPatchedResult(p,repairs),patched);
 assert.deepEqual(p.originalEraseBoxes,r.before.eraseBoxes);
});
await test('missing erase ownership remains a render refusal, NOT a provider-format error',async()=>{
 const r=await initial(true);assert.equal(r.outcome.usable,false);assert.equal(r.outcome.code,'AI_ERASE_OWNERSHIP_INVALID');
 assert.deepEqual(policy.aiPageFailure(r.outcome),{code:'AI_ERASE_OWNERSHIP_INVALID',stage:'render'});
 assert(r.events.some(e=>e.event==='aiEraseOwnership'&&e.data.stage==='render'));
 assert.deepEqual(policy.aiPageFailure({usable:false}),{code:'AI_OUTPUT_INVALID',stage:'ai'});
 assert.deepEqual(policy.aiPageFailure({usable:true}),{code:'RENDER_FAILED',stage:'render'});
});
await test('unowned/foreign masks and stale repair rows are still refused; no unsafe fallback',async()=>{
 const r=await initial(),doc=r.raw.lensDocument;
 for(const boxes of [r.before.eraseBoxes.boxes.map(cleanGeometry),r.before.eraseBoxes.boxes.map(b=>({...b,p:'foreign'}))])
  assert.equal(erase.eraseBoxesForAiPartial(doc,{...r.before.eraseBoxes,boxes}).ok,false);
 const p=r.page,one=p.units.find(u=>u.id==='g1');
 for(const stale of [{sourceHash:'wrong',generationId:p.generationId},{sourceHash:one.sourceHash,generationId:'old'}]){
  const patch=buildPatchedResult(p,[{id:'R',unitId:'g1',translation:'ห้ามแทรก',...stale}]);assert(patch.missing.includes('g1'));
 }
});
await test('ownership failures are trace-only but named for UI; actual programming failures still warn',()=>{
 const warnings=[],events=[],log={warn:(...a)=>warnings.push(a)},trace=(...a)=>events.push(a);
 for(const code of ['AI_ERASE_OWNERSHIP_INVALID','repair_erase_conflict']){
  reportTranslationFailure(log,trace,'refusal',Object.assign(new Error('bad map'),{code}));
  assert(!/ไม่มีคำอธิบาย|AI แปลผลไม่ตรงรูปแบบ/.test(userMessageForCode(code)));
 }
 assert.equal(warnings.length,0);assert.equal(events.length,2);
 reportTranslationFailure(log,trace,'bug',new TypeError('bug'));assert.equal(warnings.length,1);
});
async function coordinatorCase({corrupt=true,ack=true,cancel=false}={}){
 let stored={},epoch=7,executions=0;const contexts=new Map(),rendered=[],events=[],deletes=[];
 const area={get:async k=>({[k]:structuredClone(stored[k])}),set:async v=>Object.assign(stored,structuredClone(v))};
 const sessions=createTranslationSessionStore({area:()=>area}),tabId=73033;
 const batch=ensureBatch(crypto.randomUUID(),tabId,0);batch.total1=2;
 const payloads=['bad','good'].map(id=>({engine:'extension',mode:'lens_text',source:'ai',lang:'th',src:`https://fixture.invalid/${id}`,metadata:{image_id:id}}));
 for(const payload of payloads)batch.items.set(payload.metadata.image_id,{attempt:1,status:'done',phase:'done',payload});
 const co=createRepairCoordinator({sessions,currentEpoch:()=>epoch,currentSession:()=> 's',getBase:async()=> 'http://fixture.invalid',getContext:id=>contexts.get(id),getCapabilitiesFor:async()=>({}),emit:(ev,d)=>events.push({ev,d}),
  api:async(_run,action,_body,opts)=>{if(opts?.method==='DELETE')deletes.push(action);return action==='seal'?{phase:'repairing',pending:[]}:{};},
  insert:async(_tab,msg)=>{if(msg.type!=='OVERLAY_HTML')return {ok:true,applied:true};rendered.push(msg);if(cancel)epoch++;return ack?{ok:true,applied:true}:{ok:true};},
  execute:async opt=>{executions++;const rows=[];
   for(const id of ['bad','good']){const p=await opt.getPage(id),u=p.units.find(u=>u.id==='g1');rows.push({id:`R-${id}`,pageId:id,unitId:u.id,generationId:p.generationId,sourceHash:u.sourceHash,translation:`ซ่อม ${id}`});}
   opt.onProgress({phase:'applying',repaired:2,unresolved:2,failedUnits:4});
   await opt.applyResults(rows);
   return {phase:'done',repaired:2,unresolved:2,failedUnits:4,initialAccepted:10,results:rows};
  }});
 const run=await co.registerBatch(batch,payloads);
 for(const payload of payloads){
  const id=payload.metadata.image_id,jobId=`gen-${id}`,d=decode(),raw=rawResult(d);if(corrupt&&id==='bad')raw.eraseBoxes.boxes=raw.eraseBoxes.boxes.map(cleanGeometry);
  const ctx={jobId,imageKey:id,tabId,frameId:0,imgUrl:payload.src,mode:'lens_text',source:'ai',generation:{pageInstanceId:'page'},traceId:`trace-${id}`};contexts.set(jobId,ctx);
  const units=translationUnits(d.document),accepted=units.filter(u=>u.translatable&&!['g0','g1'].includes(u.id)).map(u=>({id:u.id,text:'คำแปลเดิม'}));
  await co.capture(batch.id,{stage:'prepared',payload,result:raw,plan:{route:'direct-local',ai},units,jobId,operationId:`op-${id}`});
  await co.capture(batch.id,{stage:'finished',payload,jobId,accepted,failures:[{id:'g0',reason:'wrong_language'},{id:'g1',reason:'wrong_language'}]});
  await co.markDelivered(ctx,!(corrupt&&id==='bad'));
 }
 await co.finishInitial(batch);await sessions.flush();
 return {final:await sessions.get(run.id),co,batch,sessions,rendered,events,deletes,executions:()=>executions};
}
await test('one unsafe page cannot block other repaired pages, and terminates apply_failed not paused',async()=>{
 const r=await coordinatorCase();assert.equal(r.final.phase,'apply_failed');assert.equal(r.rendered.length,1);
 assert.equal(r.rendered[0].translationRun.pageId,'good');assert.equal(r.rendered[0].result.backgroundMode,'boxes');
 assert(!r.rendered[0].result.eraseBoxes.boxes.some(b=>b.p==='p0'));
 assert.equal(r.final.pages.good.delivered,true);assert.equal(r.final.pages.bad.delivered,false);
 assert.equal(r.final.summary.applyFailedPages,1);assert.equal(r.final.summary.appliedRepairedUnits,1);assert.equal(r.final.summary.unappliedRepairedUnits,1);
 assert.equal(r.final.pages.bad.patchError.code,'repair_erase_conflict');assert.equal(r.deletes.length,0,'unsafe saved results must not be deleted');
 assert(r.events.some(e=>e.ev==='repairPatch'&&e.d.pageId==='bad'&&e.d.code==='repair_erase_conflict'));
 assert(r.events.some(e=>e.ev==='repairProgress'&&e.d.phase==='apply_failed'&&e.d.placement?.applyFailedPages===1));
 const m=toasts.filter(m=>m.type==='TP_TOAST').at(-1);assert.equal(m.progress.active,false);assert.match(m.text,/could not be placed safely/);
 await r.co.resume();await r.co.finishInitial(r.batch);assert.equal(r.executions(),1,'no automatic provider rerun on wake-up');
});
await test('mixed permanent refusal and unconfirmed ACK retains apply_pending and both checkpoints',async()=>{
 const r=await coordinatorCase({ack:false});assert.equal(r.final.phase,'apply_pending');
 assert.equal(r.final.summary.applyFailedPages,1);assert.equal(r.final.summary.applyPendingPages,1);
 assert(r.final.pages.good.patchPending);assert(r.final.pages.bad.patchError);assert.equal(r.deletes.length,0);
});
await test('fixed decoder allows both partially repaired images to finish and releases only confirmed receipts',async()=>{
 const r=await coordinatorCase({corrupt:false});assert.equal(r.final.phase,'done');assert.equal(r.rendered.length,2);
 assert.equal(r.final.summary.appliedRepairedUnits,2);assert.equal(r.final.summary.applyFailedPages,0);assert.deepEqual(r.final.pages,{});assert.equal(r.deletes.length,1);
});
await test('cancellation during delivery never commits saved patches or cleans up as success',async()=>{
 const r=await coordinatorCase({corrupt:false,cancel:true});assert.equal(r.final.phase,'cancelled');
 assert(!r.events.some(e=>e.ev==='repairPatch'&&e.d.applied===true));assert.equal(r.deletes.length,0);
});

await test('real SQLite pool + executor completes partial repairs for two decoded pages after all answers',async()=>{
 const c=spawn('python',['-u',fileURLToPath(new URL('scripts/repair-ledger-fixture.py',root))],{stdio:['pipe','pipe','inherit'],cwd:fileURLToPath(root)}),q=[];
 createInterface({input:c.stdout}).on('line',line=>{const p=q.shift(),r=JSON.parse(line);if(p)r.ok?p.resolve(r.value):p.reject(new Error(r.code));});
 c.on('exit',code=>{for(const p of q.splice(0))p.reject(new Error('ledger exited '+code));});
 const api=(run,action='',body={})=>new Promise((resolve,reject)=>{q.push({resolve,reject});c.stdin.write(JSON.stringify({run,action,body})+'\n');});
 const run={id:'owned-partial-'+crypto.randomUUID(),token:'c'.repeat(64)},pages=new Map();let calls=0,applies=0;
 try{
  const r=await initial();assert.equal(r.outcome.usable,true,r.outcome.reason);
  for(const id of ['a','b']){const page=structuredClone(r.page);page.pageId=id;pages.set(id,page);}
  await api(run,'register',{manifest:[...pages.keys()]});
  for(const page of pages.values())await api(run,'pages',pageInitialReport(page));
  const snapshot=await api(run,'seal');assert.equal(snapshot.failedUnits,4);
  const rejectText=r.page.units.find(u=>u.id==='g0').text;
  const final=await executeRepairPool({run,snapshot,executor:'owner-regression',api,
    getPage:async id=>pages.get(id),resolveAi:async()=>ai,checkpointTask:async()=>{},onProgress:()=>{},
    planner:createWorkloadController({read:async()=>({}),write:async()=>{}}),withCapacity:async(_p,_a,_s,f)=>f(),
    translate:async units=>{calls++;return {translations:units.map(u=>({id:u.id,text:u.text===rejectText?'日本語のままです':'ซ่อมแล้วภาษาไทย'})),missing:[],meta:{finishReason:'stop'}};},
    applyResults:async rows=>{applies++;const saved=await api(run);assert.equal(saved.phase,'done');assert(calls>0);
      assert.equal(rows.length,2);
      for(const [id,p] of pages){const patch=buildPatchedResult(p,rows.filter(x=>x.pageId===id));assert.deepEqual(patch.missing,['g0']);
        assert(!patch.result.eraseBoxes.boxes.some(b=>b.p==='p0'));assert(patch.result.eraseBoxes.boxes.some(b=>b.p==='p1'));
        assert.equal(patch.result.lensDocument.paragraphs[2].aiText,r.raw.lensDocument.paragraphs[2].aiText);}
    }});
  assert.equal(final.repaired,2);assert.equal(final.unresolved,2);assert.equal(applies,1,'no mid-task DOM repair pass');
 }finally{c.stdin.end();}
});

console.log(JSON.stringify({scope:'real recorded Lens decode; provider/DOM ACK mocked',passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));
process.exitCode=results.some(r=>!r.pass)?1:0;
