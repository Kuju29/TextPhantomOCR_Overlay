// Totals are token counts, not a discounted balance or a monetary invoice.
const value = x => typeof x === 'number' && Number.isFinite(x) ? x.toLocaleString('en-US') : '—';
const partial = row => row.tokenStatus === 'incomplete' || row.incompleteRequests > 0 || row.pendingOperations > 0 || row.pendingOverflow > 0;
export function formatUsageLabel(row) { return partial(row) ? 'Tokens recorded' : 'Tokens used'; }
export function formatUsageSummary(row) {
  return `${value(row.totalTokens)}${partial(row) ? ' · incomplete' : ''}`;
}
export function formatUsageLines(row) {
  const subset = key => {
    const n = row.tokenCoverage?.[key];
    return row[key] != null && typeof n === 'number' && n < row.requests ? `; ${n}/${row.requests} calls reported` : '';
  };
  const lines = [[partial(row) ? 'Recorded total' : 'Total tokens', value(row.totalTokens)],
    ['Input', value(row.inputTokens)], ['Output', value(row.outputTokens)],
    ['Cached input (included)', value(row.cachedInputTokens) + subset('cachedInputTokens')]];
  if (row.uncachedInputTokens != null) lines.push(['Uncached input', value(row.uncachedInputTokens) + subset('uncachedInputTokens')]);
  lines.push(['Requests', value(row.requests)]);
  // A zero/nonreported reasoning breakdown is not necessary on every UI refresh.
  if (row.thinkingTokens > 0) lines.push(['Reasoning (included in output)', value(row.thinkingTokens) + subset('thinkingTokens')]);
  if (row.cacheWriteInputTokens > 0) lines.push(['Cache write (included in input)', value(row.cacheWriteInputTokens) + subset('cacheWriteInputTokens')]);
  if (row.incompleteRequests > 0) lines.push(['Requests missing usage', value(row.incompleteRequests)]);
  if (row.pendingOperations > 0) lines.push(['Awaiting usage', value(row.pendingOperations)]);
  if (row.pendingOverflow > 0) lines.push(['Older unresolved requests', value(row.pendingOverflow)]);
  if (row.providerCostUsd != null && row.runtime !== 'local') lines.push(['Reported cost', `$${row.providerCostUsd}${row.costReportedRequests < row.requests ? ' (incomplete)' : ''}`]);
  return lines.map(([label, text]) => `${label}: ${text}`).join('\n');
}
