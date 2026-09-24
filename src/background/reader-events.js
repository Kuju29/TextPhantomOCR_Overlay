import { batchesForTab, getBatch, batchMark, batchUpdateToast, updateImagePresentation, batchStopKeepAlive } from './batches.js';
import { repairCoordinator } from './repair/coordinator.js';
import { getTabSessionId } from './tab-sessions.js';
import { requestFromTabExact } from './tabs-messaging.js';
import { forgetReaderAcquisition } from './reader-acquisition.js';
import * as wf from './workflow-track.js';
import { createLogger } from '../shared/logger.js';
const log = createLogger('SW.reader');
// Content is reporting only placement of a result already owned by this batch.
// No path here schedules an image or calls AI.
export async function handleReaderReceipt(message, sender, discardBatchResults) {
  const batch=batchesForTab(sender?.tab?.id).find(b=>b.reader?.runId===message.readerRunId &&
    b.frameId===(sender.frameId || 0) && !b.cancelled);
  if(!batch || (message.pageInstanceId && batch.reader.pageInstanceId!==message.pageInstanceId))return {ok:true,stale:true};
  if(message.type==='TP_READER_CANCELLED'){
    log.warn('reader cancellation receipt', {tabId:batch.tabId,batchId:batch.id,
      runId:batch.reader.runId,reason:String(message.reason || 'reader_cancelled').slice(0,80)});
    discardBatchResults(batch.id,message.reason || 'reader_cancelled');return {ok:true};
  }
  const entry=[...batch.items].find(([,item])=>String(item.payload?.reader?.pageId)===String(message.pageId));
  if(!entry)return {ok:true,stale:true};
  const [key,item]=entry, session=item.payload?.context?.tp_tab_session;
  if(session && session!==getTabSessionId(batch.tabId))return {ok:true,stale:true};
  if(message.type==='TP_READER_PLACEMENT_FAILED'){
    updateImagePresentation(batch.id,key,{placementPending:false,placementConfirmed:false,
      progressEvent:{lane:'insert',state:'error',resultState:'error',detail:message.error || 'Reader placement failed'}});
    batchUpdateToast(batch,'Reader placement failed',true);return {ok:false};
  }
  updateImagePresentation(batch.id,key,{placementPending:false,placementConfirmed:message.kind!=='IMAGE_ERROR' && !message.provisional,
    insertionAck:{present:message.drawn===true,provisional:message.provisional===true,acknowledgedAt:Date.now()},
    progressEvent:{lane:'insert',state:message.kind==='IMAGE_ERROR'?'error':'done',
      resultState:message.kind==='IMAGE_ERROR'?'error':message.drawn?'done':'skipped',detail:'Reader placement confirmed'}});
  if(!message.provisional && message.kind!=='IMAGE_ERROR'){
    await wf.confirmPlacement(item.workflowId);
    if(message.translationRun?.phase==='initial')
      await repairCoordinator.markDelivered({translationRun:message.translationRun},true);
    await repairCoordinator.confirmDeferredPlacement(batch,message);
  }
  batchUpdateToast(batch,message.kind==='IMAGE_ERROR'?'Image error':'Translation placed',true);
  return {ok:true};
}

export function cancelTrackedBatches(tabId,reason,discard) {
  const ids=new Set();
  for(const batch of batchesForTab(tabId)) {
    if(batch.cancelled || (batch.completedAt && !batch.reader))continue;
    ids.add(batch.id);discard(batch.id,reason);
  }
  return ids;
}
export function cancelBatchState(batch,reason) {
  batch.cancelled=true;batch.cancelRequestedAt=Date.now();
  batch.completedAt=Date.now();batch.lifecycle='cancelled';
  if(batch.repair)batch.repair={...batch.repair,phase:'cancelled'};
  for(const [key,item] of batch.items) if(item.presentation?.placementPending)
    batchMark(batch.id,key,{phase:'cancelled',status:'aborted',lastError:reason,
      presentation:{...item.presentation,placementPending:false}});
  if(batch.reader){
    forgetReaderAcquisition(batch.reader.runId);
    void requestFromTabExact(batch.tabId,{type:'TP_READER_CANCEL',readerRunId:batch.reader.runId,reason},batch.frameId);
  }
}
