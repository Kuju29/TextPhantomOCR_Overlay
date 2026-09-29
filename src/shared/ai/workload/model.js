import { cloudProviderSpec } from "../providers/cloud-registry.js";
import { reasoningPreferenceIsActive } from "../../reasoning-preference.js";
/** Estimates, not tokenizer counts. Billing always uses provider telemetry. */
export const WORKLOAD_VERSION = 13;
export const WORKLOAD_POLICY = Object.freeze({
  initialOutputTarget: 160, minimumOutputTarget: 48, maximumOutputTarget: 4096,
  // LM Studio's OpenAI-compatible chat endpoint can spend the entire first
  // completion on reasoning even when the model list has no reasoning flag.
  // This is a reserve, not an unconditional max_tokens override: the actual
  // loaded context, model output limit and user's output cap still win.
  lmStudioUnverifiedReasoningReserve: 1536,
  initialRecords: 10, maximumRecords: 200, growthSamples: 8,
  // A confirmed large completion window can safely avoid paying provider
  // latency several times for an ordinary page. Keep the bootstrap target at
  // one quarter of the advertised window and abandon it after the first real
  // length/structure failure; unknown and smaller-capability models retain the
  // conservative learned profile above.
  largeCompletionThreshold: 8192, largeCompletionFraction: .25,
  largeCompletionRecords: 50, bootstrapSuccessSamples: 2,
  circuitFailureThreshold: 2,
  // Latency learning is a separate soft constraint from token/context capacity.
  // It is intentionally based on observed generation time when TTFT is known,
  // so a slow router startup does not automatically fragment the next batch.
  conversationBaselineOutputTarget: 1536,
  targetGenerationMs: 12000, slowGenerationMs: 16000, fastGenerationMs: 8000,
  targetTotalMsWhenFirstContentUnknown: 15000, slowTotalMsWhenFirstContentUnknown: 22000,
  slowStartupMs: 12000, latencyScaleFloor: .5, latencyUnknownScaleFloor: .6,
  latencyRelaxSamples: 2, latencyRelaxFactor: 1.25, latencyEvidenceMinOutput: 96,
  window: 64, safety: 1.25, contextReserve: 128, applicationCompletionCeiling: 8192,
});
export const positive = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
export const quantile = (values, q, fallback) => {
  const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : fallback;
};
export function observedInputScale(samples = [], safety = 2) {
  const ratios=(Array.isArray(samples)?samples:[]).slice(-8)
    .filter(row=>Number.isSafeInteger(row?.actual)&&row.actual>=256&&
      Number.isSafeInteger(row?.raw)&&row.raw>0)
    .map(row=>row.actual/row.raw);
  return ratios.length ? Math.min(1,Math.max(.45,safety*Math.max(...ratios))) : 1;
}
/** Telemetry only, never a batching target. */
export const sourceCharacters = value => Array.from(String(value ?? "")).length;
export function textWeight(value) {
  let weight = 0;
  for (const char of String(value ?? '')) {
    if (/\s/u.test(char)) { weight += .1; continue; }
    weight += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(char)
      ? 1 : /[\p{L}\p{N}]/u.test(char) ? .25 : .5;
  }
  return Math.max(1, Math.ceil(weight));
}
export function normalizeLimits(value = {}) {
  const out = {};
  for (const key of ['contextTokens', 'maxOutputTokens', 'outputHintTokens', 'maxInputTokens', 'runtimeContextTokens', 'modelContextTokens', 'configuredContextTokens']) {
    if (positive(value?.[key]) && value[key] <= 100_000_000) out[key] = value[key];
  }
  for (const key of ['source', 'scope', 'modelRevision', 'tokenizer']) {
    if (typeof value?.[key] === 'string') out[key] = value[key].slice(0, 160);
  }
  return out;
}
export function initialProfile(now = Date.now()) {
  return { version: WORKLOAD_VERSION, updatedAt: now, epoch: 0, revision: 0, samples: 0, successes: 0,
    target: WORKLOAD_POLICY.initialOutputTarget, records: WORKLOAD_POLICY.initialRecords,
    ratios: [], inputSamples: [], reasoning: [], outcomes: [], fillSuccesses: 0, recordSuccesses: 0,
    languageStreak: 0, structureStreak: 0, reliabilityRestricted: false, zeroReasoningSamples: 0, actualIdentity: '', limits: {},
    latencyOutputTarget: null, latencyFastStreak: 0, lastProviderMs: null,
    lastFirstContentMs: null, lastGenerationMs: null, lastLatencyDecision: '',
    lastDecision: 'cold_start' };
}
export function validProfile(raw, now = Date.now()) {
  if (!raw || raw.version !== WORKLOAD_VERSION || !Number.isFinite(raw.updatedAt) || now - raw.updatedAt > 30 * 86400_000 || raw.updatedAt > now + 60_000) return initialProfile(now);
  const clean = initialProfile(now);
  for (const key of ['epoch', 'revision', 'samples', 'successes', 'fillSuccesses', 'recordSuccesses', 'languageStreak', 'structureStreak', 'zeroReasoningSamples', 'latencyFastStreak']) {
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) clean[key] = raw[key];
  }
  clean.reliabilityRestricted = raw.reliabilityRestricted === true;
  clean.target = Math.max(48, Math.min(4096, positive(raw.target) || clean.target));
  clean.records = Math.max(1, Math.min(200, positive(raw.records) || clean.records));
  clean.ratios = (Array.isArray(raw.ratios) ? raw.ratios : []).filter(x => Number.isFinite(x) && x >= .05 && x <= 32).slice(-64);
  clean.inputSamples=(Array.isArray(raw.inputSamples)?raw.inputSamples:[])
    .filter(row=>Number.isSafeInteger(row?.actual)&&row.actual>=256&&
      Number.isSafeInteger(row?.raw)&&row.raw>0).slice(-8)
    .map(row=>({actual:row.actual,raw:row.raw}));
  clean.reasoning = (Array.isArray(raw.reasoning) ? raw.reasoning : []).filter(x => Number.isSafeInteger(x) && x >= 0 && x <= 1_000_000).slice(-64);
  clean.outcomes = (Array.isArray(raw.outcomes) ? raw.outcomes : []).filter(x => ['ok','length','structure','language','complete_at_limit'].includes(x)).slice(-64);
  clean.latencyOutputTarget = positive(raw.latencyOutputTarget)
    ? Math.max(WORKLOAD_POLICY.minimumOutputTarget, Math.min(WORKLOAD_POLICY.maximumOutputTarget, raw.latencyOutputTarget)) : null;
  for (const key of ['lastProviderMs','lastFirstContentMs','lastGenerationMs'])
    clean[key] = Number.isFinite(raw[key]) && raw[key] >= 0 ? Math.min(3_600_000, Number(raw[key])) : null;
  clean.lastLatencyDecision = String(raw.lastLatencyDecision || '').slice(0, 80);
  clean.actualIdentity = String(raw.actualIdentity || '').slice(0, 320);
  clean.limits = normalizeLimits(raw.limits);
  clean.updatedAt = raw.updatedAt;
  clean.lastDecision = String(raw.lastDecision || '').slice(0, 80);
  return clean;
}
export function outputFeatures(units, contract = '') {
  // The fixed per-record cost accounts for JSON keys or TP delimiters.
  const recordCost = /schema|json/i.test(contract) ? 8 : 12;
  const sourceWeight = units.reduce((n, u) => n + textWeight(u.text), 0);
  return { sourceChars: units.reduce((n, u) => n + sourceCharacters(u.text), 0), sourceWeight, units: units.length, baseOutput: sourceWeight + units.length * recordCost + 4 };
}
export function reasoningIsActive(ai = {}, caps = {}) {
  return reasoningPreferenceIsActive(ai.thinking, caps.reasoning || {});
}

