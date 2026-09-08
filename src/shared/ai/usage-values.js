// Exact provider observations only. No token estimator or price table here.
export const TOKEN_FIELDS = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens",
  "cacheWriteInputTokens", "uncachedInputTokens", "ordinaryInputTokens", "thinkingTokens", "visibleOutputTokens"];
export const token = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const object = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
export const decimal = (v) => typeof v === "string" && v.length <= 128 && /^\d+(?:\.\d+)?$/.test(v) ? v : null;
export function addDecimal(a, b) {
  if (decimal(b) == null) return a ?? null;
  if (decimal(a) == null) return b;
  const n = Math.max((a.split(".")[1] || "").length, (b.split(".")[1] || "").length);
  const units = (v) => BigInt(v.split(".")[0] + (v.split(".")[1] || "").padEnd(n, "0"));
  const total = String(units(a) + units(b)).padStart(n + 1, "0");
  return n ? `${total.slice(0, -n)}.${total.slice(-n)}` : total;
}
export function localProviderUsage(data, dialect = "openai") {
  const raw = dialect === "ollama" ? object(data) : object(data?.usage);
  const input = token(dialect === "ollama" ? raw.prompt_eval_count : raw.prompt_tokens ?? raw.input_tokens);
  const output = token(dialect === "ollama" ? raw.eval_count : raw.completion_tokens ?? raw.output_tokens);
  const prompt = object(raw.prompt_tokens_details ?? raw.input_tokens_details);
  const completion = object(raw.completion_tokens_details ?? raw.output_tokens_details);
  const read = token(dialect === "ollama" ? raw.prompt_eval_cached_count : prompt.cached_tokens ?? raw.prompt_cache_hit_tokens);
  const write = token(prompt.cache_write_tokens), thought = token(completion.reasoning_tokens);
  const total = token(dialect === "ollama" ? raw.total_count : raw.total_tokens) ??
    (input != null && output != null ? token(input + output) : null);
  const issues = [];
  if (read != null && input != null && read > input) issues.push("cache_read_exceeds_input");
  if (input != null && output != null && total != null && total !== input + output) issues.push("provider_total_differs_from_input_plus_output");
  if (write != null && input != null && write > input) issues.push("cache_write_exceeds_input");
  if (read != null && write != null && input != null && read + write > input) issues.push("cache_read_write_exceeds_input");
  if (thought != null && output != null && thought > output) issues.push("reasoning_exceeds_output");
  return { inputTokens: input, outputTokens: output, totalTokens: total,
    cachedInputTokens: read, cacheWriteInputTokens: write,
    uncachedInputTokens: input != null && read != null && read <= input ? input - read : null,
    ordinaryInputTokens: input != null && read != null && write != null && read + write <= input ? input - read - write : null,
    thinkingTokens: thought, visibleOutputTokens: output != null && thought != null && thought <= output ? output - thought : null,
    source: [input, output, total].some(v => v != null) ? "provider" : null,
    usageStatus: issues.length ? "inconsistent" : [input, output, total].every(v => v != null) ? "reported" : "incomplete",
    accountingIssues: issues, accountingOrigin: "local_runtime", providerCostUsd: null,
    providerGenerationId: typeof data?.id === "string" ? data.id : "", billingEligible: false };
}
export function aggregateUsage(items) {
  const generations = items.map(object), result = {}, tokenCoverage = {};
  for (const key of TOKEN_FIELDS) {
    const values = generations.map(v => token(v[key])).filter(v => v != null);
    result[key] = values.length ? token(values.reduce((a,b) => a+b,0)) : null;
    tokenCoverage[key] = values.length;
  }
  const reported = generations.filter(usageIsComplete).length;
  return { ...result, generations, generationCount: generations.length,
    reportedGenerations: reported, missingUsageGenerations: generations.length - reported,
    usageStatus: reported === generations.length && generations.length ? "reported" : "incomplete",
    source: generations.some(v => v.source === "provider") ? "provider" : null,
    tokenCoverage, providerCostUsd: generations.reduce((a,v) => addDecimal(a,v.providerCostUsd), null),
    costReportedGenerations: generations.filter(v => decimal(v.providerCostUsd) != null).length };
}
export function usageIsComplete(value) {
  return TOKEN_FIELDS.slice(0,3).every(k => token(value?.[k]) != null) &&
    value.inputTokens + value.outputTokens === value.totalTokens &&
    !(value?.accountingIssues?.length) &&
    !["incomplete", "unavailable", "inconsistent", "incomplete_due_to_early_completion"].includes(value?.usageStatus);
}
export function usageEventFields(usage) {
  const u = object(usage);
  return { ...u, usage: u, providerCostUsd: decimal(u.providerCostUsd),
    generationUsage: Array.isArray(u.generations) ? u.generations : undefined };
}
