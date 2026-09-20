import { cloudProviderSpec } from "../providers/cloud-registry.js";
import { initialProfile, normalizeLimits, positive, WORKLOAD_POLICY } from './model.js';
const normalFinish = /^(stop|end_turn|eos|completed|complete)$/i;
const array = (v) => Array.isArray(v) ? v : [];
const count = (v) => Number.isInteger(v) && v >= 0 ? v : null;
const milliseconds = v => Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
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
  else if (error && /contract|model_output|invalid_result_schema/i.test(code) &&
      (error?.providerResponded === true || error?.requestDispatched === true ||
       Number(error?.providerAttempts || 0) > 0 || Number(error?.generationAttempts || 0) > 0 ||
       Object.keys(meta).length > 0)) outcome = 'structure';
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
  const reportedModel = String(meta.model || meta.resolvedModel || '');
  const identityModel = cloudProviderSpec(ai.provider)?.workloadModelIdentity?.({
    requestedModel: ai.model, reportedModel, receipt: usage,
  }) ?? reportedModel;
  const identityContract = String(meta.selectedContract || meta.outputContract || '');
  const identity = identityModel && identityContract
    ? [identityModel, identityContract].join('|')
    : answer ? [String(ai.model || ''), identityContract].join('|') : '';
  const executionObserved = Boolean(answer || error?.providerResponded === true ||
    error?.requestDispatched === true || Number(error?.providerAttempts || 0) > 0 ||
    Number(error?.generationAttempts || 0) > 0 || identityModel);
  const isolatedShortIncomplete = !structural && missing.size === 1 && units.some(u =>
    missing.has(String(u.id)) && Array.from(String(u.text || '').trim()).length <= 3);
  return { outcome, isolatedShortIncomplete, structureEligible: !isolatedShortIncomplete && units.length > 1 && plan?.phase !== 'repair', visibleTokens: visible, calibrationTokens: calibration, reasoningTokens: reasoning, actualIdentity: identity,
    providerInputTokens: count(usage.inputTokens), providerOutputTokens: output,
    cachedInputTokens: count(usage.cachedInputTokens),
    requestedOutputTokens: positive(meta.requestedOutputTokens), finishReason: finish,
    missingCount: missing.size, wrongLanguageCount: array(defects.wrongLanguage).length,
    providerMs: milliseconds(meta.providerMs ?? meta.provider_ms),
    firstContentMs: milliseconds(meta.firstContentMs ?? meta.first_content_ms),
    executionObserved, limits: normalizeLimits(meta.modelLimits), plan };
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
  // Hidden-reasoning telemetry is useful even when the visible answer is
  // truncated or structurally incomplete. It is not response-size calibration,
  // but it must reserve completion capacity for the next unsent sub-batch.
  if (o.reasoningTokens === 0 && o.outcome === 'ok') {
    p.zeroReasoningSamples += 1;
    // Store measured zeroes too. They are the only safe evidence that a later
    // Off request really stopped hidden reasoning, and allow stale positive
    // samples to age out of workload planning without guessing.
    p.reasoning = [...p.reasoning, 0].slice(-64);
  }
  if (count(o.reasoningTokens) != null && o.reasoningTokens > 0) {
    p.zeroReasoningSamples = 0;
    p.reasoning = [...p.reasoning, o.reasoningTokens].slice(-64);
  }
  const currentPlan = o.plan.revision == null || o.plan.revision === p.revision;
  const oldTarget = p.target, oldRecords = p.records, oldLatencyTarget = p.latencyOutputTarget;
  let latencyDecision = '';
  const providerMs = milliseconds(o.providerMs);
  const firstContentMs = milliseconds(o.firstContentMs);
  let generationMs = null;
  if (providerMs != null) {
    p.lastProviderMs = providerMs;
    p.lastFirstContentMs = firstContentMs;
    if (firstContentMs != null && firstContentMs <= providerMs)
      generationMs = Math.max(0, providerMs - firstContentMs);
    p.lastGenerationMs = generationMs;
  }
  if (o.outcome === 'ok') {
    p.successes += 1; p.languageStreak = 0; p.structureStreak = 0;
    if (positive(o.calibrationTokens)) {
      const ratio = o.calibrationTokens / o.plan.baseOutput;
      if (ratio >= .05 && ratio <= 32) p.ratios = [...p.ratios, ratio].slice(-64);
    }
    // Speed learning is independent of context/token capacity.  The target is
    // reduced only when generation itself is slow, or when a non-streaming
    // provider gives us no first-content boundary and the whole call is very
    // slow. A large TTFT with fast generation is routing/startup evidence, not
    // proof that the next request should contain less content.
    if (currentPlan && providerMs != null) {
      const basis = positive(o.plan.predictedOutput) || positive(o.calibrationTokens);
      const enoughOutput = positive(basis) && (basis >= WORKLOAD_POLICY.latencyEvidenceMinOutput ||
        (count(o.providerOutputTokens) || 0) >= 24);
      let candidate = null;
      if (enoughOutput && generationMs != null && generationMs >= WORKLOAD_POLICY.slowGenerationMs) {
        const scale = clamp(WORKLOAD_POLICY.targetGenerationMs / Math.max(1, generationMs),
          WORKLOAD_POLICY.latencyScaleFloor, .9);
        candidate = Math.floor(basis * scale);
        latencyDecision = 'reduce_output_after_slow_generation';
      } else if (enoughOutput && firstContentMs == null &&
          providerMs >= WORKLOAD_POLICY.slowTotalMsWhenFirstContentUnknown) {
        const scale = clamp(WORKLOAD_POLICY.targetTotalMsWhenFirstContentUnknown / Math.max(1, providerMs),
          WORKLOAD_POLICY.latencyUnknownScaleFloor, .9);
        candidate = Math.floor(basis * scale);
        latencyDecision = 'reduce_output_after_slow_total_without_ttft';
      } else if (firstContentMs != null && firstContentMs >= WORKLOAD_POLICY.slowStartupMs &&
          generationMs != null && generationMs <= WORKLOAD_POLICY.fastGenerationMs) {
        // Router/provider startup dominates. Keep the batch intact so the same
        // startup cost is not multiplied across more serialized requests.
        p.latencyFastStreak = 0;
        latencyDecision = 'slow_startup_no_batch_reduction';
      } else if (generationMs != null && generationMs <= WORKLOAD_POLICY.fastGenerationMs &&
          providerMs <= WORKLOAD_POLICY.targetGenerationMs + WORKLOAD_POLICY.slowStartupMs) {
        p.latencyFastStreak = (p.latencyFastStreak || 0) + 1;
        if (positive(p.latencyOutputTarget) && p.latencyFastStreak >= WORKLOAD_POLICY.latencyRelaxSamples) {
          const recovered = Math.ceil(p.latencyOutputTarget * WORKLOAD_POLICY.latencyRelaxFactor);
          const releaseAt = Math.max(p.target, WORKLOAD_POLICY.conversationBaselineOutputTarget);
          p.latencyOutputTarget = recovered >= releaseAt ? null : recovered;
          p.latencyFastStreak = 0;
          latencyDecision = p.latencyOutputTarget == null
            ? 'release_latency_output_cap_after_fast_generations'
            : 'relax_latency_output_cap_after_fast_generations';
        }
      }
      if (candidate != null) {
        const planTarget = positive(o.plan.target);
        if (planTarget) candidate = Math.min(candidate, Math.floor(planTarget * .85));
        candidate = Math.max(WORKLOAD_POLICY.minimumOutputTarget,
          Math.min(WORKLOAD_POLICY.maximumOutputTarget, candidate));
        p.latencyOutputTarget = positive(p.latencyOutputTarget)
          ? Math.min(p.latencyOutputTarget, candidate) : candidate;
        p.latencyFastStreak = 0;
        p.fillSuccesses = 0; p.recordSuccesses = 0;
      }
      if (latencyDecision) p.lastLatencyDecision = latencyDecision;
    }

    // Only full/near-full batches demonstrate that a larger token capacity is
    // worth trying. Do not grow on the same observation that proved the model
    // too slow for the current workload.
    if (!latencyDecision.startsWith('reduce_')) {
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
    }
    if (latencyDecision) p.lastDecision = latencyDecision;
  } else {
    p.fillSuccesses = 0; p.recordSuccesses = 0;
    if (o.outcome === 'language' || o.outcome === 'complete_at_limit') {
      p.lastDecision = o.outcome === 'language'
        ? 'language_failure_observed_no_budget_claim' : 'complete_at_limit_no_reduction';
      return p;
    }
    if (!currentPlan) { p.lastDecision = 'stale_target_observation_no_reduction'; return p; }
    p.languageStreak = 0;
    if (o.outcome === 'structure') {
      // Structural/linguistic correctness and capacity are different signals.
      // Repair and isolated short answers remain failures but are not evidence
      // that every later image needs a smaller completion budget.
      if (o.plan.phase === 'repair' || o.isolatedShortIncomplete === true) {
        p.structureStreak = 0;
        p.lastDecision = o.plan.phase === 'repair' ? 'repair_structure_no_capacity_claim' : 'isolated_short_incomplete_no_capacity_claim';
        return p;
      }
      p.structureStreak = (p.structureStreak || 0) + 1;
      if (o.structureEligible === false || p.structureStreak < 2) {
        p.lastDecision = 'structure_observed_no_capacity_claim';
        return p;
      }
      p.reliabilityRestricted = true;
      const reducedRecords = Math.max(1, Math.min(p.records, Math.floor(o.plan.units * .8)));
      p.structureStreak = 0;
      if (reducedRecords < p.records) {
        p.records = reducedRecords;
        p.lastDecision = 'reduce_records_after_repeated_structure_failures';
      } else {
        // The current learned target is already more conservative than this
        // failure can justify. Record the evidence without claiming a numeric
        // reduction that did not actually happen.
        p.lastDecision = 'structure_observed_no_capacity_claim';
      }
      // Do not reduce the token estimate: this is reliability evidence, not length.
    } else if (o.outcome === 'length') {
      p.structureStreak = 0;
      p.target = Math.max(WORKLOAD_POLICY.minimumOutputTarget, Math.floor(p.target * .8));
      p.lastDecision = 'reduce_next_workload_after_truncation';
    }
    // No retry, no calibration from wrong-language or censored output.
  }
  if (p.target !== oldTarget || p.records !== oldRecords || p.latencyOutputTarget !== oldLatencyTarget) p.revision += 1;
  return p;
}
