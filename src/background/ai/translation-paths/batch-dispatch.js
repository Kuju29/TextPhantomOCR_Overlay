// Only Conversation's prepared data enters this queue. Transport, validation,
// receipt accounting and page rendering remain the original shared components.
import {createReadyQueue} from './ready-queue.js';
import {workloadController} from '../workload-controller.js';
import {translateUnits} from '../translation-service.js';
import {diagnoseTargetScripts} from '../script-diagnostics.js';
import {createAiWireRecorder,aiWireTraceEnabled} from '../wire-trace.js';
import {budgetDiagnostic,resultDiagnostic} from '../../../shared/ai/request-diagnostics.js';
import {rememberDiagnostic} from '../recent-diagnostics.js';
import {withRequestSlot} from './request-slot.js';

const trace=(data,o)=>o.trace?.('conversationBatch',data,o.traceId);
const queue=createReadyQueue({trace,
  async choose(rows,o) {
    const planningAi=o.ai;
    const session=await workloadController.open({ai:planningAi,route:o.route,sourceLang:o.sourceLang,targetLang:o.targetLang,
      image:!!o.imageDataUri,pageUnits:[],wholePageFirst:false,phase:'initial'});
    try{return {...session.nextReady(rows,o.conversationPageSizes||[],{
      continuation:o.conversationContinuation===true,
      cacheConfirmed:o.conversationCacheConfirmed===true,
      cacheRatio:Number(o.conversationCacheRatio)||0,
      cacheMissStreak:Number(o.conversationCacheMissStreak)||0,
      previousUnitCount:Number(o.conversationPreviousUnitCount)||0,
      previousTurnMs:Number(o.conversationPreviousTurnMs)||0}),session};}catch(e){await session.flush();throw e;}
  },
  async dispatch(units,o,p) {
    const scope={operationId:p.batchId,profileId:p.session.key.slice(0,16),pageUnits:units.length};
    const budget=budgetDiagnostic(p,scope);budget.wholePage=false;
    o.trace?.('translationBudget',budget,o.traceId);
    rememberDiagnostic({...o.ai,operationId:p.batchId,budget});
    const recorder=createAiWireRecorder({enabled:aiWireTraceEnabled(o.capabilities,o.route),operationId:p.batchId,traceId:o.traceId,
      identity:{recordKind:'provider_request',attemptKind:'initial',route:o.route,provider:o.ai.provider,model:o.ai.model,
        parentOperationId:o.operationId,batchId:o.batchId,imageId:o.imageId,origins:p.origins},apiBase:o.base,
      relay:o.route==='direct-local'?o.capabilities?.aiWireTraceRelay:null});
    let answer,error;
    try {
      const estimate=p.estimate;
      const workload={version:1,predictedOutput:estimate.predictedOutput,reasoningReserve:estimate.reasoningReserve,
        estimatedInput:estimate.estimatedInput,completionAvailable:estimate.completionAvailable,limits:estimate.limits};
      const ai={...p.session.ai,workload,page_context:[],conversation:{...o.ai.conversation,
        planner:'conversation_cross_page',batchId:p.batchId,origins:p.origins}};
      await recorder?.('units',units);
      await recorder?.('contractSelection',{conversationBatch:{batchId:p.batchId,origins:p.origins}});
      answer=await withRequestSlot({...o,unitCount:units.length},p.signal,()=>translateUnits(units,{...o,ai,operationId:p.batchId,signal:p.signal,onProgress:p.onProgress,wireTrace:recorder}));
      return answer;
    } catch(e){error=e;throw e;}
    finally {
      const scripts=answer?diagnoseTargetScripts(answer.translations||[],o.targetLang,units):[];
      const observed=p.session.observe({units,answer,error,plan:p.estimate,
        defects:{missing:answer?.missing||[],wrongLanguage:scripts.filter(x=>x.decision==='reject').map(x=>x.id)}});
      const result=resultDiagnostic(observed,{...scope,error});
      o.trace?.('translationResult',result,o.traceId);
      rememberDiagnostic({...o.ai,operationId:p.batchId,result,conversation:answer?.meta?.conversation,layout:answer?.meta?.promptLayout,coordination:answer?.meta?.cacheCoordination});
      await recorder?.('validation',{missingIds:answer?.missing||[],wrongLanguageIds:scripts.filter(x=>x.decision==='reject').map(x=>x.id),
        mappingScope:'current_batch',pageCount:p.origins.length});
      await recorder?.('terminal',{state:error?'failed':'succeeded',stage:'response_mapping',terminal:true,
        code:String(error?.code||''),placementStatus:'page_projection_pending'});
      await recorder?.flush?.(1500);
      // observe() updates the in-memory profile immediately and starts durable
      // persistence itself. Waiting for that storage write here inserted an
      // unrelated post-provider barrier before the next serialized turn.
      // Later requests already see the updated in-memory profile.
      void p.session.flush?.();
    }
  }
});
export const submitConversationPage=(units,options)=>queue.submit(units,options);
