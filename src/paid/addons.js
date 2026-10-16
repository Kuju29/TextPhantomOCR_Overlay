import { checkoutLink } from '../shared/customer-portal/checkout.js';
const KEY = 'paidAddonPurchaseIntentV1';
const pending = row => ['creating', 'waiting', 'processing'].includes(row?.status);
async function scope(id) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id.base + '\n' + id.token));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
// Pending add-on orders are re-read with a bounded backoff (3.5 s ... 5 min)
// instead of every 3.5 s / 6 s for as long as they stay pending; sync() with a new
// order list (page refresh, account change) starts the schedule again.
export const ADDON_POLL_MS = Object.freeze([3500, 7000, 15000, 30000, 60000, 120000, 300000]);
export function createAddonActions({ client, read, write, load, live, open, delays = ADDON_POLL_MS,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  let busy = false, timer = null, stopped = false, rows = [], armed = '', requestScope = '', round = 0, watched = '';
  function stop() { if (timer) clearTimeoutFn(timer); timer = null; }
  function next() {
    stop();
    if (stopped || !live() || !rows.some(pending) || round >= delays.length) return;
    timer = setTimeoutFn(() => void tick(), delays[round++]);
  }
  function sync(data) {
    rows = data?.addons?.orders || [];
    const key = rows.filter(pending).map(row => row.id + ':' + row.status).join(',');
    if (key !== watched) { watched = key; round = 0; }
    next();
  }
  async function tick() {
    timer = null;
    if (stopped || !live()) return;
    try {
      for (const row of rows.filter(pending).slice(0, 5)) {
        const updated = await client.request('/paid/addon-orders/' + row.id);
        if (stopped || !live()) return;
        if (armed === row.id && updated.status === 'waiting' && checkoutLink(updated.checkout_url)) {
          const currentScope = await scope(await client.identity());
          if (currentScope === requestScope) { armed = ''; await open(checkoutLink(updated.checkout_url)); }
        }
        if (updated.status !== 'creating' && updated.status !== 'waiting') armed = '';
      }
      await load();
    } catch (error) {
      // 10495: data use withdrawn: stop polling (nothing more is sent).
      if (/^DATA_CONSENT_/.test(error?.code || '')) { stop(); return; }
      next();
    }
  }
  async function buy(pack) {
    if (busy) return;
    busy = true;
    try {
      const id = await client.identity(), currentScope = await scope(id);
      const saved = await read(KEY);
      let intent = saved?.[KEY];
      if (!intent || intent.scope !== currentScope || intent.code !== pack.code || intent.product_version !== pack.version)
        intent = { scope: currentScope, request_key: crypto.randomUUID(), code: pack.code, product_version: pack.version };
      await write({[KEY]: intent});
      const body = { request_key: intent.request_key, code: intent.code, product_version: intent.product_version };
      const order = await client.request('/paid/addon-orders', { body });
      await write({[KEY]: null});
      if (!stopped && live() && currentScope === await scope(await client.identity())) {
        requestScope = currentScope;
        armed = order.selection_result === 'created' ? order.id : '';
        await load();
        if (armed && order.status === 'waiting' && checkoutLink(order.checkout_url)) { armed = ''; await open(checkoutLink(order.checkout_url)); }
      }
      return order;
    } finally { busy = false; }
  }
  async function action(order, action) {
    if (action === 'open') {
      const current = await client.request('/paid/addon-orders/' + order.id);
      const url = checkoutLink(current.checkout_url);
      if (!url) throw new Error('Checkout is not ready. Refresh this order shortly.');
      await open(url);
      return;
    }
    armed = '';
    await client.request('/paid/addon-orders/' + order.id + '/action', {body:{action}});
    await load();
  }
  return { buy, action, sync, dispose() { stopped = true; armed = ''; stop(); } };
}
