/* Shared customer view: no network, secrets or payment authority. */
import { checkoutLink } from './checkout.js';
import { UI_TEXT } from '../ui-text.js';
import {formatPaidTpRate} from '../paid-price-format.js';
import { uiTemplate } from '../ui-template.js';
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (['disabled', 'value', 'checked'].includes(k)) n[k] = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const x of children.flat(Infinity))
    if (x != null && x !== false)
      n.append(x instanceof Node ? x : document.createTextNode(String(x)));
  // Opt in only authored phrases. The translator never reads arbitrary account data.
  if (props.translate !== 'no') {
    const phrases = children
      .flat(Infinity)
      .filter((v) => typeof v === 'string' && UI_TEXT.has(v.trim()));
    if (phrases.length) n.dataset.tpUiTexts = JSON.stringify(phrases.map((v) => v.trim()));
  }
  return n;
}
const tp = (v) => {
  try {
    return BigInt(v ?? '0').toLocaleString('en-US');
  } catch {
    return '—';
  }
};
const money = (v) =>
  Number.isFinite(Number(v))
    ? new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: 'THB',
      }).format(Number(v) / 100)
    : '—';
const date = (v) =>
  v
    ? new Date(v).toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const states = {
  creating: 'Preparing payment',
  create_pending: 'Preparing payment',
  create_unknown: 'Checking payment creation',
  waiting: 'Ready to pay',
  processing: 'Confirming payment',
  review_required: 'Needs attention',
  review: 'Needs attention',
  credited: 'Credits added',
  cancelled: 'Cancelled',
  expired: 'Instructions expired',
  failed: 'Payment failed',
  settled: 'Completed',
  released: 'Not charged',
  uncertain: 'Under review',
  held: 'Processing',
  succeeded: 'Payment confirmed',
  active: 'Active',
  depleted: 'Used up',
  submitted: 'Historical transfer',
};
const label = (s) => states[s] || s || '—';
const pendingOrder = (o) =>
  [
    'creating',
    'create_pending',
    'create_unknown',
    'waiting',
    'processing',
    'review',
    'review_required',
  ].includes(o?.status);
const historical = (o) =>
  o.confirmation === 'operator_verifies_bank_receipt' || o.method === 'operator_verified_transfer';
const pairs = (rows) =>
  el(
    'dl',
    { class: 'tp-account-pairs' },
    rows.map(([k, v]) =>
      el('div', {}, el('dt', {}, k), el('dd', v instanceof Node ? {} : { translate: 'no' }, v)),
    ),
  );
const valueText = (v) => el('span', { translate: 'no' }, v);
const authoredValue = (v) => el('span', {}, v);
const statusValue = (s) => (states[s] ? authoredValue(states[s]) : valueText(s || '—'));
const duration = (v) =>
  uiTemplate('Valid for {months} months after credits are issued.', {
    months: v,
  });
const note = (text, warning = false) =>
  el('p', { class: 'tp-account-note' + (warning ? ' warning' : '') }, text);
const empty = (text) => el('p', { class: 'tp-account-empty' }, text);
const panel = (title, ...body) =>
  el('section', { class: 'tp-account-panel' }, el('h2', {}, title), ...body);
const disclosure = (title, ...body) =>
  el('details', { class: 'tp-account-disclosure' }, el('summary', {}, title), ...body);
