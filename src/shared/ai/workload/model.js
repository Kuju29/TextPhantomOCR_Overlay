import { reasoningPreferenceIsActive } from "../../reasoning-preference.js";
/** Estimates, not tokenizer counts. Billing always uses provider telemetry. */
export const WORKLOAD_VERSION = 11;
export const WORKLOAD_POLICY = Object.freeze({
  initialOutputTarget: 160, minimumOutputTarget: 48, maximumOutputTarget: 4096,
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
    ratios: [], reasoning: [], outcomes: [], fillSuccesses: 0, recordSuccesses: 0,
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
  const reasoningRisk = context.reasoningActive || observedReasoning;
  const reasoningReserve = reasoningRisk
    ? Math.max(256, Math.ceil(quantile(profile.reasoning, .95, context.reasoningUnbounded === true ? 2048 : 768) * 1.2)) : 0;
  // Includes style, context, task, input keys, output schema, and role overhead.
  // Exact provider prompt count is retained separately, never reported as this estimate.
  const fixedInput = context.estimateFixedInput ? context.estimateFixedInput(units) : context.fixedInput;
  const estimatedInput = Math.ceil((fixedInput + features.sourceWeight + units.length * 30) * 1.25);
  // A live native context allocation outranks a persisted old runtime window.
  const discovered = normalizeLimits(context.limits);
  const baseLimits = context.configureContext ? { ...profile.limits, ...discovered }
    : { ...discovered, ...profile.limits };
  const contextPlan = context.configureContext?.(baseLimits, { estimatedInput, predictedOutput, reasoningReserve });
  const limits = contextPlan?.limits || baseLimits;
  const contextAvailable = positive(limits.contextTokens)
    ? limits.contextTokens - estimatedInput - WORKLOAD_POLICY.contextReserve : Infinity;
  const applicationCompletionCeiling = positive(context.applicationCompletionCeiling) || WORKLOAD_POLICY.applicationCompletionCeiling;
  const completionAvailable = Math.min(applicationCompletionCeiling, limits.maxOutputTokens || Infinity,
    limits.outputHintTokens || Infinity, context.userMaxOutput || Infinity, contextAvailable);
  const capacityFailureSeen = profile.outcomes.some(outcome => outcome === 'length') || profile.reliabilityRestricted === true;
  const confirmedLargeCompletion = positive(limits.maxOutputTokens) >= WORKLOAD_POLICY.largeCompletionThreshold;
  // Do not turn an advertised 8K completion window into one huge cold request
  // for a reasoning-capable/unknown model. A non-reasoning provider may use the
  // window immediately; otherwise require two valid measured generations first.
  const bootstrapTrusted = context.reasoningSupported === false ||
    (profile.successes >= WORKLOAD_POLICY.bootstrapSuccessSamples && profile.zeroReasoningSamples >= WORKLOAD_POLICY.bootstrapSuccessSamples && !observedReasoning);
  const bootstrapTarget = context.disableLargeCompletionBootstrap !== true && confirmedLargeCompletion && !capacityFailureSeen && bootstrapTrusted
    ? Math.floor(completionAvailable * WORKLOAD_POLICY.largeCompletionFraction) : 0;
  const unconstrainedTarget = Math.max(profile.target, bootstrapTarget);
  const latencyOutputTarget = positive(profile.latencyOutputTarget);
  const effectiveTarget = latencyOutputTarget
    ? Math.min(unconstrainedTarget, latencyOutputTarget) : unconstrainedTarget;
  // Unit count is telemetry only. Per-unit marker/prompt overhead is already
  // included in predictedOutput/estimatedInput, so a second record-count gate
  // double-penalizes vertical pages that naturally contain many short units.
  // Hard application source ceilings remain outside this learned soft target.
  const effectiveRecords = bootstrapTarget > profile.target
    ? Math.max(profile.records, WORKLOAD_POLICY.largeCompletionRecords) : profile.records;
  const fitsHard = Number.isFinite(estimatedInput) && estimatedInput <= (limits.maxInputTokens || Infinity) &&
    predictedOutput + reasoningReserve <= completionAvailable;
  return { ...features, predictedOutput, reasoningReserve, estimatedInput,
    totalReserve: predictedOutput + reasoningReserve,
    completionAvailable: Number.isFinite(completionAvailable) ? Math.max(0, completionAvailable) : null,
    hardReason: estimatedInput > (limits.maxInputTokens || Infinity) ? 'input_limit'
      : predictedOutput + reasoningReserve > contextAvailable ? 'context_window'
      : predictedOutput + reasoningReserve > completionAvailable ? 'output_budget' : null,
    reliabilityReason: predictedOutput > effectiveTarget ? 'output_reliability_estimate' : null,
    fitsHard, fitsTarget: predictedOutput <= effectiveTarget,
    target: effectiveTarget, unconstrainedTarget, latencyOutputTarget, recordTarget: effectiveRecords, samples: profile.samples, revision: profile.revision,
    limits, contextPlan: contextPlan?.evidence || null, epoch: profile.epoch, observedReasoning, reasoningRisk, phase: context.phase || 'initial', estimateKind: 'script_weight_with_output_calibration' };
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
