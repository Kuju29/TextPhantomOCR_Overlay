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
import {refreshLocalAiCapabilities} from '../../local-ai-preflight.js';

const trace=(data,o)=>o.trace?.('conversationBatch',data,o.traceId);
export async function planConversationReady(rows,o,{
  refresh=refreshLocalAiCapabilities,open=workloadController.open,
}={}) {
  // A READY page may wait while the user reloads the exact same Local model
  // with a different window. Refresh before selecting units and carry this
  // snapshot through the matching transport; never plan from page-submission
  // settings or a five-minute UI snapshot.
  const planningAi=await refresh(o.ai,o.route,{signal:o.signal,traceId:o.traceId});
  const session=await open({ai:planningAi,route:o.route,sourceLang:o.sourceLang,targetLang:o.targetLang,
    image:!!o.imageDataUri,pageUnits:[],wholePageFirst:false,phase:'initial'});
  try{return {...session.nextReady(rows,o.conversationPageSizes||[],{
    continuation:o.conversationContinuation===true,
    cacheConfirmed:o.conversationCacheConfirmed===true,
    cacheRatio:Number(o.conversationCacheRatio)||0,
    cacheMissStreak:Number(o.conversationCacheMissStreak)||0,
    previousUnitCount:Number(o.conversationPreviousUnitCount)||0,
    previousTurnMs:Number(o.conversationPreviousTurnMs)||0}),session};}catch(e){await session.flush();throw e;}
}
const queue=createReadyQueue({trace,
  choose:planConversationReady,
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
        estimatedInput:estimate.estimatedInput,inputEstimateScale:estimate.inputEstimateScale,
        inputSampleCount:estimate.inputSampleCount,inputUnverified:estimate.inputUnverified,
        completionAvailable:estimate.completionAvailable,limits:estimate.limits};
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
      // observe() updates the in-memory profile immediately and persists it
      // itself; awaiting that write here would add an unrelated barrier before
      // the next serialized turn.
      void p.session.flush?.();
    }
  },
  // Learn this account's TP per image for the click-time credit check.
  afterRequest:recordPaidUsage(),
});
export function recordPaidUsage(record=recordPaidRequest) {
  return async function afterRequest({pages,answer,error,options}) {
    if(error||options?.ai?.provider!=='paid')return;
    const charged=Number(answer?.meta?.usage?.chargedTp);
    if(!Number.isSafeInteger(charged)||charged<0||!pages?.length)return;
    await record({apiBase:options.base,model:options.ai.model,chargedTp:charged,pages:pages.length});
  };
}
export const submitConversationPage=(units,options)=>queue.submit(units,options);