// Keep provider-ignored-Off evidence conservative, but do not let one old
// hidden-reasoning sample throttle dozens of later requests after the provider
// has repeatedly proved that Off is now being honoured.  Unknown telemetry is
// never written as zero, so two trailing zero samples are positive evidence.
export function observedReasoningRisk(profile = {}) {
  const history = Array.isArray(profile.reasoning) ? profile.reasoning : [];
  let trailingZeroProof = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const value = Number(history[i]);
    if (!Number.isFinite(value) || value < 0) continue;
    if (value === 0) {
      trailingZeroProof += 1;
      if (trailingZeroProof >= 2) return false;
      continue;
    }
    if (value > 0) return true;
  }
  return false;
}

export function estimateRequest(units, profile, context) {
  const features = outputFeatures(units, context.contract);
  const ratio = quantile(profile.ratios, .9, 1.5);
  const predictedOutput = Math.ceil(features.baseOutput * ratio * WORKLOAD_POLICY.safety);
  // A provider may continue producing hidden reasoning even when the UI asks
  // for Thinking Off. Once provider telemetry proves that happened, reserve it
  // on every later sub-batch in this session/profile instead of trusting the
  // requested toggle. Unknown is not treated as zero.
  const observedReasoning = observedReasoningRisk(profile);
  const lmStudioUnverifiedReasoning = context.provider === 'lmstudio' && !context.nativeLmStudioOff &&
    context.reasoningSupported !== false &&
    !(profile.zeroReasoningSamples >= 2 && profile.reasoning?.slice(-2).every(value => value === 0));
  const reasoningRisk = context.reasoningActive || observedReasoning || lmStudioUnverifiedReasoning;
  const measuredReasoningReserve = reasoningRisk
    ? Math.max(lmStudioUnverifiedReasoning ? WORKLOAD_POLICY.lmStudioUnverifiedReasoningReserve : 256,
      Math.ceil(quantile(profile.reasoning, .95, context.reasoningUnbounded === true ? 2048 : 768) * 1.2)) : 0;
  const advertisedLimits = normalizeLimits(context.limits);
  // Include the composed request before reserving a share of the completion
  // window. A model with an 8K live context cannot reserve 8K for thinking
  // after the prompt already occupies part of that same window.
  const fixedInput = context.estimateFixedInput ? context.estimateFixedInput(units) : context.fixedInput;
  const rawEstimatedInput = Math.ceil((fixedInput + features.sourceWeight + units.length * 30) * 1.25);
  const lmStudioRuntimeWindow = context.provider === 'lmstudio' &&
    advertisedLimits.source === 'lmstudio_native_loaded_instance';
  const inputSampleCount = context.allowInputCalibration ? profile.inputSamples.length : 0;
  const inputUnverified = lmStudioRuntimeWindow && inputSampleCount === 0;
  // Start with a bounded estimate, then use measured usage after the first
  // request. This multilingual character estimate is not a tokenizer count.
  const inputEstimateScale = inputUnverified ? .6 : context.allowInputCalibration
    ? observedInputScale(profile.inputSamples, lmStudioRuntimeWindow ? 1.25 : 2) : 1;
  const estimatedInput = Math.ceil(rawEstimatedInput * inputEstimateScale);
  // The completion window pays for both the translated text and hidden
  // reasoning. A small page's reasoning count cannot predict a 200-unit turn:
  // the same OpenRouter model may use the entire 8K output window on thinking
  // even after it accepted Thinking Off. Give a proven reasoning consumer a
  // fixed half-window allowance before admitting whole pages. Cap large past
  // samples at that allowance so a single exhausted call does not prevent
  // every later page (including repair) from fitting at all.
  const reasoningWindow = Math.min(
    positive(context.applicationCompletionCeiling) || WORKLOAD_POLICY.applicationCompletionCeiling,
    advertisedLimits.maxOutputTokens || Infinity,
    positive(context.userMaxOutput) || Infinity,
    positive(advertisedLimits.contextTokens)
      ? Math.max(0, advertisedLimits.contextTokens - estimatedInput - WORKLOAD_POLICY.contextReserve)
      : Infinity,
  );
  const conversationReasoning = context.conversationFillOutput === true && reasoningRisk &&
    Number.isFinite(reasoningWindow) && reasoningWindow > 0;
  const reasoningReserve = conversationReasoning
    ? Math.floor(reasoningWindow / 2) : measuredReasoningReserve;
  // Learned usage informs the estimate; a saved allocation is not evidence
  // of this request's physical model window after a same-ID runtime reload.
  const baseLimits = { ...advertisedLimits };
  const contextPlan = context.configureContext?.(baseLimits, { estimatedInput, predictedOutput, reasoningReserve });
  const limits = contextPlan?.limits || baseLimits;
  // LM Studio's REST API does not expose an exact templated prompt token count
  // before generation. Bound the cold request by the estimate and label it
  // unverified; after generation use the provider-reported input count.
  const contextAvailable = positive(limits.contextTokens)
    ? limits.contextTokens - estimatedInput - WORKLOAD_POLICY.contextReserve : Infinity;
  const applicationCompletionCeiling = positive(context.applicationCompletionCeiling) || WORKLOAD_POLICY.applicationCompletionCeiling;
  const completionAvailable = Math.min(applicationCompletionCeiling, limits.maxOutputTokens || Infinity,
    context.userMaxOutput || Infinity,
    inputUnverified && context.nativeLmStudioOff
      ? Math.min(Math.floor(limits.contextTokens * .4), contextAvailable)
      : contextAvailable);
  const capacityFailureSeen = (context.localIndependent === true ? profile.outcomes.slice(-4) : profile.outcomes)
    .some(outcome => outcome === 'length') || profile.reliabilityRestricted === true;
  const confirmedLargeCompletion = positive(limits.maxOutputTokens) >= WORKLOAD_POLICY.largeCompletionThreshold;
  // Do not turn an advertised 8K completion window into one huge cold request
  // for a reasoning-capable/unknown model. A non-reasoning provider may use the
  // window immediately; otherwise require two valid measured generations first.
  const bootstrapTrusted = context.reasoningSupported === false || context.nativeOffControl === true && !observedReasoning ||
    (profile.successes >= WORKLOAD_POLICY.bootstrapSuccessSamples && profile.zeroReasoningSamples >= WORKLOAD_POLICY.bootstrapSuccessSamples && !observedReasoning);
  // Local runtimes often report context but no max output/reasoning count.
  // After two clean answers, a verified native Off control or non-reasoning
  // model can use a bounded quarter-window just like two measured zeros.
  // This is application policy, NOT a fabricated zero in usage or an advertised
  // output limit. Observed hidden reasoning, failures and latency still win.
  const measuredLocalWindow = context.localIndependent === true &&
    positive(limits.contextTokens) && profile.successes >= 2 &&
    (profile.zeroReasoningSamples >= 2 || context.nativeOffControl === true || context.reasoningSupported === false) && !reasoningRisk;
  const bootstrapTarget = context.disableLargeCompletionBootstrap !== true &&
    (confirmedLargeCompletion || measuredLocalWindow) && !capacityFailureSeen && bootstrapTrusted
    ? (confirmedLargeCompletion ? Math.floor(completionAvailable * WORKLOAD_POLICY.largeCompletionFraction)
      : Math.min(2048, Math.floor(completionAvailable * WORKLOAD_POLICY.largeCompletionFraction))) : 0;
  const unconstrainedTarget = Math.max(profile.target, bootstrapTarget);
  const latencyOutputTarget = positive(profile.latencyOutputTarget);
  const effectiveTarget = latencyOutputTarget
    ? Math.min(unconstrainedTarget, latencyOutputTarget) : unconstrainedTarget;
  // Conversation accepts whole ready pages against the current request's
  // measured input/context/output window. Previous structural omissions do
  // not permanently shrink a confirmed model to the legacy 1,280-token
  // target; an actual recent length failure temporarily increases headroom.
  // The output estimate already has its independent 1.25 safety multiplier.
  const currentWindow = normalizeLimits(context.limits);
  const verifiedContext = (positive(currentWindow.contextTokens) || positive(currentWindow.maxInputTokens)) >= 32768;
  const reportedCompletion = positive(currentWindow.maxOutputTokens);
  // A reported output limit always wins. For ANY Cloud route with a verified
  // large context, the application may use its bounded request budget even
  // when max output is undisclosed. Unknown contexts still use the conservative
  // fallback; context is never treated as an advertised output maximum.
  const applicationWindow = Boolean(cloudProviderSpec(context.provider)) && !reportedCompletion;
  const sizedConversationWindow = context.conversationFillOutput === true &&
    verifiedContext && (reportedCompletion || applicationWindow) && Number.isFinite(completionAvailable);
  const recentLength = profile.outcomes?.slice(-4).includes('length') === true;
  const conversationTarget = sizedConversationWindow
    ? Math.max(0, Math.floor(completionAvailable * (recentLength ? .75 : .9)) - reasoningReserve) : null;
  // Only an exact loaded instance with native Off support may plan Local
  // Independent pages against the live hard window. Other Local models keep
  // their learned reliability limit until a real generation proves capacity.
  const nativeOffWindow = context.nativeLmStudioOff && lmStudioRuntimeWindow &&
    Number.isFinite(completionAvailable) && completionAvailable > 0;
  const requestTarget = nativeOffWindow
    ? Math.max(WORKLOAD_POLICY.minimumOutputTarget, Math.min(
      Math.floor(completionAvailable * (capacityFailureSeen ? .65 : .8)),
      // The loaded window is known, but the first prompt's true tokenizer
      // count is not. Admit a useful first page, then expand from actual
      // input_tokens instead of trusting the multilingual character heuristic.
      inputUnverified ? Math.floor(limits.contextTokens * .25) : Infinity))
    : conversationTarget ?? effectiveTarget;
  // Unit count is telemetry only. Per-unit marker/prompt overhead is already
  // included in predictedOutput/estimatedInput, so a second record-count gate
  // double-penalizes vertical pages that naturally contain many short units.
  // Hard application source ceilings remain outside this learned soft target.
  const effectiveRecords = bootstrapTarget > profile.target
    ? Math.max(profile.records, WORKLOAD_POLICY.largeCompletionRecords) : profile.records;
  const physicalAvailable = Math.min(limits.maxOutputTokens || Infinity,
    limits.contextTokens ? limits.contextTokens - estimatedInput - WORKLOAD_POLICY.contextReserve : Infinity,
    context.userMaxOutput || Infinity);
  const fitsHard = Number.isFinite(estimatedInput) && estimatedInput <= (limits.maxInputTokens || Infinity) &&
    predictedOutput + reasoningReserve <= physicalAvailable;
  return { ...features, predictedOutput, reasoningReserve, estimatedInput,rawEstimatedInput,inputEstimateScale,
    totalReserve: predictedOutput + reasoningReserve,
    completionAvailable: Number.isFinite(completionAvailable) ? Math.max(0, completionAvailable) : null,
    physicalAvailable: Number.isFinite(physicalAvailable) ? Math.max(0,physicalAvailable) : null,
    hardReason: estimatedInput > (limits.maxInputTokens || Infinity) ? 'input_limit'
      : predictedOutput + reasoningReserve > contextAvailable ? 'context_window'
      : predictedOutput + reasoningReserve > physicalAvailable ? 'output_budget' : null,
    reliabilityReason: predictedOutput > requestTarget ? 'output_reliability_estimate' : null,
    fitsHard, fitsTarget: predictedOutput <= requestTarget,
    target: requestTarget, unconstrainedTarget, latencyOutputTarget, recordTarget: effectiveRecords, samples: profile.samples, revision: profile.revision,
    ...(sizedConversationWindow ? {conversationCapacity:recentLength ? 'continuation_reliability_restricted' :
      applicationWindow ? 'application_context_bounded' : context.conversationContinuation ? 'continuation_token_budget' : 'anchor'} : {}),
    limits, contextPlan: contextPlan?.evidence || null, epoch: profile.epoch, observedReasoning, reasoningRisk,
    inputSampleCount, inputUnverified,
    phase: context.phase || 'initial', estimateKind: 'script_weight_with_output_calibration' };
}
function budgetError(estimate, message = 'This image plus the fixed prompt exceeds the available token budget; the image was not split or dispatched.') {
  return Object.assign(new Error(message),
    { code: 'ai_workload_budget_insufficient', constraintScope: 'per_request', providerAttempts: 0, generationAttempts: 0,
      requestDispatched: false, diagnostics: { constraintScope: 'per_request', constraint: estimate?.hardReason || 'unknown', estimateKind: estimate?.estimateKind, estimatedInput: estimate?.estimatedInput,
        estimatedOutput: estimate?.predictedOutput, reasoningReserve: estimate?.reasoningReserve,
        completionAvailable: estimate?.completionAvailable, contextLimit: estimate?.limits?.contextTokens ?? null,
        outputLimit: estimate?.limits?.maxOutputTokens ?? null, inputLimit: estimate?.limits?.maxInputTokens ?? null,
        ...(estimate?.contextPlan || {}) } });
}

