import { uiMessage } from '../shared/ui-language.js';
/** Stable request identities prevent a lost response from creating a new refund. */
const intents = new Map();
export async function requestUnusedRefund(client, payment, scope) {
  if (
    !confirm(
      uiMessage('Refund all unused purchased credits from this payment? Paid pauses while pending AI usage and the refund are settled. The final amount may differ from the estimate.'),
    )
  )
    return false;
  const id = JSON.stringify([scope, payment.id]);
  if (payment.refund?.latest_request?.status === 'failed') intents.delete(id);
  let key = intents.get(id);
  if (!key) {
    key = crypto.randomUUID().replaceAll('-', '');
    intents.set(id, key);
  }
  await client.request('/paid/refunds', { body: { payment_id: payment.id, request_key: key } });
  return true;
}
