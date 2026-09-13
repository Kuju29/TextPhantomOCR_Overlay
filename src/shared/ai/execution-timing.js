// Only durations reported for the current dispatch belong in execution timing.
// A missing sample remains unknown; historical replay durations are excluded.
export function summarizeExecutionTiming(results = []) {
  const generated = results.filter(result => result?.replayed !== true);
  const sumKnown = field => generated.length && generated.every(result =>
    typeof result?.meta?.[field] === "number" && Number.isFinite(result.meta[field]) && result.meta[field] >= 0)
    ? generated.reduce((sum, result) => sum + result.meta[field], 0) : null;
  const providerMs = sumKnown("providerMs");
  return {
    providerMs,
    providerSamples: generated.length,
    providerLearningEligible: results.length === 1 && generated.length === 1 &&
      generated[0]?.failed !== true && Number(generated[0]?.meta?.generationAttempts) === 1,
    providerTimingComplete: providerMs !== null,
    serverTotalMs: sumKnown("dt_ms"),
    rateWaitMs: sumKnown("rateWaitMs"),
    admissionWaitMs: sumKnown("admissionWaitMs"),
    replayed: results.length > 0 && generated.length === 0,
  };
}

export function providerLearningSample(timing, { repaired = false } = {}) {
  return !repaired && timing?.replayed !== true && timing?.providerSamples === 1 && timing?.providerLearningEligible === true &&
    timing?.providerTimingComplete === true && Number.isFinite(timing?.providerMs) && timing.providerMs > 0
    ? timing.providerMs : 0;
}
