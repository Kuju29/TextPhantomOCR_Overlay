/** Browser navigation only. Payment evidence and credit issuance belong to Center.
 * This one-shot intent stays in memory: restoring a payment never opens Stripe.
 */
export function checkoutLink(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      url.hostname === 'checkout.stripe.com' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443')
    )
      return url.href;
  } catch {
    // Reject malformed URLs without exposing payment details.
  }
  return null;
}

export function createCheckoutLauncher({
  open,
  isEligible = () => true,
  onError = () => {},
  onCancel = () => {},
}) {
  let orderId = null;
  function cancel() {
    orderId = null;
    onCancel();
  }
  function arm(order) {
    orderId =
      order?.selection_result === 'created' && /^ord_[a-f0-9]{32}$/.test(order.id || '')
        ? order.id
        : null;
    if (!orderId) onCancel();
  }
  async function update(order) {
    if (!orderId || order?.id !== orderId) return;
    if (
      !isEligible() ||
      order.cancel_pending ||
      !['creating', 'create_pending', 'create_unknown', 'waiting'].includes(order.status)
    ) {
      cancel();
      return;
    }
    if (order.status !== 'waiting' || order.method !== 'checkout') return;
    const url = checkoutLink(order.checkout_url);
    if (!url) return;
    const deadlines = [order.checkout_expires_at, order.payment_expires_at];
    if (deadlines.some((value) => Number(value) > 0 && Number(value) <= Date.now())) {
      cancel();
      return;
    }
    // Consume before awaiting navigation; polling and duplicate responses cannot reopen it.
    orderId = null;
    try {
      await open(url);
    } catch {
      onError('Stripe could not be opened automatically. Use Open Stripe checkout to continue.');
    }
  }
  return { arm, update, cancel };
}
