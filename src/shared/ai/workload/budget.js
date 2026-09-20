import { normalizeLimits, positive, textWeight } from './model.js';
export function estimateProviderInput({system = '', user = '', schema = null, image = false, history = []} = {}) {
  const prior=history.length ? history.map(m=>m.text).join("\n\n")+"\n\n" : "";
  const extra=history.reduce((n,m)=>n+(m.imageDataUri?2048:0)+8,0);
  return Math.ceil((textWeight(system) + textWeight(prior+user) +
    (schema ? textWeight(JSON.stringify(schema)) : 0) + 64 + (image ? 2048 : 0) + extra) * 1.25);
}
/** Budget control only; never edits prompts, schema, sampling or reasoning mode. */
export function guardOutputBudget({ standard, workload, limits = {}, system = '', user = '', schema = null, image = false, history = [] }) {
  if (workload?.version !== 1) return standard;
  const bound = { ...normalizeLimits(workload.limits), ...normalizeLimits(limits) };
  const input = estimateProviderInput({system, user, schema, image, history});
  const expected = positive(workload.predictedOutput) || 1;
  const reasoning = positive(workload.reasoningReserve) || 0;
  const applicationCeiling = Math.max(8192, positive(workload.completionAvailable) || 8192);
  const available = Math.min(applicationCeiling, bound.maxOutputTokens || Infinity, bound.outputHintTokens || Infinity,
    bound.contextTokens ? bound.contextTokens - input - 128 : Infinity,
    positive(workload.completionAvailable) || Infinity);
  if (input > (bound.maxInputTokens || Infinity) || available < expected + reasoning) {
    throw Object.assign(new Error('The composed prompt and estimated response exceed the available model budget.'),
      { code: 'ai_workload_budget_insufficient', requestDispatched: false, providerAttempts: 0,
        generationAttempts: 0, diagnostics: { constraintScope:'per_request',
          constraint:input>(bound.maxInputTokens||Infinity)?'input_limit':bound.contextTokens&&input+expected+reasoning+128>bound.contextTokens?'context_window':'output_budget',
          estimatedInput: input, estimatedOutput: expected, expectedOutput: expected,
          contextLimit: bound.contextTokens ?? null, outputLimit: bound.maxOutputTokens ?? null, inputLimit: bound.maxInputTokens ?? null,
          reasoningReserve: reasoning, completionAvailable: Number.isFinite(available) ? Math.max(0, available) : null } });
  }
  // Target batch size is NOT max_tokens. Retain the adapter's allowance and
  // provide extra headroom instead of truncating to the estimated answer size.
  return Math.max(1, Math.floor(Math.min(available, Math.max(standard,
    Math.min(applicationCeiling, expected + reasoning + Math.max(128, Math.ceil(expected * .5)))))));
}
