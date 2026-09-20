/** Native Ollama only. A loaded /api/ps window is an allocation, not a model ceiling.
 * Growth is a bounded request option, never a machine setting or a claim of free RAM.
 */
export const OLLAMA_CONTEXT_POLICY = Object.freeze({
  version: 'ollama-request-context-v1', fallback: 4096, step: 4096, autoCeiling: 16384,
});
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 100_000_000 ? value : null;

export function ollamaContextMetadata(show) {
  const info = show?.model_info;
  const architecture = typeof info?.['general.architecture'] === 'string' ? info['general.architecture'] : '';
  // Do not mistake a vision encoder's context field or the model name for a text limit.
  const modelContextTokens = positive(info?.[`${architecture}.context_length`]);
  const parameter = typeof show?.parameters === 'string'
    ? show.parameters.match(/^\s*num_ctx\s+(\d+)\s*$/m) : null;
  const configuredContextTokens = parameter ? positive(Number(parameter[1])) : null;
  return { ...(modelContextTokens ? { modelContextTokens } : {}),
    ...(configuredContextTokens ? { configuredContextTokens } : {}) };
}

export function planOllamaContext(limits = {}, estimate = {}) {
  // Caller must also own the native Ollama route. Never apply this to a Cloud
  // catalogue or an OpenAI-compatible local server that cannot honor num_ctx.
  if (limits.scope !== 'runtime' || !String(limits.source || '').startsWith('ollama-api')) return null;
  const model = positive(limits.modelContextTokens);
  const runtime = positive(limits.runtimeContextTokens) || positive(limits.contextTokens);
  const configured = positive(limits.configuredContextTokens);
  const current = Math.min(model || Infinity, runtime || configured || OLLAMA_CONTEXT_POLICY.fallback);
  const ceiling = model ? Math.min(model, Math.max(current, OLLAMA_CONTEXT_POLICY.autoCeiling)) : current;
  const input = Math.max(0, Number(estimate.estimatedInput) || 0);
  const output = Math.max(0, Number(estimate.predictedOutput) || 0);
  const reasoning = Math.max(0, Number(estimate.reasoningReserve) || 0);
  const required = Math.ceil(input + output + reasoning + 128 + Math.max(256, output * .5));
  const minimum = Math.min(ceiling, positive(estimate.minimumContextTokens) || 0);
  // Keep a window that already fits; otherwise request the smallest 4K step.
  // If even the bounded window cannot fit, retain that bound for the guard to reject.
  const wanted = Math.max(minimum, current >= required ? current
    : Math.ceil(required / OLLAMA_CONTEXT_POLICY.step) * OLLAMA_CONTEXT_POLICY.step);
  const requestedContextTokens = Math.min(ceiling, wanted);
  return { limits: { ...limits, contextTokens: requestedContextTokens },
    evidence: { runtimeContext: runtime, modelContext: model, requestedContext: requestedContextTokens,
      contextCeiling: ceiling, contextRequired: Number.isFinite(required) ? required : null,
      contextPolicy: OLLAMA_CONTEXT_POLICY.version,
      contextReason: requestedContextTokens > current ? 'bounded_growth'
        : required > ceiling ? (model ? 'bounded_limit' : 'model_limit_unknown') : 'current_window',
      contextVerified: false } };
}
