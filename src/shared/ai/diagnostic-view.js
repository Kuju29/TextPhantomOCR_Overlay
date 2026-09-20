// Latest request only. Validation is not a claim of translation quality or placement.
const metric = n => typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
const results = {complete_at_contract_boundary:'Text checks passed', incomplete_ids:'Missing text',
  wrong_language:'Wrong language',output_truncated:'Answer cut short',cancelled:'Cancelled',rate_limited:'Rate limited',
  input_budget_rejected:'Not sent: input limit',transport_failure:'Request failed',protocol_failure:'Invalid response',unverified:'Not verified'};
export function formatRequestStatus(row) {
  if (!row) return '';
  return row.result ? results[row.result.resultStatus] || 'Not verified' : 'Awaiting result';
}
export function formatRequestDiagnostic(row) {
  if (!row) return 'No recent request.';
  const b=row.budget || {}, o=row.result || {}, fields=[['Status',formatRequestStatus(row)],
    ['Task',`${(b.attemptKind || o.attemptKind)==='repair'?'Repair':'Translation'} · ${metric(b.requestUnits)} text units`]];
  if(row.conversation) fields.push(["Mode", `Conversation · ${metric(row.conversation.historyTurns)} earlier turns`]);
  // Missing values stay unknown; never show estimated tokens as consumption.
  const total=Number.isFinite(o.actualInput)&&Number.isFinite(o.actualOutput)?o.actualInput+o.actualOutput:null;
  fields.push(['Tokens',metric(total)],['Input / output',`${metric(o.actualInput)} / ${metric(o.actualOutput)}`]);
  if (row.coordination?.waitMs > 0) fields.push(['Cache wait',`${(row.coordination.waitMs/1000).toFixed(2)} s`]);
  if (o.cachedInput != null) fields.push(['Cached input (included)',metric(o.cachedInput)]);
  if (o.actualReasoning > 0) fields.push(['Reasoning (included in output)',metric(o.actualReasoning)]);
  if (o.missingCount > 0) fields.push(['Missing text',metric(o.missingCount)]);
  if (o.wrongLanguageCount > 0) fields.push(['Wrong language',metric(o.wrongLanguageCount)]);
  return fields.map(([label,value])=>`${label}: ${value}`).join('\n');
}
