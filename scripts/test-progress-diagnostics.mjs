// Actual batch -> page toast state; fake time and DOM only, no timers or live provider.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
const root=pathToFileURL(`${process.env.TP_TEST_ROOT || process.cwd()}/`);
const messages=[];
globalThis.chrome={runtime:{get lastError(){return null;},sendMessage(_m,cb){cb?.();}},
 tabs:{sendMessage(_t,m,_opts,cb){messages.push(m);cb?.({ok:true});}}};
const {ensureBatch,batchUpdateToast,serializeBatchSnapshot,restoreBatchSnapshot}=await import(new URL('src/background/batches.js',root));
let now=Date.now(),seq=0;const timers=new Map(),nodes=[];
class Clock extends Date {static now(){return now;}}
const TP={pageInstanceId:'page-a'};
const document={createElement(){return {style:{},textContent:''};},documentElement:{appendChild(el){nodes.push(el);}}};
vm.runInNewContext(readFileSync(new URL('src/content/dom-utils.js',root),'utf8'),{window:{__TP:TP},document,Date:Clock,URL,location:{href:'https://fixture.invalid'},
 setTimeout(fn,ms){timers.set(++seq,{at:now+ms,fn});return seq;},clearTimeout(id){timers.delete(id);}});
function tick(ms){now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}}
const results=[];
async function check(name,fn){try{await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.stack});}}
const b=ensureBatch('repair-progress',23,0);b.total1=10;
for(let i=0;i<10;i++)b.items.set(`i${i}`,{attempt:1,status:'done',phase:'done',payload:{generation:{pageInstanceId:'page-a'}}});
function send(phase,label){b.repair={phase,label};batchUpdateToast(b,label,true);const m=messages.filter(x=>x.type==='TP_TOAST').at(-1);TP.showToast(m.text,m.ms,m.progress);return m;}
await check('10/10 initial is not terminal while repairing; stays visible for 180s',()=>{
 const m=send('repairing','Repairing 34 unit(s); 15 fixed');assert.equal(m.progress.active,true);tick(180000);
 assert.equal(nodes[0].style.display,'block');assert.match(nodes[0].textContent,/Repairing 34/);assert.equal(timers.size,0);
});
await check('transient messages cannot replace or hide a running repair',()=>{
 TP.showToast('Connection refreshed',800);tick(90000);assert.match(nodes[0].textContent,/Repairing 34/);assert.equal(nodes[0].style.display,'block');
});
await check('apply phase remains active until final ACK',()=>{send('applying','Placing repair results');tick(90000);assert.equal(nodes[0].style.display,'block');assert.match(nodes[0].textContent,/Placing repair/);});
await check('blocked or pending delivery is persistent and visibly distinguished',()=>{for(const phase of ['blocked','apply_pending']){send(phase,`Repair ${phase}`);tick(90000);assert.equal(nodes[0].style.display,'block');assert.match(nodes[0].textContent,new RegExp(phase));}});
await check('another completed batch cannot hide an active run',()=>{
 TP.showToast('Other run done',800,{batchId:'other',sequence:1,active:false,startedAt:b.createdAt});tick(3000);assert.match(nodes[0].textContent,/apply_pending/);assert.equal(nodes[0].style.display,'block');
});
await check('completion clears only its run and allows terminal summary to expire',()=>{
 const m=send('done','Repair complete');assert.equal(m.progress.active,false);tick(3000);assert.equal(nodes[0].style.display,'none');
 TP.showToast('late packet',2400,{...m.progress,sequence:m.progress.sequence-1,active:true});assert.equal(nodes[0].style.display,'none');
});
await check('progress sequence survives worker checkpoint restore',()=>{
 const snap=serializeBatchSnapshot(b);assert.ok(snap.progressSequence>0);
 const restored=restoreBatchSnapshot(snap);assert.equal(restored.progressSequence,b.progressSequence);
 batchUpdateToast(restored,'done',true);assert.ok(messages.filter(m=>m.type==='TP_TOAST').at(-1).progress.sequence>snap.progressSequence);
});
await check('navigation clears status and rejects stale page/run packets',()=>{
 send('repairing','Repair old page');TP.clearToasts();TP.pageInstanceId='page-b';
 assert.equal(nodes[0].style.display,'none');TP.showToast('stale',2400,{batchId:b.id,sequence:99,active:true,startedAt:b.createdAt,pageInstanceId:'page-a'});
 assert.equal(nodes[0].style.display,'none');TP.showToast('restored old packet',2400,{batchId:b.id,sequence:100,active:true,startedAt:b.createdAt});assert.equal(nodes[0].style.display,'none');
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
console.log(JSON.stringify({schema:'tp.progress-diagnostics/1',passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results},null,2));
process.exitCode=results.some(x=>!x.pass)?1:0;
