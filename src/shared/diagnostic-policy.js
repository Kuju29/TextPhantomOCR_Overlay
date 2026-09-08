/** Expected content failures still reach UI/repair, but never the console. */
const HANDLED = new Set([
  'wrong_language_output', 'ai_wrong_language', 'invalid_model_output',
  'ai_output_invalid', 'ai_erase_ownership_invalid', 'repair_erase_conflict',
  'local_output_invalid', 'local_output_incomplete',
  'missing_translation_units', 'ai_incomplete', 'output_budget_exhausted',
  'ai_output_budget_exhausted', 'ai_output_contract_mismatch',
  'orientation_unresolved', 'group_orientation_invalid',
  'cancelled', 'aborted', 'no_text', 'no_translatable_text',
]);
export function isHandledTranslationError(error) {
  if (error?.name === 'TypeError' || error?.name === 'ReferenceError' || error?.name === 'SyntaxError') return false;
  if (error?.name === 'AbortError') return true;
  const code = String(error?.tpError?.code || error?.code || '').toLowerCase();
  return HANDLED.has(code);
}
export function reportTranslationFailure(log, trace, message, error, details = {}, traceId = '') {
  const code = String(error?.tpError?.code || error?.code || '');
  trace?.('translationFailure', { event: message, code,
    disposition: isHandledTranslationError(error) ? 'handled_trace_only' : 'action_required', ...details }, traceId);
  if (!isHandledTranslationError(error)) log?.warn?.(message, { code, error: error?.message || String(error), ...details });
}
