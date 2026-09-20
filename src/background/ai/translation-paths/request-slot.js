// Admission for one combined request, not for each page waiting in a batch.
import {acquire,releaseSuccess,releaseFailed,releaseDeferred,releaseLocalFailure,laneKeyFor,
  configureLocalCapacityForPayload,setLaneUnlimited} from '../../scheduler.js';
import {summarizeExecutionTiming,providerLearningSample} from '../../../shared/ai/execution-timing.js';
export async function withRequestSlot(options,signal,work) {
  const key=laneKeyFor(options.payload),local=configureLocalCapacityForPayload(options.payload);
  if(!local)setLaneUnlimited(key,false);
  const started=performance.now();let attempts=0;
  while(true){
    const slot=await acquire(key,signal);attempts++;
    try {
      const answer=await work();
      const timing=summarizeExecutionTiming([answer]);
      releaseSuccess(key,providerLearningSample(timing,{repaired:false}),{sampleWindow:slot?.window,
        sampleWorkload:{unitCount:options.unitCount||0}});
      return answer;
    }catch(error){
      // This retries admission only when the API explicitly made no generation.
      // The operation ID remains unchanged. A dispatched/unknown failure is final.
      const safe=error?.requestDispatched!==true && Number(error?.generationAttempts||error?.providerAttempts||0)===0 &&
        ['rate_gate_busy','local_rate_gate_busy','server_busy'].includes(String(error?.code||''));
      if(safe && !signal?.aborted && performance.now()-started<120000){
        const delay=Math.max(100,Math.min(10000,Number(error.retryAfterMs)||250));
        releaseDeferred(key,delay);
        options.trace?.('conversationAdmission',{schema:'tp.audit/1',event:'capacity_changed',reason:'server_busy',
          timing:{queueMs:slot?.waitMs},counts:{attempts}},options.traceId);
        continue;
      }
      if(local)releaseLocalFailure(key,error,Math.max(100,Number(error?.retryAfterMs)||250));else releaseFailed(key);
      throw error;
    }
  }
}
