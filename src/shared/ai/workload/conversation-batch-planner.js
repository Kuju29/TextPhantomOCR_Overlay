import { conversationBatchProfile } from '../conversation/batch-policy.js';
import { observedReasoningRisk, estimateRequest, takeWorkloadBatch } from './model.js';
// Retain an absolute source bound, above the ordinary 8K output window's
// marker capacity. A short-text vertical page must not lose its place merely
// because eight images contain more than 128 independent OCR records.
const MAX_SOURCE_UNITS=512, MAX_SOURCE_CHARS=58000;

// Main and repair share content/context limits. Ready pages stay whole unless
// a hard limit requires a split; repair rows can span original source pages.
// Exact chat composition owns history retention. Do not turn estimated history
// or provider latency into another source-unit admission gate.
export function planConversationBatch({ rows, pageSizes = [], conversationState = {},
  profileSnapshot, context, capabilities: caps, estimateFixedInput,
  sourceContext, sourceContextForUnits, contract, planningDecision }) {
  const liveProfile=profileSnapshot;
  const reasoningUnbounded=context.reasoningActive===true&&caps?.reasoning?.supports_max_tokens!==true;
  const profile=conversationBatchProfile(liveProfile,{...conversationState,
    limits:context.limits,userMaxOutput:context.userMaxOutput,reasoningUnbounded,
    reasoningRisk:context.reasoningActive===true||observedReasoningRisk(liveProfile)});
  const planningContext={...context,wholePageFirst:false,singleRequest:false,disableLargeCompletionBootstrap:false,
    conversationFillOutput:true,conversationContinuation:conversationState.continuation===true,
    // OpenRouter's request adapter has an 8K hard ceiling even when this
    // model's reasoning cannot be switched off. Planning against 16K here
    // would admit pages the API can only reject before generation.
    reasoningUnbounded,applicationCompletionCeiling:context.provider==='openrouter'?8192:reasoningUnbounded?16384:8192,
    estimateFixedInput:units=>estimateFixedInput(units,[],sourceContextForUnits ? sourceContextForUnits(units) : sourceContext)+units.length*12};
  const sizes=(Array.isArray(pageSizes)?pageSizes:[]).map(Number).filter(n=>Number.isSafeInteger(n)&&n>0);
  if(!sizes.length) {
    const bounded=[];let chars=0;
    for(const row of rows) {if(bounded.length>=MAX_SOURCE_UNITS || (bounded.length && chars+row.text.length>MAX_SOURCE_CHARS))break;bounded.push(row);chars+=row.text.length;}
    const chunk=takeWorkloadBatch(bounded,0,profile,planningContext);
    if(chunk.units.length===rows.length)chunk.splitReason='ready_queue_drained';
    else if(chunk.units.length===bounded.length)chunk.splitReason='request_source_limit';
    if(chunk.estimate){chunk.estimate.planningContract=contract||'unconfirmed';chunk.estimate.profileDecision=planningDecision;chunk.estimate.conversationCapacity??=profile.conversationCapacity;}
    return chunk;
  }
  let cursor=0,selected=[],estimate=null,selectedPages=0,sourceChars=0;
  let splitReason='ready_queue_drained';
  for(const size of sizes) {
    const page=rows.slice(cursor,cursor+size);cursor+=size;
    if(page.length!==size)break;
    const pageChars=page.reduce((n,row)=>n+String(row?.text||'').length,0);
    if(!selected.length&&(page.length>MAX_SOURCE_UNITS||pageChars>MAX_SOURCE_CHARS)) {
      // The application source ceiling is a hard limit. Split only this
      // oversized page at a semantic-unit boundary; do not mix a tail
      // with the next image.
      const bounded=[];let chars=0;
      for(const row of page){if(bounded.length>=MAX_SOURCE_UNITS||(bounded.length&&chars+String(row?.text||'').length>MAX_SOURCE_CHARS))break;bounded.push(row);chars+=String(row?.text||'').length;}
      const hard=takeWorkloadBatch(bounded,0,profile,{...planningContext,singleRequest:true});
      hard.splitReason='hard_application_source_limit_partial_page';
      hard.pageCount=1;hard.wholePages=0;
      if(hard.estimate){hard.estimate.planningContract=contract||'unconfirmed';hard.estimate.profileDecision=planningDecision;hard.estimate.conversationCapacity??=profile.conversationCapacity;}
      return hard;
    }
    const sourceLimitHit=(selected.length+page.length>MAX_SOURCE_UNITS)||(selected.length&&sourceChars+pageChars>MAX_SOURCE_CHARS);
    if(sourceLimitHit){splitReason='request_source_limit_before_page';break;}
    const candidateUnits=[...selected,...page];
    const candidate=estimateRequest(candidateUnits,profile,planningContext);
    if(!candidate.fitsHard){
      if(selected.length){splitReason=`per_request_${candidate.hardReason||'budget'}_before_page`;break;}
      // A single full image does not fit a real provider/context limit.
      // This is the only normal case where Conversation may split it.
      const hard=takeWorkloadBatch(page,0,profile,{...planningContext,singleRequest:true});
      hard.splitReason='hard_provider_budget_partial_page';
      hard.pageCount=1;hard.wholePages=0;
      if(hard.estimate){hard.estimate.planningContract=contract||'unconfirmed';hard.estimate.profileDecision=planningDecision;hard.estimate.conversationCapacity??=profile.conversationCapacity;}
      return hard;
    }
    // Conversation is complete-page first and content-budgeted. A soft
    // output target may stop only before the next page; unit count never
    // decides the split. This applies to the first request too: there is
    // no one-page warmup tax when several short pages already fit.
    if(selected.length && !candidate.fitsTarget){
      splitReason='conversation_page_output_target';
      break;
    }
    selected=candidateUnits;estimate=candidate;selectedPages++;sourceChars+=pageChars;
    // If one complete page alone exceeds the learned soft output target,
    // keep it intact but do not append another page. Hard provider limits
    // were checked above and remain authoritative.
    if(!candidate.fitsTarget){splitReason='whole_page_over_soft_target';break;}
  }
  if(!selected.length) return takeWorkloadBatch(rows,0,profile,planningContext);
  estimate.planningContract=contract||'unconfirmed';
  estimate.profileDecision=planningDecision;
  estimate.conversationCapacity??=profile.conversationCapacity;
  return {units:selected,estimate,splitReason,pageCount:selectedPages,wholePages:selectedPages};
}
