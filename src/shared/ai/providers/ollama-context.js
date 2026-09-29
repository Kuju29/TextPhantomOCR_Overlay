/** Native Ollama only. A loaded /api/ps window is an allocation, not a model ceiling.
 * Growth is a bounded request option, never a machine setting or a claim of free RAM.
 */
export const OLLAMA_CONTEXT_POLICY = Object.freeze({
  version: 'ollama-live-model-context-v2', fallback: 4096, step: 4096,
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
  if (!model && !runtime && !configured) return null;
  const current = Math.min(model || Infinity, runtime || configured || Math.min(model, OLLAMA_CONTEXT_POLICY.fallback));
  // The loaded allocation and Modelfile num_ctx are not architectural model
  // limits. The selected /api/show model architecture is the only proven cap.
  const ceiling = model || null;
  const input = Math.max(0, Number(estimate.estimatedInput) || 0);
  const output = Math.max(0, Number(estimate.predictedOutput) || 0);
  const reasoning = Math.max(0, Number(estimate.reasoningReserve) || 0);
  const required = Math.ceil(input + output + reasoning + 128 + Math.max(256, output * .5));
  const minimum = Math.min(ceiling || Infinity, positive(estimate.minimumContextTokens) || 0);
  // Keep an already allocated window; otherwise ask Ollama for the smallest
  // 4K step that fits this request. An unknown model max stays unknown.
  const wanted = Math.max(minimum, current >= required ? current
    : Math.ceil(required / OLLAMA_CONTEXT_POLICY.step) * OLLAMA_CONTEXT_POLICY.step);
  const requestedContextTokens = Math.min(ceiling || Infinity, wanted);
  return { limits: { ...limits, contextTokens: requestedContextTokens },
    evidence: { runtimeContext: runtime, modelContext: model, requestedContext: requestedContextTokens,
      contextCeiling: ceiling, contextRequired: Number.isFinite(required) ? required : null,
      contextPolicy: OLLAMA_CONTEXT_POLICY.version,
      contextReason: requestedContextTokens > current ? 'bounded_growth'
        : required > (ceiling || Infinity) ? 'bounded_limit' : 'current_window',
      contextVerified: false } };
}
