// Admission for one combined request, not for each page waiting in a batch.
import {acquire,releaseSuccess,releaseFailed,releaseDeferred,releaseRejected,releaseLocalFailure,laneKeyFor,
  configureLocalCapacityForPayload,setLaneUnlimited} from '../../scheduler.js';
import {summarizeExecutionTiming,providerLearningSample} from '../../../shared/ai/execution-timing.js';
import {isInstallRateLimited,installRetryDelayMs,INSTALL_RETRY_BUDGET_MS,beginInstallWait} from '../../transports/install-header.js';
export async function withRequestSlot(options,signal,work) {
  const key=laneKeyFor(options.payload),local=configureLocalCapacityForPayload(options.payload);
  if(!local)setLaneUnlimited(key,false);
  const started=performance.now();let attempts=0;
  // An install-limit wait (shown in the page status) lasts until this
  // request gets its slot again and is sent.
  let endInstallWait=null;
  try{
  while(true){
    const slot=await acquire(key,signal);attempts++;
    endInstallWait?.();endInstallWait=null;
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
      // The shared API limited this browser install (429 + Retry-After)
      // before any work. Wait the given time (≤ 60 s) and send the same
      // operation again, within a total budget; then the error is shown.
      if(isInstallRateLimited(error) && error?.requestDispatched!==true &&
        Number(error?.generationAttempts||error?.providerAttempts||0)===0 &&
        !signal?.aborted && performance.now()-started<INSTALL_RETRY_BUDGET_MS){
        const delay=installRetryDelayMs(error);
        releaseDeferred(key,delay);
        endInstallWait=beginInstallWait(delay);
        options.trace?.('conversationAdmission',{schema:'tp.audit/1',event:'capacity_changed',reason:'install_rate_limited',
          timing:{queueMs:slot?.waitMs},counts:{attempts}},options.traceId);
        continue;
      }
      if(safe && !signal?.aborted && performance.now()-started<120000){
        const delay=Math.max(100,Math.min(10000,Number(error.retryAfterMs)||250));
        releaseDeferred(key,delay);
        options.trace?.('conversationAdmission',{schema:'tp.audit/1',event:'capacity_changed',reason:'server_busy',
          timing:{queueMs:slot?.waitMs},counts:{attempts}},options.traceId);
        continue;
      }
      if(String(error?.code||'')==='api_rate_gate_timeout' &&
        Number(error?.generationAttempts||error?.providerAttempts||0)===0)
        releaseDeferred(key,Math.max(1000,Math.min(30000,Number(error?.retryAfterMs)||1000)));
      else if(local)releaseLocalFailure(key,error,Math.max(100,Number(error?.retryAfterMs)||250));
      else if(String(error?.code||'')==='provider_rate_limited' ||
        (error?.requestDispatched===true && Number(error?.upstreamStatus)===429))
        releaseRejected(key,Math.max(1000,Math.min(300000,Number(error?.retryAfterMs)||5000)));
      else releaseFailed(key);
      throw error;
    }
  }
  }finally{endInstallWait?.();}
}