export function takeWorkloadBatch(rows, offset, profile, context) {
  // Page translation prefers one image/one generation. Learned soft targets
  // remain telemetry only and must never fragment an ordinary image. When the
  // complete remainder genuinely exceeds a provider/context ceiling, keep the
  // minimum contiguous hard-safe prefix instead of failing the whole image.
  // A single semantic unit is never cut; if that unit alone cannot fit, stop
  // before provider dispatch with an explicit budget error.
  if (context?.singleRequest === true) {
    const units = [];
    let estimate = null;
    for (let i = offset; i < rows.length; i++) {
      const candidate = estimateRequest([...units, rows[i]], profile, context);
      if (units.length && !candidate.fitsHard) {
        return { units, estimate, splitReason: 'hard_provider_budget', oversizeSingleUnit: false };
      }
      if (!candidate.fitsHard) {
        throw budgetError(candidate,
          'One translation unit plus the prompt exceeds the available token budget; the unit was not cut or dispatched.');
      }
      units.push(rows[i]);
      estimate = candidate;
    }
    if (!units.length)
      return { units, estimate, splitReason: 'empty_image', oversizeSingleUnit: false };
    return { units, estimate, splitReason: 'one_image_one_generation', oversizeSingleUnit: false };
  }

  // Assess the entire unsent page first, but never bypass hard OR reliability
  // limits. Quota/concurrency admission is independent and never shrinks this
  // chunk merely because another image is in flight.
  const pageEstimate = context?.wholePageFirst === true
    ? estimateRequest(rows.slice(offset), profile, context) : null;
  if (pageEstimate?.fitsHard && pageEstimate.fitsTarget) {
    return { units: rows.slice(offset), estimate: pageEstimate, pageEstimate,
      splitReason: offset === 0 ? 'whole_page_fits' : 'remaining_page_fits',
      oversizeSingleUnit: false };
  }
  const units = []; let estimate; let splitReason = 'end_of_page';
  for (let i = offset; i < rows.length; i++) {
    const candidate = estimateRequest([...units, rows[i]], profile, context);
    if (units.length && (!candidate.fitsHard || !candidate.fitsTarget)) {
      splitReason = !candidate.fitsHard ? `per_request_${candidate.hardReason || 'budget'}` :
        'learned_output_target';
      break;
    }
    units.push(rows[i]); estimate = candidate;
    if (!candidate.fitsHard) {
      throw budgetError(candidate, 'One translation unit plus the prompt exceeds the available token budget; the unit was not cut.');
    }
    if (!candidate.fitsTarget) { splitReason = 'oversize_single_unit'; break; }
  }
  return { units, estimate, pageEstimate, splitReason, oversizeSingleUnit: units.length === 1 && !estimate?.fitsTarget };
}
