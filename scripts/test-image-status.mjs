import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const packets=[],disk={};
globalThis.chrome={
  runtime:{lastError:null,sendMessage:(_m,cb)=>cb?.(),getManifest:()=>({version:'test'})},
  tabs:{sendMessage:(tab,msg,opt,cb)=>{if(msg.type==='TP_IMAGE_STATUS')packets.push({tab,msg,opt});cb?.();}},
  storage:{local:{get:(k,cb)=>cb({...k,...disk}),set:(v,cb)=>{Object.assign(disk,v);cb?.();}}}
};
const {ensureBatch,batchMark,updateImagePresentation,serializeBatchSnapshot,restoreBatchSnapshot}=await import('../src/background/batches.js');
const batch=ensureBatch('b1234567-1234-1234-1234-123456789abc',51,3),key='p0';
batch.items.set(key,{phase:'waiting',status:'queued',attempt:1,payload:{engine:'extension',src:'https://fixture.invalid/page.png',frameId:3,generation:{pageInstanceId:'fixture-page'},context:{tp_trace:'tabcdefgh123'}}});

// Presentation state still belongs to the batch/checkpoint owner because repair,
// accounting and future UI may need it. It simply must not create per-image
// progress packets or DOM work in the current product policy.
batchMark(batch.id,key,{phase:'ai_generating'});
updateImagePresentation(batch.id,key,{total:12,applied:0,accepted:0,pending:12,phase:'usage_pending',provider:'openrouter',model:'fixture',contract:'json_schema_object_v1'});
updateImagePresentation(batch.id,key,{phase:'http_wait',batchIndex:1,unitCount:5});
updateImagePresentation(batch.id,key,{accepted:10,pending:2});
updateImagePresentation(batch.id,key,{applied:10,repairPhase:'collecting'});
batchMark(batch.id,key,{phase:'done'});
updateImagePresentation(batch.id,key,{repairPhase:'repairing'});
updateImagePresentation(batch.id,key,{repairPhase:'applying'});
updateImagePresentation(batch.id,key,{repairPhase:'done',applied:11,accepted:11,pending:1,wrongLanguageCount:1});
assert.equal(packets.length,0,'normal/repair progress must never emit a per-image status packet');
const restored=restoreBatchSnapshot(serializeBatchSnapshot(batch));
assert.equal(restored.items.get(key).presentation.applied,11,'batch owner still persists presentation data');
assert.equal(restored.items.get(key).presentation.wrongLanguageCount,1);

batch.cancelled=true;
updateImagePresentation(batch.id,key,{phase:'http_wait'});
assert.equal(packets.length,0);
const exportAt=process.argv.indexOf('--packets');
if(exportAt>=0)writeFileSync(process.argv[exportAt+1],JSON.stringify(packets,null,2));
console.log('PASS per-image progress UI disabled: batch state remains durable and no TP_IMAGE_STATUS packets are emitted.');
