import { normalizeLimits, positive, textWeight } from './model.js';
/** Budget control only; never edits prompts, schema, sampling or reasoning mode. */
export function guardOutputBudget({ standard, workload, limits = {}, system = '', user = '', schema = null, image = false }) {
  if (workload?.version !== 1) return standard;
  const bound = { ...normalizeLimits(workload.limits), ...normalizeLimits(limits) };
  const input = Math.ceil((textWeight(system) + textWeight(user) +
    (schema ? textWeight(JSON.stringify(schema)) : 0) + 64 + (image ? 2048 : 0)) * 1.25);
  const expected = positive(workload.predictedOutput) || 1;
  const reasoning = positive(workload.reasoningReserve) || 0;
  const available = Math.min(8192, bound.maxOutputTokens || Infinity, bound.outputHintTokens || Infinity,
    bound.contextTokens ? bound.contextTokens - input - 128 : Infinity,
    positive(workload.completionAvailable) || Infinity);
  if (input > (bound.maxInputTokens || Infinity) || available < expected + reasoning) {
    throw Object.assign(new Error('The composed prompt and estimated response exceed the available model budget.'),
      { code: 'ai_workload_budget_insufficient', requestDispatched: false, providerAttempts: 0,
        generationAttempts: 0, diagnostics: { estimatedInput: input, expectedOutput: expected,
          reasoningReserve: reasoning, completionAvailable: Number.isFinite(available) ? available : null } });
  }
  // Target batch size is NOT max_tokens. Retain the adapter's allowance and
  // provide extra headroom instead of truncating to the estimated answer size.
  return Math.max(1, Math.floor(Math.min(available, Math.max(standard,
    Math.min(8192, expected + reasoning + Math.max(128, Math.ceil(expected * .5)))))));
}
