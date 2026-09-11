/** Estimates, not tokenizer counts. Billing always uses provider telemetry. */
export const WORKLOAD_VERSION = 6;
export const WORKLOAD_POLICY = Object.freeze({
  initialOutputTarget: 160, minimumOutputTarget: 48, maximumOutputTarget: 4096,
  initialRecords: 10, maximumRecords: 200, growthSamples: 8,
  // A confirmed large completion window can safely avoid paying provider
  // latency several times for an ordinary page. Keep the bootstrap target at
  // one quarter of the advertised window and abandon it after the first real
  // length/structure failure; unknown and smaller-capability models retain the
  // conservative learned profile above.
  largeCompletionThreshold: 8192, largeCompletionFraction: .25,
  largeCompletionRecords: 50,
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
  for (const key of ['contextTokens', 'maxOutputTokens', 'outputHintTokens', 'maxInputTokens']) {
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
    languageStreak: 0, actualIdentity: '', limits: {}, lastDecision: 'cold_start' };
}
export function validProfile(raw, now = Date.now()) {
  if (!raw || raw.version !== WORKLOAD_VERSION || !Number.isFinite(raw.updatedAt) || now - raw.updatedAt > 30 * 86400_000 || raw.updatedAt > now + 60_000) return initialProfile(now);
  const clean = initialProfile(now);
  for (const key of ['epoch', 'revision', 'samples', 'successes', 'fillSuccesses', 'recordSuccesses', 'languageStreak']) {
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) clean[key] = raw[key];
  }
  clean.target = Math.max(48, Math.min(4096, positive(raw.target) || clean.target));
  clean.records = Math.max(1, Math.min(200, positive(raw.records) || clean.records));
  clean.ratios = (Array.isArray(raw.ratios) ? raw.ratios : []).filter(x => Number.isFinite(x) && x >= .05 && x <= 32).slice(-64);
  clean.reasoning = (Array.isArray(raw.reasoning) ? raw.reasoning : []).filter(x => Number.isSafeInteger(x) && x >= 0 && x <= 1_000_000).slice(-64);
  clean.outcomes = (Array.isArray(raw.outcomes) ? raw.outcomes : []).filter(x => ['ok','length','structure','language','complete_at_limit'].includes(x)).slice(-64);
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
  const r = caps.reasoning || {};
  return r.mandatory === true || ai.thinking === 'on' ||
    (ai.thinking !== 'off' && r.supported !== false && r.default_enabled !== false);
}
export function estimateRequest(units, profile, context) {
  const features = outputFeatures(units, context.contract);
  const ratio = quantile(profile.ratios, .9, 1.5);
  const predictedOutput = Math.ceil(features.baseOutput * ratio * WORKLOAD_POLICY.safety);
  const reasoningReserve = context.reasoningActive
    ? Math.max(256, Math.ceil(quantile(profile.reasoning, .95, 768) * 1.2)) : 0;
  // Includes style, context, task, input keys, output schema, and role overhead.
  // Exact provider prompt count is retained separately, never reported as this estimate.
  const estimatedInput = Math.ceil((context.fixedInput + features.sourceWeight + units.length * 30) * 1.25);
  const limits = { ...normalizeLimits(context.limits), ...profile.limits };
  const contextAvailable = positive(limits.contextTokens)
    ? limits.contextTokens - estimatedInput - WORKLOAD_POLICY.contextReserve : Infinity;
  const completionAvailable = Math.min(WORKLOAD_POLICY.applicationCompletionCeiling, limits.maxOutputTokens || Infinity,
    limits.outputHintTokens || Infinity, context.userMaxOutput || Infinity, contextAvailable);
  const capacityFailureSeen = profile.outcomes.some(outcome => outcome === 'length' || outcome === 'structure');
  const confirmedLargeCompletion = positive(limits.maxOutputTokens) >= WORKLOAD_POLICY.largeCompletionThreshold;
  const bootstrapTarget = confirmedLargeCompletion && !capacityFailureSeen
    ? Math.floor(completionAvailable * WORKLOAD_POLICY.largeCompletionFraction) : 0;
  const effectiveTarget = Math.max(profile.target, bootstrapTarget);
  const effectiveRecords = bootstrapTarget > profile.target
    ? Math.max(profile.records, WORKLOAD_POLICY.largeCompletionRecords) : profile.records;
  const fitsHard = estimatedInput <= (limits.maxInputTokens || Infinity) &&
    predictedOutput + reasoningReserve <= completionAvailable;
  return { ...features, predictedOutput, reasoningReserve, estimatedInput,
    totalReserve: predictedOutput + reasoningReserve,
    completionAvailable: Number.isFinite(completionAvailable) ? Math.max(0, completionAvailable) : null,
    fitsHard, fitsTarget: predictedOutput <= effectiveTarget && units.length <= effectiveRecords,
    target: effectiveTarget, recordTarget: effectiveRecords, samples: profile.samples, revision: profile.revision,
    limits, epoch: profile.epoch, estimateKind: 'script_weight_calibrated_from_valid_provider_usage' };
}
export function takeWorkloadBatch(rows, offset, profile, context) {
  const units = []; let estimate; let splitReason = 'end_of_page';
  for (let i = offset; i < rows.length; i++) {
    const candidate = estimateRequest([...units, rows[i]], profile, context);
    if (units.length && (!candidate.fitsHard || !candidate.fitsTarget)) {
      splitReason = !candidate.fitsHard ? 'context_or_completion_reserve' :
        candidate.units > candidate.recordTarget ? 'learned_record_target' : 'learned_output_target';
      break;
    }
    units.push(rows[i]); estimate = candidate;
    if (!candidate.fitsHard) {
      throw Object.assign(new Error('One translation unit plus the prompt exceeds the available token budget; the unit was not cut.'),
        { code: 'ai_workload_budget_insufficient', providerAttempts: 0, generationAttempts: 0,
          requestDispatched: false, diagnostics: { estimatedInput: candidate.estimatedInput,
            estimatedOutput: candidate.predictedOutput, reasoningReserve: candidate.reasoningReserve,
            completionAvailable: candidate.completionAvailable } });
    }
    if (!candidate.fitsTarget) { splitReason = 'oversize_single_unit'; break; }
  }
  return { units, estimate, splitReason, oversizeSingleUnit: units.length === 1 && !estimate?.fitsTarget };
}
