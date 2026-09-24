import { batchUpdateToast, batchStopKeepAlive, persistBatchProgressSoon } from './batches.js';
import { requestFromTabExact } from './tabs-messaging.js';
import { forgetReaderAcquisition } from './reader-acquisition.js';
const releasing = new WeakMap();

// Called only by the existing batch/repair terminal boundary. An insertion ACK
// to the worker is not a prerequisite for processing completion. Ready-first
// display is already enabled and cannot complete a batch/repair early.
export async function releaseReaderBatch(batch, {replayReceipts=false}={}) {
  if (!batch?.reader || batch.cancelled) return false;
  if (!replayReceipts && batch.reader.released && batch.reader.processingComplete) return true;
  if (releasing.has(batch)) return releasing.get(batch);
  const work=(async()=>{
    if (['collecting','repairing','repair_request','repair_wave','applying','blocked','repair_circuit_open'].includes(batch.repair?.phase)) return false;
    batch.reader.processingComplete=true;
    const receipt=await requestFromTabExact(batch.tabId,{type:'TP_READER_RELEASE',readerRunId:batch.reader.runId},batch.frameId);
    if(batch.cancelled)return false;
    batch.reader.released=receipt?.released === true;
    batch.completedAt=Date.now();batch.lifecycle='completed';
    forgetReaderAcquisition(batch.reader.runId);
    batchUpdateToast(batch,batch.reader.released ? 'Processing complete; unmounted results remain available'
      : 'Processing complete; reader placement unavailable',true);
    await batchStopKeepAlive(batch);
    return batch.reader.released;
  })();
  releasing.set(batch,work);
  try {return await work;} finally {releasing.delete(batch);}
}

export async function completeBatch(batch,label,repairCoordinator) {
  if(batch.cancelled)return;
  const owned=await repairCoordinator.finishInitial(batch);
  if(batch.reader)await releaseReaderBatch(batch);
  else if(!owned || ['done','apply_failed','unavailable'].includes(batch.repair?.phase)){
    batch.lifecycle='completed';batch.completedAt=Date.now();
    persistBatchProgressSoon();
  }
  if(!owned){
    batchUpdateToast(batch,batch.repair?.phase==='unavailable'
      ? `${label}; repair unavailable: ${batch.repair.code || 'API/session error'}` : label,true);
    await batchStopKeepAlive(batch);
  }
}
