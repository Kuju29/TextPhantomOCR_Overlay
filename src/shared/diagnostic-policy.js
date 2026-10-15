// Only admission failures mean no new provider request was accepted. Pending or
// invalid upstream outcomes must not be mislabeled as pre-dispatch blocks.
const PAID_ADMISSION = new Set(['paid_model_paused', 'paid_refund_pending', 'paid_account_restricted', 'paid_paused', 'paid_login_required', 'paid_model_not_allowed',
  'paid_insufficient_credits', 'paid_daily_budget', 'paid_busy', 'paid_price_unverified',
  'paid_ai_not_configured', 'paid_ledger_unavailable', 'paid_rate_limited',
  'paid_thinking_unsupported', 'paid_thinking_unverified', 'paid_image_unsupported',
  'paid_image_invalid', 'paid_image_too_large']);
export function isPaidAdmissionBlocked(error) {
  return PAID_ADMISSION.has(String(error?.tpError?.code || error?.code || '').toLowerCase());
}
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
function isHandledTranslationError(error) {
  if (error?.name === 'TypeError' || error?.name === 'ReferenceError' || error?.name === 'SyntaxError') return false;
  if (error?.name === 'AbortError') return true;
  const code = String(error?.tpError?.code || error?.code || '').toLowerCase();
  return HANDLED.has(code);
}
export function reportTranslationFailure(log, trace, message, error, details = {}, traceId = '') {
  const code = String(error?.tpError?.code || error?.code || '');
  if (/^paid_/i.test(code)) details = {owner: 'control_center', outcome: isPaidAdmissionBlocked(error) ? 'blocked' : 'failed', ...details};
  trace?.('translationFailure', { event: message, code,
    disposition: isHandledTranslationError(error) ? 'handled_trace_only' : 'action_required', ...details }, traceId);
  if (!isHandledTranslationError(error)) log?.warn?.(message, { code, error: error?.message || String(error), ...details });
}
