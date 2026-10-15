// System lines in the support conversation (sender "system"). Besides chat
// ended/reopened, the operator's service adds refund lines with small data
// (package name, amount, kind) and a line when an account is put on hold.
// Unknown events are never shown as "Chat reopened".
const KIND = { unused: 'unused credits', pack_full: 'full pack price', addon: 'AI Login add-on' };
const SCOPE = { paid: 'TP use', purchases: 'purchases', login_chat: 'AI Login' };

const baht = (satang) =>
  '฿' + (Number(satang || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const scopes = (data) => (Array.isArray(data?.scopes) ? data.scopes : []).map((s) => SCOPE[s] || String(s)).join(', ');

// { label: fixed English text, detail: account data (kept out of UI translation) }
export function supportEventParts(message) {
  const event = String(message?.event || ''), data = message?.event_data || {};
  if (event.startsWith('closed_')) return { label: event === 'closed_idle' ? 'Chat ended automatically' : 'Chat ended', detail: '' };
  if (event.startsWith('reopened_')) return { label: 'Chat reopened', detail: '' };
  if (event === 'refund_admin' || event === 'refund_customer')
    return { label: 'Refund', detail: [String(data.package_name || ''), baht(data.amount_satang) + (data.estimated ? ' (estimated)' : ''),
      KIND[data.kind] || String(data.kind || ''), event === 'refund_admin' ? 'by support' : 'by you'].filter(Boolean).join(' · ') };
  if (event === 'refund_block') return { label: 'On hold after refund until support reviews it', detail: scopes(data) };
  if (event === 'linked_block') return { label: 'On hold: this browser was used by an account with a refund', detail: scopes(data) };
  return { label: 'Conversation update', detail: '' };
}

export function supportEventText(message) {
  const { label, detail } = supportEventParts(message);
  return detail ? label + ': ' + detail : label;
}
