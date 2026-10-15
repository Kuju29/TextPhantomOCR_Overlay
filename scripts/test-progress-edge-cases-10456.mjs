// Independent actual-batches reviewer regression. Fake chrome message boundary
// only; no provider/Center/browser/account calls and no production mutations.
import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolve,dirname,basename} from 'node:path';
const testDirectory=dirname(fileURLToPath(import.meta.url));
const appRoot=resolve(process.env.TP_REVIEW_APP_ROOT || (basename(testDirectory)==='scripts'?resolve(testDirectory,'..'):'inspection/v56/TextPhantom'));
const sent=[];let httpRequests=0;
globalThis.fetch=async()=>{httpRequests++;throw new Error('Reader ACK must not dispatch an HTTP/provider request');};
globalThis.chrome={runtime:{lastError:null,sendMessage(...args){args.find(x=>typeof x==='function')?.({ok:true});}},tabs:{sendMessage(tab,message,...args){sent.push(message);args.find(x=>typeof x==='function')?.({ok:true});}}};
const batches=await import(pathToFileURL(resolve(appRoot,'src/background/batches.js')));
const {handleReaderReceipt}=await import(pathToFileURL(resolve(appRoot,'src/background/reader-events.js')));
const {createImageProgress}=await import(pathToFileURL(resolve(appRoot,'src/background/progress/image-progress-store.js')));
let sequence=0;const outcomes=[];
const make=()=>{const b=batches.ensureBatch('fixture-'+(++sequence),17,0);b.lifecycle='processing';b.total1=1;b.items.set('p',{status:'done',phase:'done',attempt:1,phaseAt:Date.now(),progress:createImageProgress(),presentation:{},payload:{generation:{pageInstanceId:'fixture-page'}}});return b;};
async function run(name,fn){try{await fn();outcomes.push({name,passed:true});}catch(error){outcomes.push({name,passed:false,error:error.message});}}
await run('late reader ACK cannot turn unresolved terminal repair into successful Result',()=>{
 const b=make();batches.updateImagePresentation(b.id,'p',{repairPhase:'done',pending:2});
 assert.equal(b.items.get('p').progress.result.state,'error');
 batches.updateImagePresentation(b.id,'p',{placementPending:false,placementConfirmed:true,insertionAck:{present:true}});
 const r=b.items.get('p').progress.result;assert.equal(r.state,'error');assert.match(r.detail,/2 unresolved/);
});
for(const phase of ['blocked','unavailable','apply_failed'])await run(phase+' does not reopen saved-placement timers',()=>{
 const b=make();batches.updateImagePresentation(b.id,'p',{placementPending:true,repairPhase:'apply_pending'});
 batches.updateImagePresentation(b.id,'p',{repairPhase:phase});
 const p=b.items.get('p').progress;for(const n of ['overall','insert'])assert.ok(!['queued','running'].includes(p[n].state),n+' unexpectedly '+p[n].state);
 assert.equal(p.result.state,'error');assert.equal(b.items.get('p').presentation.placementPending,true,'recovery placement retained');
});
await run('paused repair legacy toast gives up active message ownership',()=>{
 const b=make();b.reader={processingComplete:false};b.repair={phase:'blocked'};const before=sent.length;
 batches.batchToast(b,'Repair paused',2000,true);const msg=sent.slice(before).find(x=>x.type==='TP_TOAST');assert.ok(msg);assert.equal(msg.progress.active,false);
});
await run('genuine saved placement remains active while awaiting DOM ACK',()=>{
 const b=make();batches.updateImagePresentation(b.id,'p',{placementPending:true,repairPhase:'apply_pending'});
 const p=b.items.get('p').progress;assert.equal(p.overall.state,'running');assert.equal(p.insert.state,'queued');assert.equal(p.result.state,'pending');
});
await run('complete repair reader ACK keeps successful Result',()=>{
 const b=make();batches.updateImagePresentation(b.id,'p',{repairPhase:'done',pending:0});
 batches.updateImagePresentation(b.id,'p',{placementPending:false,placementConfirmed:true,insertionAck:{present:true}});assert.equal(b.items.get('p').progress.result.state,'done');
});
await run('actual late reader-events ACK preserves unresolved Result.error',async()=>{
 const b=make();b.reader={runId:'fixture-reader-'+sequence,pageInstanceId:'fixture-page',processingComplete:false};const item=b.items.get('p');item.payload.reader={pageId:'reader-page'};item.payload.context={};
 batches.updateImagePresentation(b.id,'p',{repairPhase:'done',pending:2,placementPending:true});
 const ack=await handleReaderReceipt({type:'TP_READER_PLACED',readerRunId:b.reader.runId,pageInstanceId:'fixture-page',pageId:'reader-page',kind:'OVERLAY_HTML',drawn:true,provisional:false},{tab:{id:17},frameId:0},()=>assert.fail('Receipt must not cancel the active reader owner'));
 assert.equal(ack.ok,true);assert.equal(item.presentation.placementPending,false);assert.equal(item.presentation.insertionAck.present,true);assert.equal(item.progress.result.state,'error');assert.match(item.progress.result.detail,/2 unresolved/);assert.equal(httpRequests,0,'Reader ACK confirms display only; no HTTP or provider dispatch');
});
const readerOwner=(pending=0)=>{
 const b=make();b.reader={runId:'fixture-reader-'+sequence,pageInstanceId:'fixture-page',processingComplete:false};
 const item=b.items.get('p');item.payload.reader={pageId:'reader-page'};item.payload.context={};
 batches.updateImagePresentation(b.id,'p',{repairPhase:'done',pending,placementPending:true});
 return {b,item,message:{type:'TP_READER_PLACED',readerRunId:b.reader.runId,pageInstanceId:'fixture-page',pageId:'reader-page',kind:'OVERLAY_HTML',drawn:true,provisional:false}};
};
const receive=message=>handleReaderReceipt(message,{tab:{id:17},frameId:0},()=>assert.fail('Placement receipt must not discard the reader owner'));
await run('actual provisional reader ACK preserves unresolved Result.error',async()=>{
 const {item,message}=readerOwner(2);message.provisional=true;const ack=await receive(message);
 assert.equal(ack.ok,true);assert.equal(item.presentation.placementConfirmed,false);assert.equal(item.presentation.insertionAck.present,true);assert.equal(item.presentation.insertionAck.provisional,true);
 assert.equal(item.progress.result.state,'error');assert.match(item.progress.result.detail,/2 unresolved/);assert.equal(httpRequests,0);
});
await run('actual reader placement failure remains Insert.error and Result.error after successful DOM receipt',async()=>{
 const {item,message}=readerOwner(0);const first=await receive(message);assert.equal(first.ok,true);assert.equal(item.progress.insert.state,'done');assert.equal(item.progress.result.state,'done');const ack=await receive({...message,type:'TP_READER_PLACEMENT_FAILED',error:'Synthetic DOM placement failed'});
 assert.equal(ack.ok,false);assert.equal(item.presentation.placementPending,false);assert.equal(item.progress.insert.state,'error');assert.equal(item.progress.result.state,'error');assert.match(item.progress.result.detail,/Synthetic DOM placement failed/);assert.equal(httpRequests,0);
});
await run('actual full-success reader ACK keeps Result.done',async()=>{
 const {item,message}=readerOwner(0);const ack=await receive(message);
 assert.equal(ack.ok,true);assert.equal(item.presentation.placementConfirmed,true);assert.equal(item.presentation.insertionAck.present,true);assert.equal(item.progress.result.state,'done');assert.equal(httpRequests,0);
});
await run('actual IMAGE_ERROR reader ACK is not hidden by prior full repair success',async()=>{
 const {item,message}=readerOwner(0);const ack=await receive({...message,kind:'IMAGE_ERROR',drawn:false});
 assert.equal(ack.ok,true);assert.equal(item.presentation.placementConfirmed,false);assert.equal(item.presentation.insertionAck.present,false);assert.equal(item.progress.insert.state,'error');assert.equal(item.progress.result.state,'error');assert.equal(httpRequests,0);
});
console.log(JSON.stringify({appRoot,scope:'actual batches APIs; synthetic chrome message boundary; no live calls',passed:outcomes.filter(x=>x.passed).length,total:outcomes.length,outcomes},null,2));
process.exitCode=outcomes.every(x=>x.passed)?0:1;
