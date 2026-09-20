/** Compact, content-free evidence; never infers tokenizer counts or quota limits. */
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
export function budgetDiagnostic(chunk, {operationId, imageId, profileId, pageUnits, attemptKind="initial"}={}) {
  const e=chunk.estimate || {}, full=chunk.pageEstimate || e;
  return {schema:'tp.audit/1',event:'translation_budget',scope:{operationId,imageId,profileId},reason:chunk.splitReason,
    attemptKind, constraintScope:!full.fitsHard?'per_request':!full.fitsTarget?'reliability':'per_request',
    wholePage:attemptKind === "initial" && chunk.units.length===pageUnits,pageUnits,requestUnits:chunk.units.length,estimateKind:e.estimateKind,
    planned:{estimatedInput:e.estimatedInput,estimatedOutput:e.predictedOutput,reasoningReserve:e.reasoningReserve,
      completionAvailable:e.completionAvailable,contextLimit:e.limits?.contextTokens??null,
      outputLimit:e.limits?.maxOutputTokens??null,inputLimit:e.limits?.maxInputTokens??null,
      outputTarget:e.target,recordTarget:e.recordTarget,...(e.contextPlan || {})},
    evidence:{pageEstimatedInput:full.estimatedInput,pageEstimatedOutput:full.predictedOutput,
      pageReasoningReserve:full.reasoningReserve,pageCompletionAvailable:full.completionAvailable,
      hardFits:full.fitsHard,reliabilityFits:full.fitsTarget}};
}
export function resultDiagnostic(observed, {operationId,imageId,profileId,attemptKind="initial",error=null}={}) {
  const o=observed||{},u=o.usage||{},v=o.validation||{},cached=count(u.cachedInput);
  const statuses={ok:'complete_at_contract_boundary',complete_at_limit:'complete_at_contract_boundary',length:'output_truncated',structure:'incomplete_ids',language:'wrong_language'};
  return {schema:'tp.audit/1',event:'translation_result',scope:{operationId,imageId,profileId},reason:'finished',
    attemptKind, resultStatus:statuses[o.outcome] || (error?.name === 'AbortError' ? 'cancelled' : Number(error?.status || error?.upstreamStatus)===429 || /rate_limit/.test(error?.code || '') ? 'rate_limited' : String(error?.code||'').toLowerCase() === 'ai_workload_budget_insufficient' ? 'input_budget_rejected' : error ? 'transport_failure' : 'unverified'),
    actualInput:count(u.inputTokens),actualOutput:count(u.outputTokens),actualReasoning:count(u.thinkingTokens),
    cachedInput:cached,cacheReported:cached!==null,cacheStatus:cached===null?'not_reported':cached>0?'reported_hit':'reported_zero',
    missingCount:count(v.missingCount),wrongLanguageCount:count(v.wrongLanguageCount),
    complete:['ok','complete_at_limit'].includes(o.outcome),
    after:{outputTarget:o.learning?.outputTarget,recordTarget:o.learning?.recordTarget,samples:o.learning?.samples}};
}

/** Rejection happens before provider dispatch, including repair planning. */
export function rejectedBudgetDiagnostic(error, {operationId,imageId,profileId,pageUnits,attemptKind='initial'}={}) {
  const d=error?.diagnostics || {};
  const planned={};
  for(const k of ['estimatedInput','estimatedOutput','reasoningReserve','completionAvailable','contextLimit','outputLimit','inputLimit',
    'runtimeContext','modelContext','requestedContext','contextCeiling','contextRequired']) planned[k]=count(d[k]);
  if(d.contextPolicy)planned.contextPolicy=d.contextPolicy;
  if(d.contextReason)planned.contextReason=d.contextReason;
  planned.contextVerified=false;
  return {schema:'tp.audit/1',event:'translation_budget',attemptKind,scope:{operationId,imageId,profileId},
    reason:`per_request_${d.constraint || 'output_budget'}`,constraintScope:'per_request',wholePage:false,
    pageUnits,requestUnits:0,estimateKind:d.estimateKind,planned,requestDispatched:false};
}
