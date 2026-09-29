import { normalizeLimits, positive, textWeight } from './model.js';
export function estimateProviderInput({system = '', user = '', schema = null, image = false, history = []} = {}) {
  const prior=history.length ? history.map(m=>m.text).join("\n\n")+"\n\n" : "";
  const extra=history.reduce((n,m)=>n+(m.imageDataUri?2048:0)+8,0);
  return Math.ceil((textWeight(system) + textWeight(prior+user) +
    (schema ? textWeight(JSON.stringify(schema)) : 0) + 64 + (image ? 2048 : 0) + extra) * 1.25);
}
/** Budget control only; never edits prompts, schema, sampling or reasoning mode. */
export function guardOutputBudget({ standard, workload, limits = {}, userMaxOutput = null,
  requestOutputReserve = null, localReasoningRisk = false,
  system = '', user = '', sourceTexts = null, schema = null, image = false, history = [] }) {
  const hint = workload?.version === 1 ? workload : null;
  const bound = normalizeLimits(limits);
  const rawInput = estimateProviderInput({system, user, schema, image, history});
  const lmStudioRuntimeWindow = bound.source === 'lmstudio_native_loaded_instance';
  const measuredScale = lmStudioRuntimeWindow &&
    (positive(hint?.inputSampleCount) || hint?.inputUnverified === true) &&
    Number.isFinite(hint?.inputEstimateScale) && hint.inputEstimateScale >= .45 &&
    hint.inputEstimateScale <= 1 ? hint.inputEstimateScale : 1;
  const input = Math.ceil(rawInput * measuredScale);
  const inputUnverified = lmStudioRuntimeWindow && hint?.inputUnverified === true;
  const sourceUnits = Array.isArray(sourceTexts) && sourceTexts.length ? sourceTexts : [user];
  const substantive = sourceUnits.map(s=>Array.from(String(s??'')).filter(ch=>!(/\s/u).test(ch)).join(''));
  const chars = substantive.reduce((n,s)=>n+Array.from(s).length,0);
  const weight = substantive.reduce((n,s)=>n+textWeight(s),0);
  // An estimate can size one real long translation; it cannot authorize an
  // arbitrary completion from a tiny source or 60K whitespace characters.
  const sourceAllowance = Math.max(1024,Math.ceil(Math.max(chars,weight)*3+sourceUnits.length*112+384));
  const expected = Math.min(positive(hint?.predictedOutput) || 1,sourceAllowance);
  const reasoning = Math.min(positive(hint?.reasoningReserve) || 0,8192);
  const available = Math.min(bound.maxOutputTokens || Infinity,
    bound.contextTokens ? bound.contextTokens - input - 128 : Infinity,
    positive(userMaxOutput) || Infinity, positive(requestOutputReserve) || Infinity);
  if (input > (bound.maxInputTokens || Infinity) || available < expected + reasoning) {
    throw Object.assign(new Error('The composed prompt and estimated response exceed the available model budget.'),
      { code: 'ai_workload_budget_insufficient', requestDispatched: false, providerAttempts: 0,
        generationAttempts: 0, diagnostics: { constraintScope:'per_request',
          constraint:input>(bound.maxInputTokens||Infinity)?'input_limit':bound.contextTokens&&input+expected+reasoning+128>bound.contextTokens?'context_window':'output_budget',
          estimatedInput: input, inputEstimateStatus: inputUnverified ? 'provider_count_pending' :
            measuredScale < 1 ? 'calibrated_from_provider_usage' : 'script_estimate',
          estimatedOutput: expected, expectedOutput: expected,
          contextLimit: bound.contextTokens ?? null, outputLimit: bound.maxOutputTokens ?? null, inputLimit: bound.maxInputTokens ?? null,
          reasoningReserve: reasoning, completionAvailable: Number.isFinite(available) ? Math.max(0, available) : null } });
  }
  // Target batch size is NOT max_tokens. Retain the adapter's allowance and
  // provide extra headroom instead of truncating to the estimated answer size.
  const requested = Math.max(standard,
    hint ? expected + reasoning + Math.max(128,Math.ceil(expected*.5)) : standard,
    localReasoningRisk ? 8192 : 0);
  return Math.max(1,Math.floor(Math.min(available,requested,
    Math.max(standard,sourceAllowance+reasoning,localReasoningRisk ? 8192 : 0))));
}
