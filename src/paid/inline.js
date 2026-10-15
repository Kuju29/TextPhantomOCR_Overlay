import { createAddonActions } from "./addons.js";
import { requestUnusedRefund } from './refunds.js';
/** Account navigation stays in the existing popup/side panel. Navigation and
 * a short-lived display snapshot are session-scoped. Bank details, OTP codes,
 * payment links and session tokens are never copied into the view cache. */
import { renderCustomerAccount, renderAccountUnavailable, customerAccountTab } from '../shared/customer-portal/view.js';
import { createAccountClient } from './client.js';
import { createTab } from '../shared/browser-api.js';
import { createCheckoutLauncher } from '../shared/customer-portal/checkout.js';
import { accountViewScope, createPaidViewCache, validPaidAccountView, paidInventoryDisplay, paidInventoryFailureMessage } from './view-cache.js';
import {
  createPaymentMonitor,
  paymentPending,
  paymentTerminal,
  paymentEndedUnpaid,
  reconcileAccountOrder,
  orderIdValid,
} from './payment.js';
const TABS = ['home', 'buy', 'details', 'orders', 'usage', 'payment', 'refunds'];
const KEY = 'paidInlineStateV1',
  MAX_AGE = 24 * 60 * 60 * 1000;
export const accountScope = accountViewScope;
export function validNavigation(value, scope, now = Date.now()) {
  return (
    value?.version === 1 &&
    value.scope === scope &&
    TABS.includes(value.tab) &&
    Number.isFinite(value.updatedAt) &&
    now - value.updatedAt < MAX_AGE &&
    now >= value.updatedAt - 60000
  );
}
function el(tag, text = '', attrs = {}) {
  const n = document.createElement(tag);
  n.textContent = text;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
export function createInlineAccount({
  mount,
  read,
  write,
  onVisibility = () => {},
  onBalance = () => {},
  onSignout = () => {},
  onSessionExpired = () => {},
  fetchFn,
} = {}) {
  if (!mount) return null;
  const viewCache = createPaidViewCache({read,write});
  const client = createAccountClient({
    read,
    write,
    ...(fetchFn ? { fetchFn } : {}),
    onSessionExpired: async (id, error) => {
      if (disposed || identity !== id.base + '\n' + id.token) return;
      await close();
      await onSessionExpired(id, error);
    },
  });
  const addonActions = createAddonActions({client,read,write,load,live:()=>opened(),open:url=>createTab({url})});
  let activityView = 'credits';
  let tab = 'home',
    scope = '',
    identity = '',
    epoch = 0,
    disposed = false,
    data = null,
    dataVerified = false,
    intent = null,
    activeOrder = null,
    activeOrderId = '',
    busy = false;
  let eligible = false,
    restoring = null,
    persistence = Promise.resolve(),
    activeError = '',
    checkoutError = '',
    loadSequence = 0,
    orderSequence = 0,
    navigationSequence = 0;
  const opened = () => tab !== 'home' && eligible && !disposed;
  const requireFreshAccount = () => {
    if (!dataVerified || !opened()) throw new Error('Account details are updating. Please try again after the refresh.');
  };
  const checkout = createCheckoutLauncher({
    open: (url) => createTab({ url }),
    isEligible: () => opened() && tab === 'payment',
    onError: (message) => {
      checkoutError = message;
      render();
    },
  });
  async function persist() {
    const snapshot = {
      version: 1,
      scope,
      tab,
      updatedAt: Date.now(),
      intent,
      activeOrderId,
    };
    persistence = persistence.catch(() => {}).then(() => write({ [KEY]: snapshot }));
    return persistence;
  }
  function setVisible() {
    mount.hidden = !opened();
    onVisibility(opened());
  }
  function failure(e) {
    if (disposed || !opened()) return;
    mount.replaceChildren(
      renderAccountUnavailable(e?.message || 'Your saved session has not been removed.', {
        onBack: () => close(),
        onRefresh: load,
        theme: 'dark',
      }),
    );
  }
  function render({ resetScroll = false } = {}) {
    if (!data || !opened()) return;
    const renderedEpoch = epoch, renderedScope = scope;
    const fresh = () => {
      if (renderedEpoch !== epoch || renderedScope !== scope) throw new Error('The selected account changed. Refresh to continue.');
      requireFreshAccount();
    };
    const scrollTop = resetScroll ? 0 : mount.querySelector('.tp-account-content')?.scrollTop || 0;
    const root = renderCustomerAccount(data, {
      activityView,
      onActivityView: (next) => {
        activityView = next;
        render();
      },
      tab,
      refreshing: !dataVerified,
      compact: true,
      onBack: () => close(),
      activeOrder,
      onTab: async (next) => {
        ++navigationSequence;
        checkout.cancel();
        checkoutError = '';
        tab = next;
        await persist();
        render({ resetScroll: true });
        syncPolling();
      },
      onRequestRefund: async (p) => {
        fresh();
        const refundScope = scope, expected = epoch, navigationAtStart = navigationSequence;
        if (!(await requestUnusedRefund(client, p, refundScope))) return;
        if (expected !== epoch || !opened() || scope !== refundScope) return;
        if (navigationAtStart === navigationSequence) {
          tab = 'refunds';
          await persist();
          syncPolling();
        }
        await load();
      },
      onRefresh: load,
      onSignout: () => {
        checkout.cancel();
        checkoutError = '';
        monitor.stop();
        return onSignout();
      },
      onViewOrder: async (order) => {
        fresh();
        ++navigationSequence;
        const expected = epoch;
        checkout.cancel();
        checkoutError = '';
        monitor.stop();
        await acceptOrder(order);
        if (expected !== epoch || !opened()) return;
        tab = 'payment';
        await persist();
        if (expected !== epoch || !opened()) return;
        render({ resetScroll: true });
        syncPolling();
        if (!paymentPending(order) || order.recheck_allowed !== true) return;
        try {
          const result = await client.request('/paid/orders/' + order.id + '/action', {
            body: { action: 'refresh' },
          });
          if (expected !== epoch || !opened() || activeOrderId !== order.id) return;
          if (paymentTerminal(activeOrder) && !paymentTerminal(result)) return;
          if (paymentEndedUnpaid(result) && tab === 'payment') tab = 'buy';
          await acceptOrder(result);
          updateHistory(result);
          activeError = '';
          render();
          if (paymentTerminal(result)) await load();
        } catch (e) {
          if (expected === epoch && opened() && activeOrderId === order.id) {
            activeError = e.message;
            render();
          }
        }
      },
      onBuyAddon: pack => { fresh(); return addonActions.buy(pack); },
      onAddonAction: (order, action) => { fresh(); return addonActions.action(order, action); },
      onBuy: async (pack) => {
        fresh();
        if (busy) return;
        const expected = epoch;
        const navigationAtStart = navigationSequence;
        busy = true;
        try {
          if (!intent || intent.package_id !== pack.id || intent.package_version !== pack.version)
            intent = {
              request_key: crypto.randomUUID(),
              package_id: pack.id,
              package_version: pack.version,
            };
          // Persistence precedes the POST. Retrying after popup closure reuses this key.
          await persist();
          if (expected !== epoch) throw new Error('The selected account changed.');
          const order = await client.request('/paid/orders', { body: intent });
          if (expected !== epoch) return;
          intent = null;
          if (navigationAtStart !== navigationSequence) {
            await acceptOrder(order);
            await load();
            return null;
          }
          checkoutError = '';
          checkout.arm(order);
          activeOrder = order;
          ++orderSequence;
          activeOrderId = order.id;
          tab = 'payment';
          await persist();
          if (expected !== epoch) return;
          monitor.watch(order);
          render({ resetScroll: true });
          syncPolling();
          await checkout.update(order);
          await load();
          // This controller already opened payment; a refresh must not navigate again.
          return null;
        } finally {
          if (expected === epoch) busy = false;
        }
      },
      onOrderAction: async (order, action) => {
        fresh();
        if (!['refresh', 'cancel'].includes(action)) throw new Error('Unsupported payment action.');
        const expected = epoch;
        if (action === 'cancel') checkout.cancel();
        checkoutError = '';
        const result = await client.request('/paid/orders/' + order.id + '/action', {
          body: { action },
        });
        if (expected !== epoch || !opened()) return null;
        if (activeOrderId !== order.id) {
          updateHistory(result);
          render();
          return null;
        }
        if (paymentTerminal(activeOrder) && !paymentTerminal(result)) return null;
        const returnToPackages =
          paymentEndedUnpaid(result) && (paymentPending(activeOrder) || action === 'cancel');
        monitor.stop();
        activeOrder = result;
        ++orderSequence;
        activeOrderId = result.id;
        updateHistory(result);
        if (returnToPackages && tab === 'payment') tab = 'buy';
        await persist();
        monitor.watch(result);
        syncPolling();
        render();
        if (paymentTerminal(result)) await load();
        return null;
      },
      onHistory: async (kind, offset, filter = 'all') => {
        const expected = epoch;
        const page = await client.request(
          `/paid/history?kind=${kind}&offset=${offset}&limit=25${kind === 'ledger' ? '&ledger_filter=' + encodeURIComponent(filter) : ''}`,
        );
        if (expected !== epoch || !opened()) return;
        data.history[kind] = page;
        render();
      },
    });
    // Popup and side-panel use TextPhantom's dark theme, not OS preference.
    root.dataset.theme = 'dark';
    if (activeError || checkoutError)
      root.querySelector('.tp-account-content').prepend(
        el('p', activeError || checkoutError, {
          class: 'tp-account-note warning',
          role: 'status',
        }),
      );
    mount.replaceChildren(root);
    root.querySelector('.tp-account-content').scrollTop = scrollTop;
    setVisible();
  }
  function paymentVisible() {
    return (
      opened() &&
      ['buy', 'orders', 'payment'].includes(tab) &&
      globalThis.document?.visibilityState !== 'hidden'
    );
  }
  function resolveIntent(order) {
    if (
      intent &&
      intent.package_id === order.package_id &&
      intent.package_version === order.package_version
    )
      intent = null;
  }
  function updateHistory(order) {
    const items = data?.history?.orders?.items;
    const index = items?.findIndex((row) => row.id === order.id) ?? -1;
    if (index >= 0) items[index] = order;
  }
  const monitor = createPaymentMonitor({
    request: (path) => client.request(path),
    isVisible: paymentVisible,
    onOrder: async (order) => {
      if (!opened()) return;
      const ended = paymentPending(activeOrder) && paymentEndedUnpaid(order);
      if (ended && tab === 'payment') tab = 'buy';
      activeOrder = order;
      ++orderSequence;
      activeOrderId = order.id;
      resolveIntent(order);
      updateHistory(order);
      activeError = '';
      await persist();
      render();
      await checkout.update(order);
    },
    onSettled: () => load(),
    onError: (e) => {
      if (opened()) {
        activeError = e.message;
        render();
      }
    },
  });
  function syncPolling() {
    if (paymentVisible()) {
      monitor.resume();
      if (activeOrderId && !activeOrder) void monitor.refresh(activeOrderId).catch(() => {});
    } else monitor.pause();
  }
  async function acceptOrder(order) {
    if (!opened() || !orderIdValid(order?.id)) return;
    const expected = epoch;
    activeOrder = order;
    ++orderSequence;
    activeOrderId = order.id;
    resolveIntent(order);
    await persist();
    if (expected !== epoch) return;
    monitor.watch(order);
    syncPolling();
  }
  const visibilityChanged = () => {
    if (document.visibilityState === 'hidden') checkout.cancel();
    checkoutError = '';
    syncPolling();
  };
  globalThis.document?.addEventListener?.('visibilitychange', visibilityChanged);
  // While the popup shows Paid (signed in), account details are read once in the
  // background; a click within PREFETCH_FRESH_MS uses that verified reply
  // without another round trip. Reads only; never a purchase or a write.
  const PREFETCH_FRESH_MS = 60000;
  let prefetched = null;
  function prefetch() {
    if (disposed || !eligible || !scope || opened()) return;
    if (prefetched && prefetched.epoch === epoch &&
        (prefetched.pending || Date.now() - prefetched.at < PREFETCH_FRESH_MS)) return;
    const entry = { epoch, scope, at: 0, pending: true, result: null };
    entry.promise = client.request('/paid/account', {expectedScope:scope}).then(
      (result) => { entry.result = result; entry.at = Date.now(); },
      () => {},
    ).finally(() => { entry.pending = false; });
    prefetched = entry;
  }
  async function freshPrefetch() {
    const entry = prefetched;
    if (!entry || entry.epoch !== epoch || entry.scope !== scope) return null;
    if (entry.pending) await entry.promise;
    if (entry !== prefetched || entry.epoch !== epoch || !entry.result) return null;
    if (Date.now() - entry.at >= PREFETCH_FRESH_MS) return null;
    prefetched = null; // one use: the next click reads again
    return entry.result;
  }
  async function load({ reuse = false } = {}) {
    const expected = epoch,
      sequence = ++loadSequence,
      orderAtStart = orderSequence;
    activeError = '';
    try {
      let result = (reuse && await freshPrefetch()) || await client.request('/paid/account', {expectedScope:scope});
      if (expected !== epoch || sequence !== loadSequence || !opened()) return;
      if (!validPaidAccountView(result, {requireModels:true}) || !result.history || !Array.isArray(result.packages))
        throw new Error('Account details are temporarily unavailable. Contact support with the reference code.');
      result = paidInventoryDisplay(result, data);
      activeError = paidInventoryFailureMessage(result);
      data = result;
      dataVerified = true;
      await viewCache.remember(scope, 'account', result);
      if (expected !== epoch || sequence !== loadSequence || !opened()) return;
      addonActions.sync(data);
      const resolvedTab = customerAccountTab(data, tab);
      if (resolvedTab !== tab) {
        tab = resolvedTab;
        await persist();
        if (expected !== epoch || sequence !== loadSequence || !opened()) return;
      }
      if (activeOrderId) {
        const wasPending = paymentPending(activeOrder);
        activeOrder = reconcileAccountOrder(
          data,
          activeOrder,
          activeOrderId,
          orderSequence !== orderAtStart,
        );
        if (activeOrder) {
          if (wasPending && paymentEndedUnpaid(activeOrder) && tab === 'payment') tab = 'buy';
          resolveIntent(activeOrder);
          monitor.watch(activeOrder);
        }
      }
      if (!activeOrderId) {
        const pending = result.history.orders?.items?.find(paymentPending);
        if (pending) {
          activeOrder = pending;
          activeOrderId = pending.id;
          resolveIntent(pending);
          await persist();
          if (expected !== epoch || sequence !== loadSequence) return;
          monitor.watch(pending);
        }
      }
      render();
      onBalance(result);
      if (activeOrder) await checkout.update(activeOrder);
      syncPolling();
    } catch (e) {
      if (expected === epoch && sequence === loadSequence) {
        if (data) {
          dataVerified = false;
          activeError = e.message;
          render();
        } else failure(e);
      }
    }
  }
  async function open(next = 'details') {
    if (!eligible || disposed) return;
    if (restoring) await restoring;
    if (!eligible || disposed || !scope) return;
    const expected = epoch;
    const restored = !dataVerified ? await viewCache.restore(scope, 'account', {allowStale:true}) : data;
    if (expected !== epoch || !eligible || disposed || !scope) return;
    data = restored;
    tab = TABS.includes(next) && next !== 'home' ? next : 'details';
    activeError = '';
    await persist();
    setVisible();
    if (data) render();
    else mount.replaceChildren(el('p', 'Loading your account…', { class: 'paid-footnote' }));
    await load({ reuse: true });
  }
  async function close({ forget = false } = {}) {
    checkout.cancel();
    checkoutError = '';
    ++epoch;
    prefetched = null;
    client.invalidate();
    monitor.stop();
    tab = 'home';
    data = null;
    dataVerified = false;
    activeOrder = null;
    activeError = '';
    busy = false;
    if (forget) {
      await viewCache.clear(scope);
      intent = null;
      activeOrderId = '';
    }
    setVisible();
    mount.replaceChildren();
    if (scope) await persist();
  }
  function sync({ active, base, token }) {
    const allowed = Boolean(active && base && token),
      next = allowed ? base + '\n' + token : '';
    eligible = allowed;
    if (next === identity) return;
    if (identity && scope && (!token || identity !== base + '\n' + token)) void viewCache.clear(scope);
    checkout.cancel();
    checkoutError = '';
    identity = next;
    ++epoch;
    client.invalidate();
    monitor.stop();
    data = null;
    dataVerified = false;
    activeOrder = null;
    activeOrderId = '';
    intent = null;
    tab = 'home';
    scope = '';
    setVisible();
    if (!allowed) {
      restoring = null;
      return;
    }
    const expected = epoch;
    restoring = (async () => {
      const hash = await accountScope(base, token),
        saved = (await read([KEY]))[KEY];
      if (expected !== epoch || disposed) return;
      scope = hash;
      const restored = await viewCache.restore(scope, 'account', {allowStale:true});
      if (expected !== epoch || disposed) return;
      const currentIdentity = await client.identity();
      if (scope !== await accountScope(currentIdentity.base, currentIdentity.token))
        throw new Error('The selected account changed. Refresh to continue.');
      if (expected !== epoch || disposed) return;
      data = restored;
      dataVerified = false;
      if (saved?.version === 1 && saved.scope === scope) {
        // Navigation may age out; the purchase replay key must not expire while
        // the outcome of its server-side order may still be unknown.
        // Each new popup starts at the normal translation page. Retain only
        // durable purchase replay/order identifiers across popup lifetimes.
        activeOrderId = orderIdValid(saved.activeOrderId) ? saved.activeOrderId : '';
        if (
          saved.intent &&
          /^[a-zA-Z0-9_-]{16,100}$/.test(saved.intent.request_key || '') &&
          typeof saved.intent.package_id === 'string' &&
          saved.intent.package_id.length <= 64 &&
          Number.isInteger(saved.intent.package_version)
        )
          intent = {
            request_key: saved.intent.request_key,
            package_id: saved.intent.package_id,
            package_version: saved.intent.package_version,
          };
      }
      setVisible();
      if (opened()) { if (data) render(); void load(); }
      else prefetch();
    })().catch((e) => {
      if (expected === epoch) failure(e);
    });
  }
  const changed = (changes, area) => {
    if (
      area !== 'local' ||
      !['paidSessionToken', 'paidApiBase', 'customApiUrl', 'apiUrlDefault'].some((k) => k in changes)
    )
      return;
    checkout.cancel();
    checkoutError = '';
    ++epoch;
    if (scope) void viewCache.clear(scope);
    client.invalidate();
    monitor.stop();
    eligible = false;
    identity = '';
    data = null;
    dataVerified = false;
    activeOrder = null;
    activeOrderId = '';
    intent = null;
    scope = '';
    tab = 'home';
    setVisible();
  };
  globalThis.chrome?.storage?.onChanged?.addListener?.(changed);
  function dispose() {
    checkout.cancel();
    checkoutError = '';
    disposed = true;
    ++epoch;
    client.invalidate();
    monitor.dispose();
    addonActions.dispose();
    globalThis.document?.removeEventListener?.('visibilitychange', visibilityChanged);
    globalThis.chrome?.storage?.onChanged?.removeListener?.(changed);
  }
  return { open, close, sync, dispose, isOpen: opened };
}