function modelPriceDetails(model, refreshing = false) {
  const quote = model.pricing;
  const safe = value => typeof value === 'string' && value.length <= 80 &&
    /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
  const hasRates = quote?.status === 'estimated' && quote.unit === 'TP_PER_1000_TOKENS' &&
    safe(quote.input_tp) && safe(quote.output_tp);
  const sync = model.route_price_sync || model.price_sync;
  const paired = quote?.basis === 'paired_endpoint_metadata';
  const current = !refreshing && sync?.status === 'current' && (paired || sync?.automatic === true);
  const available = hasRates && sync?.status !== 'unavailable';
  const status = available ? current ? 'current' : 'stale' : 'unavailable';
  return el('div', { 'data-model-price-status': status },
    note(available ? current ? 'Automatic price updates' : 'Previous rates' : 'Price unavailable'),
    available && pairs([
      ['Input · TP per 1,000 tokens', formatPaidTpRate(quote.input_tp, quote.tariff_basis === 'conditional_ceiling')],
      ['Output · TP per 1,000 tokens', formatPaidTpRate(quote.output_tp, quote.tariff_basis === 'conditional_ceiling')],
    ]),
    sync?.checked_at && pairs([['Price checked', date(sync.checked_at)]]),
    model.availability?.available === false && note('This model is temporarily paused. Choose a different model or try again later.', true),
    available && paired && note(quote.tariff_basis === 'conditional_ceiling'
      ? 'Published tier ceiling per 1,000 tokens. Your request may use a cheaper tier.'
      : 'Paired route estimate per 1,000 tokens. Live availability can change.'),
    available && note('Final credits use the provider-reported cost, including any cache discount. These rates are not a charge per image or request.'),
    available && safe(quote.request_tp) && Number(quote.request_tp)>0 &&
      pairs([['Published fixed fee · TP per request', formatPaidTpRate(quote.request_tp,true)]]),
    available && quote.routing_ceiling && pairs([
      ['Maximum input among allowed routes · TP per 1,000 tokens', formatPaidTpRate(quote.routing_ceiling.input_tp, true)],
      ['Maximum output among allowed routes · TP per 1,000 tokens', formatPaidTpRate(quote.routing_ceiling.output_tp, true)],
      ...(safe(quote.routing_ceiling.request_tp) && Number(quote.routing_ceiling.request_tp)>0
        ? [['Maximum fixed fee among allowed routes · TP per request', formatPaidTpRate(quote.routing_ceiling.request_tp,true)]] : []),
    ]),
  );
}
function qrImage(value) {
  if (typeof value !== 'string') return null;
  if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  try {
    const u = new URL(value, location.href);
    if (u.origin === location.origin && u.pathname.startsWith('/api/customer/orders/'))
      return u.href;
  } catch {
    // Invalid URLs are rejected; no link is rendered.
  }
  return null;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    width: 18,
    height: 18,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'aria-hidden': 'true',
  }))
    svg.setAttribute(k, v);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const paths = {
    back: 'M19 12H5m6-6-6 6 6 6',
    reload: 'M20 8a8 8 0 0 0-14-3L3 8M3 3v5h5M4 16a8 8 0 0 0 14 3l3-3M21 21v-5h-5',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    check: 'm6 12 4 4 8-8',
    info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 11v6M12 7h.1',
    external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
    close: 'm6 6 12 12M6 18 18 6',
  };
  path.setAttribute('d', paths[name] || paths.info);
  svg.append(path);
  return svg;
}
function actionButton(text, action, kind = '', disabled = false, feedback) {
  const b = el('button', { type: 'button', class: 'tp-account-button ' + kind, disabled }, text);
  b.addEventListener('click', async () => {
    b.disabled = true;
    feedback.textContent = '';
    feedback.classList.remove('error');
    try {
      await action?.();
    } catch (e) {
      feedback.textContent =
        String(e?.message || 'The request could not be completed.') +
        (e?.code ? ' · ' + e.code : '');
      feedback.classList.add('error');
    } finally {
      b.disabled = disabled;
    }
  });
  return b;
}
export function renderAccountUnavailable(
  message,
  { onBack, onRefresh, compact = true, theme = '' } = {},
) {
  const feedback = el('div', {
    class: 'tp-account-feedback',
    translate: 'no',
    role: 'status',
    'aria-live': 'polite',
  });
  const back = actionButton('Back', onBack, 'tp-account-back', false, feedback),
    reload = actionButton('Reload', onRefresh, 'tp-account-refresh', false, feedback);
  back.prepend(icon('back'));
  reload.prepend(icon('reload'));
  const root = el(
    'section',
    { class: 'tp-account' + (compact ? ' tp-account-compact' : '') },
    el(
      'header',
      { class: 'tp-account-header' },
      el('div', { class: 'tp-account-toolbar' }, back, reload),
      el('h1', {}, 'Account unavailable'),
    ),
    el(
      'div',
      { class: 'tp-account-content' },
      el('p', { class: 'tp-account-note warning', role: 'alert', translate: 'no' }, message),
      feedback,
    ),
  );
  if (theme) root.dataset.theme = theme;
  return root;
}
export function hasRefundHistory(data) {
  const history = data?.history || {};
  return (
    Number(history.refunds?.total || 0) > 0 ||
    Boolean(history.refunds?.items?.length) ||
    (history.payments?.items || []).some((payment) => {
      const request = payment.refund?.latest_request || payment.refund?.pending_request;
      return Boolean(request?.id || request?.status);
    })
  );
}
export function customerAccountTab(data, requested) {
  if (!['details', 'buy', 'orders', 'usage', 'payment', 'refunds'].includes(requested))
    return 'details';
  return requested === 'refunds' && !hasRefundHistory(data) ? 'orders' : requested;
}
export function renderCustomerAccount(data, options = {}) {
  const refundsVisible = hasRefundHistory(data);
  const tab = customerAccountTab(data, options.tab);
  const isPreview = options.preview === true || data.preview === true;
  const testCheckout = isPreview && options.testCheckout === true && data.test_checkout === true;
  const refreshing = options.refreshing === true;
  const readOnly = refreshing || (isPreview && !testCheckout);
  const compact = options.compact === true,
    paymentOpen = tab === 'payment';
  const credits = data.credits || {},
    history = data.history || {},
    cfg = data.purchase || {};
  const recent = data.recent_credit_activity || history.ledger?.items || [];
  // A terminal order from either source must replace its stale pending copy.
  const active = options.activeOrder;
  const orders = (history.orders?.items || []).map((order) => {
    if (order.id !== active?.id) return order;
    return !pendingOrder(order) && pendingOrder(active) ? order : active;
  });
  const pending = orders.filter((o) => pendingOrder(o) && !historical(o));
  if (
    pendingOrder(options.activeOrder) &&
    !historical(options.activeOrder) &&
    !orders.some((o) => o.id === options.activeOrder.id)
  )
    pending.unshift(options.activeOrder);
  const root = el('div', {
    class: 'tp-account' + (compact ? ' tp-account-compact' : ''),
    'data-testid': 'customer-account',
    'data-account-view': tab,
    'data-account-refreshing': refreshing ? 'true' : null,
    'aria-busy': refreshing ? 'true' : null,
  });
  const feedback = el('div', {
    class: 'tp-account-feedback',
    translate: 'no',
    role: 'status',
    'aria-live': 'polite',
  });
  const btn = (text, action, kind = '', disabled = false) =>
    actionButton(text, action, kind, disabled, feedback);
  const go = (next) => options.onTab?.(next);
  const viewOrder = (order) => (options.onViewOrder || options.onOrderCreated)?.(order);
  const backLabel = paymentOpen ? 'Back to packages' : 'Back';
  const back = btn(
    backLabel,
    paymentOpen ? () => go('buy') : options.onBack || (() => go('details')),
    'tp-account-back',
  );
  back.prepend(icon('back'));
  back.setAttribute('aria-label', backLabel);
  const reload = btn('Reload', options.onRefresh, 'tp-account-refresh');
  reload.prepend(icon('reload'));
  root.append(
    el(
      'header',
      { class: 'tp-account-header' },
      el('div', { class: 'tp-account-toolbar' }, back, reload),
      el(
        'div',
        {},
        el(
          isPreview ? 'h2' : 'h1',
          {},
          {
            details: 'Account',
            buy: 'Buy credits',
            orders: 'Orders',
            refunds: 'Refunds',
            usage: 'Activity',
            payment: 'Buy credits',
          }[tab],
        ),
        el('p', { class: 'tp-account-email', translate: 'no' }, data.email || ''),
      ),
      !compact &&
        options.onSignout &&
        !isPreview &&
        el('div', { class: 'tp-account-actions' }, btn('Sign out', options.onSignout)),
    ),
  );
  if (!testCheckout)
    root.append(
      el(
        'nav',
        {
          class: 'tp-account-tabs',
          'aria-label': 'Account sections',
          'data-tab-count': refundsVisible ? '5' : '4',
          style: '--tp-account-tab-count:' + (refundsVisible ? 5 : 4),
        },
        [
          ['details', 'Account'],
          ['buy', 'Buy credits'],
          ['orders', 'Orders'],
          ['usage', 'Activity'],
          ['refunds', 'Refunds'],
        ]
          .filter(([key]) => key !== 'refunds' || refundsVisible)
          .map(([key, title]) => {
            const selected = key === tab || (paymentOpen && key === 'buy');
            const b = btn(title, () => go(key), selected ? 'selected' : '');
            if (selected) b.setAttribute('aria-current', 'page');
            return b;
          }),
      ),
    );
  const body = el('div', { class: 'tp-account-content' });
  root.append(body);
  body.append(feedback);
  if (readOnly)
    body.append(note(refreshing ? 'Showing saved account details. Checking for updates…' : 'Read-only preview · No money is charged and no credits are issued.'));
  if (testCheckout)
    body.append(note('Stripe TEST · No real money. Credits stay in this test workspace.'));
  // Restrictions set by the operator in Control Center; their own words.
  for (const row of Array.isArray(data.restrictions) ? data.restrictions : [])
    if (row?.scope !== 'paid' && typeof row?.message === 'string' && row.message)
      body.append(note(el('span', { translate: 'no' }, row.message), true));
  if (data.paid_restriction?.blocked)
    body.append(
      note(
        data.paid_restriction.reason === 'operator' && data.paid_restriction.message
          ? el('span', { translate: 'no' }, String(data.paid_restriction.message))
          : data.paid_restriction.reason === 'refund_pending'
          ? 'Paid is temporarily paused while your refund is calculated and confirmed. Existing AI requests will finish. You can view your account and history.'
          : 'Paid is restricted while a refund/dispute is reviewed. Contact the operator. Your account and history remain available.',
        true,
      ),
    );
  if (data.paid_status?.state === 'paused' && !paymentOpen)
    body.append(
      note('Translation is temporarily paused. Your credits remain in your account.', true),
    );
  const refundReasons = {
    REFUND_WINDOW_CLOSED: 'The refund request period has ended. Contact the operator in chat for help.',
    REFUND_DISABLED: 'Self-service refunds are currently unavailable. Contact the operator in chat.',
    REFUND_ACCOUNT_RESTRICTED: 'Self-service refunds are restricted on this account. Contact the operator in chat.',
    REFUND_NO_CREDITS: 'All credits from this payment have been used.',
    REFUND_BELOW_MINOR_UNIT: 'Unused credits are worth less than one satang.',
    REFUND_NOT_PURCHASED: 'This payment is not eligible for an automatic refund.',
    REFUND_NOT_CONFIGURED: 'Refunds are temporarily unavailable. Contact support.',
    REFUND_ACCOUNT_REVIEW: 'Contact the operator about the pending payment review.',
    REFUND_ALREADY_COMPLETED: 'The unused portion of this payment has already been refunded.',
    REFUND_ALREADY_REQUESTED: 'Your refund request is already being processed.',
  };

  // Window and minimum come from the Control Center refund policy.
  function refundPolicyNote(hours) {
    return note(Number(hours) > 0
      ? uiTemplate('Request within {hours} hours of payment. Only unused purchased credits from that payment are refunded at the original price. Bonus and trial credits are excluded. If AI requests are pending, the final refund is calculated after their actual usage is settled.', {hours: String(hours)})
      : 'Request within the period shown for each payment. Only unused purchased credits from that payment are refunded at the original price. Bonus and trial credits are excluded. If AI requests are pending, the final refund is calculated after their actual usage is settled.');
  }
  function refundReason(q) {
    if (q.reason === 'REFUND_BELOW_MINIMUM')
      return uiTemplate('The unused credits are worth less than the {amount} refund minimum.', {amount: money(q.minimum_satang)});
    return refundReasons[q.reason] || 'Final amount may be lower if pending AI requests use credits.';
  }
  function refundOffer(payment) {
    const q = payment.refund;
    if (!q) return null;
    const remaining = Math.max(0, Number(q.deadline_at || 0) - Date.now());
    return el(
      'section',
      { class: 'tp-account-refund-offer', 'data-refund-payment': payment.id },
      el('h3', {}, 'Request a refund'),
      pairs([
        ['Unused', tp(q.available_tp) + ' TP'],
        ['Pending AI', tp(q.held_tp) + ' TP'],
        ['Estimated refund', money(q.estimated_satang)],
        ['Request deadline', date(q.deadline_at)],
      ]),
      note(refundReason(q)),
      q.eligible && remaining > 0
        ? btn(
            'Refund unused credits',
            () => options.onRequestRefund?.(payment),
            'quiet',
            readOnly || !options.onRequestRefund,
          )
        : null,
    );
  }
  if (tab === 'refunds') {
    body.append(
      panel(
        'Refund history',
        paged('refunds', (r) =>
          panel(
            {
              waiting_usage: 'Waiting for AI usage',
              queued: 'Queued for Stripe',
              unknown: 'Waiting for Stripe confirmation',
              pending: 'Stripe is processing',
              requires_action: 'Bank details needed',
              review_required: 'Refund under account review',
              succeeded: 'Refund succeeded',
              failed: 'Refund failed · credits restored',
            }[r.status] || r.status,
            pairs([
              ['Payment', r.payment_id],
              ['Requested', date(r.created_at)],
              ['Credits in request', tp(r.reserved_tp) + ' TP'],
              [
                'Refund',
                r.amount_satang > 0
                  ? money(r.amount_satang)
                  : authoredValue('Calculated after AI usage settles'),
              ],
              ['Stripe status', r.provider_status || authoredValue('Not submitted yet')],
              ['Support code', r.error_code || '—'],
            ]),
            r.status === 'requires_action' &&
              note(
                'Check the email from Stripe and complete the bank details for your refund.',
                true,
              ),
          ),
        ),
      ),
    );
  }
  if (tab === 'buy')
    body.append(
      el(
        'div',
        { class: 'tp-account-wallet-strip' },
        el('span', {}, 'Available'),
        el('strong', {}, tp(credits.available) + ' TP'),
      ),
    );
  function paged(kind, render) {
    const page = history[kind] || { items: [], total: 0, offset: 0, limit: 25 },
      rows = page.items || [];
    const total = page.total ?? 0,
      offset = page.offset ?? 0,
      limit = page.limit ?? 25;
    const node = el('div', {}, rows.length ? rows.map(render) : empty('No records yet.'));
    if (total > limit || offset)
      node.append(
        el(
          'div',
          { class: 'tp-account-pager' },
          uiTemplate('{first}–{last} of {total}', {
            first: offset + 1,
            last: Math.min(total, offset + rows.length),
            total,
          }),
          btn(
            'Previous',
            () => options.onHistory?.(kind, Math.max(0, offset - limit), page.filter || 'all'),
            '',
            offset === 0,
          ),
          btn(
            'Next',
            () => options.onHistory?.(kind, offset + limit, page.filter || 'all'),
            '',
            !page.has_more,
          ),
        ),
      );
    return node;
  }
  const status = (order) =>
    el(
      'span',
      {
        class: 'tp-account-status',
        'data-state': order.status,
        role: 'status',
      },
      label(order.status),
    );
  const orderSummary = (order) =>
    el(
      'div',
      {
        class: 'tp-account-checkout-summary',
        'data-testid': 'checkout-summary',
      },
      el(
        'span',
        { class: 'tp-account-note' },
        uiTemplate('Selected package · {package}', {
          package: order.package_name,
        }),
      ),
      el('strong', { class: 'tp-account-checkout-amount' }, tp(order.credits) + ' TP'),
      el('div', { class: 'tp-account-order-price' }, money(order.amount_satang)),
      el('p', { class: 'tp-account-note' }, duration(order.months)),
    );
  function paymentCard(order) {
    const row = el(
      'article',
      { class: 'tp-account-payment', 'data-order-id': order.id },
      el(
        'div',
        { class: 'tp-account-payment-state' },
        el('span', {}, 'Payment status'),
        status(order),
      ),
    );
    const image = qrImage(order.qr?.image_url || order.qr_image_url);
    const qrExpired = Number(order.qr?.expires_at) > 0 && Number(order.qr.expires_at) <= Date.now();
    const checkout = order.method === 'checkout';
    const url = checkoutLink(order.checkout_url);
    const checkoutExpired =
      Number(order.checkout_expires_at) > 0 && Number(order.checkout_expires_at) <= Date.now();
    if (order.cancel_pending) {
      row.append(
        orderSummary(order),
        note(
          order.status === 'review_required'
            ? order.cancel_allowed
              ? 'Cancellation did not complete. You can check the latest status or retry cancellation. If Stripe rejects it again, give the support code below to the operator.'
              : 'Cancellation did not complete. The operator must verify this payment before it can be retried. Give the support code below to the operator.'
            : 'Waiting for Stripe to cancel this payment. A new payment becomes available after cancellation is confirmed.',
          true,
        ),
      );
    } else if (checkout && url && !checkoutExpired && order.status === 'waiting') {
      row.append(
        orderSummary(order),
        readOnly
          ? note('Payment opens only for a real order or Stripe TEST.')
          : el(
              'a',
              {
                href: url,
                target: '_blank',
                rel: 'noopener noreferrer',
                class: 'tp-account-button primary',
                'data-testid': 'stripe-checkout-link',
              },
              icon('external'),
              'Open Stripe checkout',
            ),
      );
      if (order.mode === 'test') row.append(note('Stripe TEST · No real money is charged.'));
    } else if (image && !qrExpired && order.status === 'waiting') {
      row.append(
        el(
          'div',
          { class: 'tp-account-qr' },
          orderSummary(order),
          el('img', {
            src: image,
            alt: 'Stripe PromptPay payment QR',
            width: 280,
            height: 280,
            referrerpolicy: 'no-referrer',
          }),
        ),
        note(
          order.mode === 'test'
            ? 'Authorize this payment on the Stripe test page.'
            : 'Scan with your banking app. Check the amount and recipient STRIPE PAYMENTS (THAILAND) LTD.',
        ),
      );
      if (order.mode === 'test' && typeof order.test_payment_url === 'string') {
        try {
          const u = new URL(order.test_payment_url);
          if (
            u.protocol === 'https:' &&
            !u.username &&
            !u.password &&
            (u.hostname === 'stripe.com' || u.hostname.endsWith('.stripe.com'))
          )
            row.append(
              el(
                'a',
                {
                  href: u.href,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  class: 'tp-account-button primary',
                },
                'Open Stripe test payment',
              ),
            );
        } catch {
          // Invalid URLs are rejected; no link is rendered.
        }
      }
    } else {
      row.append(orderSummary(order));
      if (order.status === 'credited')
        row.append(
          el(
            'div',
            { class: 'tp-account-success' },
            el('strong', {}, 'Payment confirmed'),
            el(
              'p',
              {},
              uiTemplate('{credits} TP added to your account.', {
                credits: tp(order.credits),
              }),
            ),
            btn('View account', () => go('details'), 'primary'),
          ),
          pairs([['Available now', tp(credits.available) + ' TP']]),
        );
      else if (['review', 'review_required', 'failed'].includes(order.status))
        row.append(
          el(
            'div',
            { class: 'tp-account-attention' },
            el('strong', {}, 'Payment needs attention'),
            el(
              'p',
              {},
              order.stripe_payment_intent_id
                ? 'The operator needs to check this payment with Stripe. Your payment has not been confirmed.'
                : 'Payment setup needs attention. Contact the operator; choosing a different package will not fix the setup.',
            ),
          ),
        );
      else if (pendingOrder(order))
        row.append(
          note(
            order.status === 'waiting'
              ? checkout
                ? checkoutExpired
                  ? 'This checkout link has expired. Check status before choosing a new payment.'
                  : 'Your payment page is not available yet. Check payment status.'
                : qrExpired
                  ? 'This QR has expired. Check the payment status before paying.'
                  : 'Your QR is not available yet. Check the payment status before paying.'
              : order.status === 'processing'
                ? 'Stripe is confirming the payment. Credits are added after verification.'
                : 'Preparing your payment with Stripe. You can return to the packages while this order is checked.',
          ),
        );
      else row.append(note('This screen does not confirm a payment.'));
    }
    if (historical(order)) row.append(note('Historical bank transfer record · Read-only.'));
    const actions = el('div', { class: 'tp-account-payment-actions' });
    if (!historical(order) && pendingOrder(order) && order.recheck_allowed !== false) {
      const check = btn(
        'Check payment status',
        () => options.onOrderAction?.(order, 'refresh'),
        checkout && url && !checkoutExpired && order.status === 'waiting' ? '' : 'primary',
        readOnly,
      );
      check.prepend(icon('reload'));
      actions.append(check);
    } else if (!historical(order) && pendingOrder(order))
      row.append(
        note(
          'The operator needs to verify this order with Stripe before it can be retried. You can still return to the packages.',
          true,
        ),
      );
    if (order.cancellation_failed)
      row.append(
        note(
          uiTemplate(
            order.cancellation_error?.provider_request_id
              ? 'Support code: {code} · Reference: {reference}'
              : 'Support code: {code}',
            {
              code:
                order.cancellation_error?.error_code ||
                order.error_code ||
                'STRIPE_CANCEL_RETRY_REQUIRED',
              reference: order.cancellation_error?.provider_request_id,
            },
          ),
          true,
        ),
      );
    if (!historical(order) && pendingOrder(order) && order.cancel_allowed) {
      const cancel = btn(
        order.cancellation_failed
          ? 'Retry cancellation'
          : checkout
            ? 'Cancel this payment'
            : 'Cancel QR & choose another payment',
        () => options.onOrderAction?.(order, 'cancel'),
        'quiet',
        readOnly,
      );
      cancel.prepend(icon('close'));
      actions.append(cancel);
    }
    if (actions.childElementCount) row.append(actions);
    if (!checkout && order.status === 'cancelled')
      row.append(
        note(
          'The previous QR is cancelled. Choose a package to pay by card or PromptPay on Stripe.',
        ),
      );
    row.append(
      disclosure(
        'Order details',
        pairs([
          ['Order reference', order.id],
          ['Created', date(order.created_at)],
          ['Credit validity', duration(order.months)],
          [
            checkout ? 'Payment link expires' : 'QR expires',
            checkout
              ? date(order.checkout_expires_at)
              : order.qr?.expires_at
                ? date(order.qr.expires_at)
                : authoredValue('Not provided'),
          ],
          ['Stripe mode', order.mode === 'test' ? authoredValue('TEST · No real money') : 'LIVE'],
          ['Stripe status', order.payment_state || authoredValue('Pending')],
          ...(order.error_code ? [['Support code', order.error_code]] : []),
          ...(order.payment_id
            ? [
                ['Payment reference', order.payment_id],
                ['Credits added', date(order.confirmed_at)],
              ]
            : []),
        ]),
      ),
    );
    const refundPayment = (history.payments?.items || []).find(
      (payment) => payment.id === order.payment_id,
    );
    if (order.status === 'credited' && refundPayment?.refund) {
      row.append(
        refundOffer(refundPayment),
        refundPolicyNote(refundPayment.refund.window_hours),
      );
    }
    return row;
  }
  function orderRow(order) {
    return el(
      'article',
      { class: 'tp-account-record', 'data-order-id': order.id },
      el(
        'div',
        { class: 'tp-account-between' },
        el('h3', { translate: 'no' }, order.package_name),
        status(order),
      ),
      el(
        'p',
        { class: 'tp-account-record-meta' },
        money(order.amount_satang) + ' · ' + tp(order.credits) + ' TP',
      ),
      el('p', { class: 'tp-account-time' }, date(order.created_at)),
      btn(order.status === 'credited' ? 'View receipt' : 'View payment', () => viewOrder(order)),
      historical(order) && note('Historical transfer · Read-only'),
    );
  }
  function creditRow(item, brief = false) {
    const amount = BigInt(item.amount_tp || '0'),
      signed = (amount > 0 ? '+' : '') + tp(amount) + ' TP';
    const typeLabels = {
      PURCHASE: 'Purchased credits',
      TRIAL: 'Trial credits',
      PROMO: 'Promotional credits',
      COMPENSATION: 'Support adjustment',
      INTERNAL: 'Account adjustment',
      GRANT: 'Account adjustment',
      ADMIN_DEDUCT: 'Support adjustment',
      RESTORE: 'Credit recovery',
      EXPIRATION: 'Credit expiry',
      USAGE: 'AI translation',
      EXPIRED_RELEASE: 'Reservation expiry',
      EXTEND: 'Credit validity',
    };
    const row = el(
      'article',
      {
        class: 'tp-account-record tp-credit-change',
        'data-credit-kind': item.kind,
        ...(item.user_run_id ? { 'data-user-run-id': item.user_run_id } : {}),
      },
      el(
        'div',
        { class: 'tp-credit-row' },
        el(
          'span',
          {
            class: 'tp-credit-icon ' + (amount > 0 ? 'added' : amount < 0 ? 'spent' : 'updated'),
          },
          icon(amount > 0 ? 'plus' : amount < 0 ? 'minus' : 'reload'),
        ),
        el(
          'div',
          { class: 'tp-credit-description' },
          item.user_run_id ? el('h3', {}, 'Translation total') : el('h3', { translate: 'no' }, item.source_label),
          el('p', { class: 'tp-account-note' }, typeLabels[item.kind] || 'Credit adjustment'),
          item.customer_message &&
            el('p', { class: 'tp-account-note', translate: 'no' }, item.customer_message),
        ),
        el(
          'div',
          { class: 'tp-credit-amount' },
          el(
            'strong',
            {
              class: amount > 0 ? 'tp-credit-added' : amount < 0 ? 'tp-credit-spent' : '',
            },
            amount === 0 ? 'Updated' : signed,
          ),
          el('p', { class: 'tp-account-time' }, date(item.created_at)),
        ),
      ),
    );
    if (Array.isArray(item.operations)) row.append(operationCharges(item.operations));
    if (!brief)
      row.append(
        disclosure(
          'Details',
          pairs([
            ['Credit type', item.credit_class || '—'],
            ['Credit validity', date(item.expires_at)],
            ['Activity reference', item.id],
            ...(item.usage_reference
              ? [
                  ['Support reference', item.usage_reference],
                  ['Model', item.model_id],
                ]
              : []),
            ...(item.payment_reference ? [['Payment reference', item.payment_reference]] : []),
            ...(item.user_run_id ? [['Run reference', item.user_run_id]] : []),
          ]),
          item.usage_reference &&
            btn('Copy support reference', () =>
              navigator.clipboard.writeText(item.usage_reference),
            ),
          item.kind === 'EXPIRED_RELEASE' &&
            note(
              'Unused reserved credits reached their expiry. They were not returned to the available balance.',
            ),
        ),
      );
    return row;
  }
  function billingProof(billing) {
    if (!billing || billing.state === 'unavailable') return null;
    if (billing.state !== 'confirmed') return note('Provider cost is pending confirmation. Reserved credits are not a final charge.');
    const rows = [['Provider-reported cost · USD', billing.cost_usd],
      ...(billing.prompt_tokens != null ? [['Input tokens', tp(billing.prompt_tokens)]] : []),
      ...(billing.completion_tokens != null ? [['Output tokens', tp(billing.completion_tokens)]] : []),
      ...(billing.cached_tokens != null ? [['Cached input tokens', tp(billing.cached_tokens)]] : []),
      ...(billing.nominal_tp != null ? [['Usage cost in TP before reservation limit', tp(billing.nominal_tp)]] : []),
      ...(Number(billing.service_covered_tp) > 0 ? [['Covered by service · TP', tp(billing.service_covered_tp)]] : [])];
    return disclosure('Cost evidence', pairs(rows), note('The charged total uses confirmed cost and the tariff saved for this request. Cached tokens may reduce cost; the model list shows comparison rates.'));
  }
  function operationCharges(operations) {
    return disclosure(
      el('span', {}, 'Request charges', ' · ', el('span', { translate: 'no' }, tp(operations.length))),
      el('div', { class: 'tp-account-run-operations' }, operations.map(operation => {
        const reference = operation.usage_reference || operation.support_reference || operation.id;
        const charged = operation.charged_tp ?? String(-BigInt(operation.amount_tp || '0'));
        return el('article', { class: 'tp-account-run-operation', 'data-usage-operation-ref': reference },
          el('div', { class: 'tp-account-between' },
            el('strong', { translate: 'no' }, (data.models || []).find(model => model.id === operation.model_id)?.name || operation.model_id || '—'),
            el('strong', { class: 'tp-credit-spent', translate: 'no' }, tp(charged) + ' TP')),
          el('p', { class: 'tp-account-time' }, date(operation.created_at)),
          operation.status && el('span', {}, label(operation.status)),
          billingProof(operation.billing),
          el('div', { class: 'tp-account-run-reference' }, el('code', { translate: 'no' }, reference),
            btn('Copy support reference', () => navigator.clipboard.writeText(reference), 'quiet')));
      })),
    );
  }
  if (tab === 'details') {
    body.append(
      el(
        'section',
        { class: 'tp-account-balance' },
        el(
          'div',
          {},
          el('span', {}, 'Available credits'),
          el('strong', {}, tp(credits.available), ' ', el('small', {}, 'TP')),
        ),
        btn('Buy credits', () => go('buy'), 'primary'),
      ),
      el(
        'div',
        { class: 'tp-account-metrics' },
        [
          ['Reserved', credits.held],
          ['Used', credits.consumed],
          ['Expiring in 30 days', data.expiring_tp],
        ].map(([k, v]) =>
          el('section', {}, el('span', {}, k), el('strong', {}, tp(v), ' ', el('small', {}, 'TP'))),
        ),
      ),
    );
    body.append(
      el(
        'section',
        { class: 'tp-account-recent' },
        el(
          'div',
          { class: 'tp-account-section-heading' },
          el('h2', {}, 'Recent credit activity'),
          btn(
            'View all activity →',
            async () => {
              await options.onHistory?.('ledger', 0, 'all');
              options.onActivityView?.('credits');
              return go('usage');
            },
            'tp-account-link',
          ),
        ),
        el(
          'div',
          { class: 'tp-account-recent-rows' },
          recent.length
            ? recent.slice(0, 3).map((x) => creditRow(x, true))
            : empty('No credit changes yet.'),
        ),
      ),
    );
    const more = disclosure('More account details');
    body.append(more);
    more.append(
      disclosure(
        'Credits received · lifetime totals',
        pairs([
          ['Purchased', tp(credits.purchased) + ' TP'],
          ['Trial', tp(credits.trial) + ' TP'],
          ['Other grants', tp(credits.granted) + ' TP'],
          ['Expired', tp(credits.expired) + ' TP'],
          ['Revoked', tp(credits.revoked) + ' TP'],
        ]),
        note('Received totals show credits issued over time, not the remaining balance.'),
      ),
    );
    const models = data.models || [];
    more.append(
      disclosure(
        uiTemplate('Translation models · {count}', { count: models.length }),
        models.length
          ? models.map((m) =>
              el(
                'article',
                { class: 'tp-account-record' },
                el(
                  'div',
                  { class: 'tp-account-between' },
                  el('h3', { translate: 'no' }, m.name),
                  el('strong', {}, tp(m.eligible_tp) + ' TP'),
                ),
                note(
                  m.trial_allowed
                    ? 'Accepts Trial credits'
                    : 'Purchased and eligible granted credits',
                ),
                disclosure(
                  'Model details',
                  pairs([
                    ['Model', m.id],
                    ['Maximum response', (m.max_output ?? m.max_tokens ?? '—') + ' tokens'],
                  ]),
                  modelPriceDetails(m, options.refreshing === true),
                ),
              ),
            )
          : empty('No models are currently enabled.'),
      ),
    );
    more.append(
      disclosure(
        uiTemplate('Credit lots · {count}', {
          count: history.lots?.total ?? 0,
        }),
        paged('lots', (lot) =>
          el(
            'article',
            { class: 'tp-account-record' },
            el(
              'div',
              { class: 'tp-account-between' },
              el(
                'h3',
                {},
                { PURCHASE: 'Purchased', TRIAL: 'Trial', GRANT: 'Grant' }[lot.kind] || lot.kind,
              ),
              el('strong', {}, tp(lot.available) + ' TP'),
            ),
            el(
              'p',
              { class: 'tp-account-time' },
              lot.expires_at
                ? uiTemplate('Expires {date}', { date: date(lot.expires_at) })
                : 'No expiry',
            ),
            disclosure(
              'Lot details',
              pairs([
                ['Status', statusValue(lot.status)],
                ['Reserved', tp(lot.held) + ' TP'],
                ['Used', tp(lot.consumed) + ' TP'],
                ['Issued', date(lot.created_at)],
              ]),
            ),
          ),
        ),
      ),
    );
  } else if (tab === 'buy') {
    if (pending.length)
      body.append(
        el(
          'section',
          { class: 'tp-account-pending' },
          el('strong', {}, 'You have a pending payment'),
          pending.map((order) =>
            el(
              'div',
              { class: 'tp-account-between' },
              el(
                'div',
                {},
                el(
                  'span',
                  { translate: 'no' },
                  order.package_name + ' · ' + money(order.amount_satang),
                ),
                el('small', {}, label(order.status)),
              ),
              btn('Resume payment', () => viewOrder(order)),
            ),
          ),
        ),
      );
    if (!cfg.ready) {
      body.append(
        note(
          cfg.availability_code === 'PURCHASES_DISABLED'
            ? 'New purchases are currently closed. Your existing credits and orders remain available.'
            : 'Payments are not available yet. Your existing credits and orders remain available.',
          true,
        ),
      );
      if (readOnly && options.onConfigurePurchases)
        body.append(
          btn(
            cfg.configuration_ready || cfg.details_complete
              ? 'เปิดขายเครดิตใน Center'
              : 'ตั้งค่า Stripe ใน Center',
            () => options.onConfigurePurchases(cfg),
            'primary',
          ),
        );
    }
    body.append(
      el(
        'div',
        { class: 'tp-account-packages' },
        (data.packages || []).map((pack) => {
          const existing = pending.find(
            (o) => o.package_id === pack.id && o.package_version === pack.version,
          );
          return el(
            'article',
            { class: 'tp-account-package' },
            el('h3', { translate: 'no' }, pack.name),
            el('strong', { class: 'tp-account-price' }, money(pack.price_satang)),
            el(
              'div',
              { class: 'tp-account-package-credits' },
              tp(pack.credits),
              ' ',
              el('small', {}, 'TP'),
            ),
            el('p', {}, duration(pack.months)),
            btn(
              existing ? 'View payment' : readOnly && !refreshing ? 'Preview package' : 'Select package',
              async () => {
                if (existing) return viewOrder(existing);
                if (readOnly)
                  return viewOrder({
                    id: 'PREVIEW-NOT-AN-ORDER',
                    package_name: pack.name,
                    amount_satang: pack.price_satang,
                    credits: pack.credits,
                    months: pack.months,
                    status: 'waiting',
                    created_at: Date.now(),
                    method: 'checkout',
                  });
                const order = await options.onBuy?.(pack);
                if (order) await viewOrder(order);
              },
              existing ? '' : 'primary',
              refreshing || (!cfg.ready && !readOnly && !existing),
            ),
          );
        }),
      ),
    );
    if (!(data.packages || []).length) body.append(empty('No packages are currently offered.'));
    const addons = data.addons || {};
    if (Array.isArray(addons.products)) {
      const cards = el('div', {
        class: 'tp-account-packages',
        style: 'grid-template-columns:1fr',
      });
      for (const pack of addons.products) {
        const entitlement = addons.entitlements?.find((x) => x.code === pack.code);
        const order = addons.orders?.find((x) => x.code === pack.code && pendingOrder(x));
        const card = el(
          'article',
          { class: 'tp-account-package', 'data-addon-code': pack.code },
          el('h3', { translate: 'no' }, order?.package_name || pack.name),
          el(
            'strong',
            { class: 'tp-account-price' },
            money(order?.amount_satang ?? pack.price_satang),
          ),
          el('p', {}, 'One-time purchase · Lifetime access'),
          note('Uses your AI account quota. TP credits are not included.'),
          (order ? order.terms : pack.terms) &&
            disclosure('Terms', el('p', { translate: 'no' }, order ? order.terms : pack.terms)),
          order
            ? order.refund_terms &&
                disclosure('Refund policy', el('p', { translate: 'no' }, order.refund_terms))
            : pack.refund_policy === 'non_refundable'
              ? note('All sales are final. This add-on is non-refundable.')
              : pack.refund_terms &&
                disclosure('Refund policy', el('p', { translate: 'no' }, pack.refund_terms)),
        );
        if (entitlement)
          card.append(
            el(
              'strong',
              {},
              entitlement.status === 'active' ? 'Activated' : 'Access ' + entitlement.status,
            ),
          );
        else if (order) {
          card.append(note(label(order.status)));
          if (checkoutLink(order.checkout_url))
            card.append(
              btn('Open Stripe checkout', () => options.onAddonAction?.(order, 'open'), 'primary', readOnly),
            );
          card.append(btn('Check payment', () => options.onAddonAction?.(order, 'recheck'), '', readOnly));
          if (order.can_cancel)
            card.append(btn('Cancel order', () => options.onAddonAction?.(order, 'cancel'), '', readOnly));
        } else
          card.append(
            btn(
              readOnly && !refreshing ? 'Preview add-on' : 'Buy add-on',
              () => options.onBuyAddon?.(pack),
              'primary',
              readOnly || !pack.ready,
            ),
          );
        if (!entitlement && !order && !pack.ready)
          card.append(note('Not available for purchase yet.'));
        cards.append(card);
      }
      // Hiding an offer must not hide its already-owned access or pending payment.
      const offered = new Set(addons.products.map((p) => p.code));
      for (const entitlement of addons.entitlements || []) {
        if (offered.has(entitlement.code)) continue;
        cards.append(el('article', { class: 'tp-account-package', 'data-addon-entitlement': entitlement.code },
          el('h3', {}, entitlement.code === 'ai_login' ? 'AI Login' : entitlement.code),
          el('p', {}, 'One-time purchase · Lifetime access'),
          el('strong', {}, entitlement.status === 'active' ? 'Activated' : 'Access ' + entitlement.status)));
      }
      for (const order of addons.orders || []) {
        if (offered.has(order.code) || !pendingOrder(order)) continue;
        const card = el('article', { class: 'tp-account-package', 'data-addon-order': order.id },
          el('h3', { translate: 'no' }, order.package_name),
          el('strong', { class: 'tp-account-price' }, money(order.amount_satang)),
          note(label(order.status)));
        if (checkoutLink(order.checkout_url)) card.append(btn('Open Stripe checkout', () => options.onAddonAction?.(order, 'open'), 'primary', readOnly));
        card.append(btn('Check payment', () => options.onAddonAction?.(order, 'recheck'), '', readOnly));
        if (order.can_cancel) card.append(btn('Cancel order', () => options.onAddonAction?.(order, 'cancel'), '', readOnly));
        cards.append(card);
      }
      if (!cards.children.length) cards.append(empty('No add-ons are currently offered.'));
      const section = el(
        'section',
        {
          class: 'tp-account-addon-section',
          style:
            'border-top:1px solid var(--tp-account-border,#38465b);padding-top:18px;margin-top:18px',
        },
        el('h2', { style: 'margin:0 0 6px' }, 'Optional add-ons'),
        note('One-time upgrades · Separate from TP credits'),
        cards,
      );
      body.append(section);
    }
    body.append(
      disclosure(
        'How payment works',
        note(
          'Credits are added after payment verification. Closing Stripe keeps the order open; cancellation completes after Stripe confirms it.',
        ),
        cfg.support_contact &&
          note(uiTemplate('Support: {contact}', { contact: cfg.support_contact })),
      ),
    );
  } else if (tab === 'payment') {
    const order = options.activeOrder;
    if (order) body.append(paymentCard(order));
    else body.append(empty('Loading the selected payment…'));
    body.append(
      disclosure(
        'Help with payment',
        note('Checking status reuses this order and does not create another charge.'),
        cfg.support_contact &&
          note(uiTemplate('Support: {contact}', { contact: cfg.support_contact })),
      ),
    );
  } else if (tab === 'orders') {
    body.append(
      panel('Your orders', paged('orders', orderRow)),
      refundPolicyNote((history.payments?.items || []).find((p) => p.refund)?.refund.window_hours),
      disclosure(
        uiTemplate('Confirmed payments · {count}', {
          count: history.payments?.total ?? 0,
        }),
        paged('payments', (p) =>
          el(
            'article',
            { class: 'tp-account-record' },
            el(
              'div',
              { class: 'tp-account-between' },
              el('h3', { translate: 'no' }, p.package_name),
              el('strong', {}, money(p.amount_satang)),
            ),
            el('p', {}, uiTemplate('{credits} TP added.', { credits: tp(p.credits) })),
            el('p', { class: 'tp-account-time' }, date(p.paid_at)),
            refundOffer(p),
            disclosure(
              'Receipt details',
              pairs([
                ['Payment reference', p.id],
                ['Status', statusValue(p.status)],
              ]),
            ),
          ),
        ),
      ),
    );
  } else if (tab === 'usage') {
    const mode = options.activityView || 'credits';
    body.append(
      el(
        'div',
        { class: 'tp-account-activity-tabs' },
        btn(
          'Credit changes',
          () => options.onActivityView?.('credits'),
          mode === 'credits' ? 'primary' : '',
        ),
        btn(
          'Translations',
          () => options.onActivityView?.('translations'),
          mode === 'translations' ? 'primary' : '',
        ),
      ),
    );
    if (mode === 'credits') {
      const filters = el(
        'select',
        {
          'aria-label': 'Filter credit activity',
          class: 'tp-account-filter',
          onchange: async (e) => {
            const select = e.target;
            select.disabled = true;
            feedback.textContent = '';
            try {
              await options.onHistory?.('ledger', 0, select.value);
            } catch (err) {
              feedback.textContent = err.message || 'Could not load credit activity.';
              feedback.classList.add('error');
              select.value = history.ledger?.filter || 'all';
            } finally {
              select.disabled = false;
            }
          },
        },
        [
          ['all', 'All changes'],
          ['added', 'Added'],
          ['used', 'Used for translation'],
          ['admin', 'Administrator changes'],
          ['expired', 'Expired'],
        ].map(([value, text]) =>
          el('option', { value, selected: value === (history.ledger?.filter || 'all') }, text),
        ),
      );
      filters.id = 'tp-credit-filter';
      body.append(
        el(
          'div',
          { class: 'tp-account-filter-row' },
          el('label', { for: filters.id }, 'Filter'),
          filters,
        ),
        paged('ledger', (item) => creditRow(item)),
        el(
          'p',
          { class: 'tp-account-info' },
          icon('info'),
          'AI reservations and releases are temporary translation holds, not final usage charges. Refund reservations hold credits pending the money refund.',
        ),
      );
    } else
      body.append(
        paged('usage', (call) =>
          el(
            'article',
            { class: 'tp-account-translation', ...(call.user_run_id ? { 'data-user-run-id': call.user_run_id } : {}) },
            el(
              'div',
              { class: 'tp-account-between' },
              el(
                'h3',
                { class: 'tp-translation-heading' },
                el(
                  'span',
                  {
                    class: 'tp-credit-icon ' + (call.status === 'settled' ? 'added' : 'updated'),
                  },
                  icon(call.status === 'settled' ? 'check' : 'info'),
                ),
                call.status === 'settled' ? 'Translation completed' : label(call.status),
              ),
              el('p', { class: 'tp-account-time' }, date(call.created_at)),
            ),
            pairs([
              [call.user_run_id ? 'Run reference' : 'Translation ID', call.user_run_id || call.support_reference || call.id],
              [
                'Model',
                (data.models || []).find((m) => m.id === call.model_id)?.name || call.model_id || 'Multiple models',
              ],
              ['Status', status(call)],
            ]),
            el(
              'div',
              { class: 'tp-account-usage-metrics' },
              [
                ['Charged', call.charged_tp],
                ['Reserved', call.reserved_tp],
                ['Released', call.released_tp],
              ].map(([key, value]) =>
                el(
                  'div',
                  {},
                  el('span', {}, key),
                  el('strong', {}, value == null ? '—' : tp(value) + ' TP'),
                ),
              ),
            ),
            !Array.isArray(call.operations) && billingProof(call.billing),
            Array.isArray(call.operations) && operationCharges(call.operations),
            Number(call.expired_reservation_tp) > 0 &&
              note(
                uiTemplate(
                  '{credits} TP of unused reservations expired and were not returned to the available balance.',
                  { credits: tp(call.expired_reservation_tp) },
                ),
              ),
            el(
              'div',
              { class: 'tp-account-translation-actions' },
              btn('View credit changes', async () => {
                await options.onHistory?.('ledger', 0, 'used');
                return options.onActivityView?.('credits');
              }),
              call.support_reference &&
                btn(
                  'Copy support reference',
                  () => navigator.clipboard.writeText(call.support_reference),
                  'quiet',
                ),
            ),
          ),
        ),
        el(
          'p',
          { class: 'tp-account-info' },
          icon('info'),
          'Reservations are temporary. Unused valid credits return after settlement; requests under review keep their hold.',
        ),
      );
  }
  return root;
}
