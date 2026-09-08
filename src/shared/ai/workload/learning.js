import { initialProfile, normalizeLimits, positive, WORKLOAD_POLICY } from './model.js';
const normalFinish = /^(stop|end_turn|eos|completed|complete)$/i;
const array = (v) => Array.isArray(v) ? v : [];
const count = (v) => Number.isInteger(v) && v >= 0 ? v : null;
export function observeWorkload({ units, answer, error, defects = {}, plan, ai = {} }) {
  const meta = answer?.meta || error?.generationMeta || error?.structuralDetails?.generationMeta || {};
  const diagnostic = error?.diagnostics || {};
  const usage = meta.usage || error?.usage || {};
  const finish = String(meta.finishReason || meta.finish_reason || diagnostic.finishReason || '');
  const code = String(error?.code || '');
  const missing = new Set([...array(answer?.missing), ...array(defects.missing)].map(String));
  const expected = new Set(units.map(u => String(u.id)));
  const seen = new Set(); let structural = false;
  for (const item of array(answer?.translations)) {
    const id = String(item?.id); if (seen.has(id) || !expected.has(id)) structural = true;
    seen.add(id); if (!String(item?.text || '').trim()) missing.add(id);
  }
  for (const id of expected) if (!seen.has(id)) missing.add(id);
  const contract = meta.contractDiagnostics || {};
  structural ||= ['duplicateIds','ignoredUnknownIds','malformedMarkerIds'].some(k => array(contract[k]).length > 0);
  let outcome = 'ignored';
  if (answer?.replayed === true || meta.replayed === true || error?.name === 'AbortError' || /cancel|abort|timeout|network|http|transport/i.test(code)) outcome = 'ignored';
  else if (/^(length|max_tokens|max_output_tokens)$/i.test(finish) || code === 'output_budget_exhausted')
    outcome = !error && !structural && !missing.size ? 'complete_at_limit' : 'length';
  else if (normalFinish.test(finish) && (!error || /contract|model_output/i.test(code))) {
    outcome = structural || missing.size || error ? 'structure' :
      array(defects.wrongLanguage).length ? 'language' : 'ok';
  }
  const output = count(usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens);
  const reasoning = count(usage.thinkingTokens ?? usage.reasoningTokens ?? usage.completion_tokens_details?.reasoning_tokens);
  // No arithmetic from a truncated answer and no assumption that unknown reasoning is zero.
  const knownNonReasoning = ai.model_capabilities?.reasoning?.supported === false;
  const visible = outcome === 'ok' && usage.source === 'provider' && output != null
    ? reasoning != null && reasoning <= output ? output - reasoning : knownNonReasoning ? output : null : null;
  // Unknown hidden reasoning must not be presented as zero. A successful total
  // completion count is usable only as a conservative upper-bound calibration.
  const calibration = visible ?? (outcome === 'ok' && usage.source === 'provider' ? output : null);
  // Router-selected upstreams may legitimately vary between otherwise identical
  // requests. Treat the resolved model + wire contract as workload identity;
  // changing only the transient upstream must not reset learning back to a cold
  // workload target on every routed request.
  const identity = answer ? [String(meta.model || meta.resolvedModel || ai.model || ''),
    String(meta.selectedContract || meta.outputContract || '')].join('|') : '';
  return { outcome, visibleTokens: visible, calibrationTokens: calibration, reasoningTokens: reasoning, actualIdentity: identity,
    providerInputTokens: count(usage.inputTokens), providerOutputTokens: output,
    cachedInputTokens: count(usage.cachedInputTokens),
    requestedOutputTokens: positive(meta.requestedOutputTokens), finishReason: finish,
    missingCount: missing.size, wrongLanguageCount: array(defects.wrongLanguage).length,
    providerMs: Number.isFinite(meta.providerMs) ? meta.providerMs : null,
    limits: normalizeLimits(meta.modelLimits), plan };
}
export function learnWorkload(profile, observation, now = Date.now()) {
  const o = observation; if (o.outcome === 'ignored' || !o.plan) return profile;
  // Old concurrent requests must not overwrite a newly identified backend/model profile.
  if (o.plan.epoch !== profile.epoch) return profile;
  let p = structuredClone(profile);
  if (p.actualIdentity && o.actualIdentity && p.actualIdentity !== o.actualIdentity) {
    p = { ...initialProfile(now), epoch: p.epoch + 1, lastDecision: 'resolved_provider_model_or_contract_changed' };
  }
  p.actualIdentity = o.actualIdentity || p.actualIdentity;
  p.updatedAt = now; p.samples += 1;
  p.limits = { ...p.limits, ...o.limits };
  p.outcomes = [...p.outcomes, o.outcome].slice(-WORKLOAD_POLICY.window);
  const currentPlan = o.plan.revision == null || o.plan.revision === p.revision;
  const oldTarget = p.target, oldRecords = p.records;
  if (o.outcome === 'ok') {
    p.successes += 1; p.languageStreak = 0;
    if (positive(o.calibrationTokens)) {
      const ratio = o.calibrationTokens / o.plan.baseOutput;
      if (ratio >= .05 && ratio <= 32) p.ratios = [...p.ratios, ratio].slice(-64);
    }
    if (count(o.reasoningTokens) != null) p.reasoning = [...p.reasoning, o.reasoningTokens].slice(-64);
    // Only full/near-full batches demonstrate that a larger limit is worth trying.
    if (currentPlan && o.plan.predictedOutput >= p.target * .75) p.fillSuccesses += 1;
    if (currentPlan && o.plan.units >= p.records) p.recordSuccesses += 1;
    const recentBad = p.outcomes.slice(-8).some(x => x !== 'ok');
    if (!recentBad && p.fillSuccesses >= WORKLOAD_POLICY.growthSamples) {
      p.target = Math.min(WORKLOAD_POLICY.maximumOutputTarget, Math.ceil(p.target * 1.125));
      p.fillSuccesses = 0; p.lastDecision = 'grow_output_after_valid_near_full_batches';
    }
    if (!recentBad && p.recordSuccesses >= WORKLOAD_POLICY.growthSamples) {
      p.records = Math.min(WORKLOAD_POLICY.maximumRecords, p.records + 1);
      p.recordSuccesses = 0; p.lastDecision = 'grow_records_after_valid_full_batches';
    }
  } else {
    p.fillSuccesses = 0; p.recordSuccesses = 0;
    if (o.outcome === 'language' || o.outcome === 'complete_at_limit') {
      p.lastDecision = o.outcome === 'language'
        ? 'language_failure_observed_no_budget_claim' : 'complete_at_limit_no_reduction';
      return p;
    }
    if (!currentPlan) { p.lastDecision = 'stale_target_observation_no_reduction'; return p; }
    p.languageStreak = 0;
    p.target = Math.max(WORKLOAD_POLICY.minimumOutputTarget, Math.floor(p.target * .8));
    if (o.outcome === 'structure' && o.plan.units > 1) p.records = Math.max(1, Math.min(p.records, o.plan.units - 1));
    p.lastDecision = o.outcome === 'length' ? 'reduce_next_workload_after_truncation' :
      o.outcome === 'structure' ? 'reduce_records_after_incomplete_structure' : 'reduce_next_workload_after_repeated_language_failures';
    // No retry, no calibration from wrong-language or censored output.
  }
  if (p.target !== oldTarget || p.records !== oldRecords) p.revision += 1;
  return p;
}