// Local Independent cross-page requests: OCR stays parallel,
// pages queue only for the AI request, in webpage order; each request is the
// full Independent prompt + whole ready pages while prompt + source + expected
// reply fit the live model window. Stateless: no history, examples refreshed
// from the store before each request and learned after its checkpoints.
import {localIndependentTicket,localIndependentTickets,onLocalIndependentReady,fenceLocalIndependentConfiguration} from './independent-order.js';
import {independentExampleStore,verifiedIndependentPairs} from '../independent-example-store.js';
import {planIndependentExamples} from '../independent-example-budget.js';
import {independentPromptMemory} from '../../series-memory.js';
import {recordPaidRequest} from '../../paid-credit-estimate.js';
export async function planIndependentReady(rows,o,{
  refresh=refreshLocalAiCapabilities,open=workloadController.open,store=independentExampleStore,
  memory=independentPromptMemory,
}={}) {
  const refreshed=await refresh(o.ai,o.route,{signal:o.signal,traceId:o.traceId});
  // Series memory is read when this request is planned (not when its first
  // page was queued), so it includes summaries accepted from earlier requests.
  const planningAi={...refreshed,...await memory(o.payload,String(o.ai?.memory_mode||'off'))};
  const session=await open({ai:planningAi,route:o.route,sourceLang:o.sourceLang,targetLang:o.targetLang,
    image:false,pageUnits:[],wholePageFirst:true,phase:'initial'});
  try {
    const pageSizes=o.conversationPageSizes||[];
    const next=()=>session.nextIndependentReady(rows,pageSizes);
    const scope=o.ai?.independent_scope;
    if(o.ai?.style_examples===true&&scope){
      const selection=await store.select(scope,String(o.targetLang||''),true);
      const examples=planIndependentExamples(session,rows,0,selection,next);
      return {...examples.chunk,session,examples};
    }
    return {...next(),session};
  } catch(e){await session.flush();throw e;}
}
const independentQueue=createReadyQueue({trace,mode:'independent',
  ordering:{ticketFor:localIndependentTicket,list:localIndependentTickets,onReady:onLocalIndependentReady,
    fenceConfiguration:fenceLocalIndependentConfiguration},
  choose:planIndependentReady,
  async dispatch(units,o,p) {
    const scope={operationId:p.batchId,profileId:p.session.key.slice(0,16),pageUnits:units.length};
    const budget=budgetDiagnostic(p,scope);budget.wholePage=p.wholePages===p.pageCount;
    o.trace?.('translationBudget',budget,o.traceId);
    rememberDiagnostic({...o.ai,operationId:p.batchId,budget});
    if(p.examples)o.trace?.('independentExamples',{schema:'tp.audit/1',event:'independent_examples',
      examplePhase:'selected',exampleSource:p.examples.selection?.source||'none',
      availableExamplePairs:p.examples.availableExamplePairs??0,includedExamplePairs:p.examples.includedExamplePairs??0,
      operationId:p.batchId,batchId:o.batchId},o.traceId);
    const recorder=createAiWireRecorder({enabled:aiWireTraceEnabled(o.capabilities,o.route),operationId:p.batchId,traceId:o.traceId,
      identity:{recordKind:'provider_request',attemptKind:'initial',route:o.route,provider:o.ai.provider,model:o.ai.model,
        parentOperationId:o.operationId,batchId:o.batchId,imageId:o.imageId,origins:p.origins},apiBase:o.base,
      relay:o.route==='direct-local'?o.capabilities?.aiWireTraceRelay:null});
    let answer,error;
    try {
      const estimate=p.estimate;
      const workload={version:1,predictedOutput:estimate.predictedOutput,reasoningReserve:estimate.reasoningReserve,
        estimatedInput:estimate.estimatedInput,inputEstimateScale:estimate.inputEstimateScale,
        inputSampleCount:estimate.inputSampleCount,inputUnverified:estimate.inputUnverified,
        completionAvailable:estimate.completionAvailable,limits:estimate.limits};
      // Whole pages: no neighbouring page context is needed (all units sent).
      const ai={...p.session.ai,workload,page_context:[]};
      await recorder?.('units',units);
      await recorder?.('contractSelection',{independentBatch:{batchId:p.batchId,origins:p.origins,pageCount:p.pageCount}});
      answer=await withRequestSlot({...o,unitCount:units.length},p.signal,()=>translateUnits(units,{...o,ai,operationId:p.batchId,signal:p.signal,onProgress:p.onProgress,wireTrace:recorder}));
      return answer;
    } catch(e){error=e;throw e;}
    finally {
      const scripts=answer?diagnoseTargetScripts(answer.translations||[],o.targetLang,units):[];
      const observed=p.session.observe({units,answer,error,plan:p.estimate,
        defects:{missing:answer?.missing||[],wrongLanguage:scripts.filter(x=>x.decision==='reject').map(x=>x.id)}});
      const result=resultDiagnostic(observed,{...scope,error});
      o.trace?.('translationResult',result,o.traceId);
      rememberDiagnostic({...o.ai,operationId:p.batchId,result});
      await recorder?.('validation',{missingIds:answer?.missing||[],wrongLanguageIds:scripts.filter(x=>x.decision==='reject').map(x=>x.id),
        mappingScope:'current_batch',pageCount:p.origins.length});
      await recorder?.('terminal',{state:error?'failed':'succeeded',stage:'response_mapping',terminal:true,
        code:String(error?.code||''),placementStatus:'page_projection_pending'});
      await recorder?.flush?.(1500);
      void p.session.flush?.();
    }
  },
  afterRequest:learnIndependentExamples(),
});
// Story examples learn only verified pairs, after every page checkpoint.
export function learnIndependentExamples(store=independentExampleStore) {
  return async function afterRequest({picked,answer,error,options}) {
    const scope=options.ai?.independent_scope;
    if(error||!answer||options.ai?.style_examples!==true||!scope)return;
    const units=picked.map(({id,text})=>({id,text}));
    const scripts=diagnoseTargetScripts(answer.translations||[],options.targetLang,units);
    const learned=verifiedIndependentPairs(units,answer,{missing:answer.missing||[],
      wrongLanguage:scripts.filter(x=>x.decision==='reject').map(x=>x.id)},String(options.targetLang||''));
    const persisted=learned.length?await store.append(scope,learned):{accepted:null};
    options.trace?.('independentExamples',{schema:'tp.audit/1',event:'independent_examples',
      examplePhase:'after_checkpoint',sampleCandidates:learned.length,
      ...(Number.isFinite(persisted?.accepted)?{poolPairs:persisted.accepted}:{}),batchId:options.batchId},options.traceId);
  };
}
export const submitIndependentPage=(units,options)=>independentQueue.submit(units,options);
