import { createAddonActions } from "./addons.js";
import { uiMessage } from '../shared/ui-language.js';
import { requestUnusedRefund } from './refunds.js';
import { renderCustomerAccount, renderAccountUnavailable, customerAccountTab } from '../shared/customer-portal/view.js';
import { createAccountClient, safeAccountBase } from './client.js';
import { createCheckoutLauncher } from '../shared/customer-portal/checkout.js';
import {
  createPaymentMonitor,
  paymentPending,
  paymentTerminal,
  paymentEndedUnpaid,
  reconcileAccountOrder,
  orderIdValid,
} from './payment.js';
import { accountScope } from './inline.js';
import { getStorage, setStorage } from '../shared/storage.js';
import { createTab } from '../shared/browser-api.js';
import { diagnosticFetch, configureDiagnosticsFromMeta } from '../shared/diagnostics.js';
import { createPaidViewCache, validPaidAccountView, paidInventoryDisplay, paidInventoryFailureMessage } from './view-cache.js';
const viewCache = createPaidViewCache({read:getStorage,write:setStorage});
let activityView = 'credits';
const mount = document.getElementById('account'),
  client = createAccountClient({
    onSessionExpired: async (id) => {
      const current = await getStorage(['paidSessionToken', 'paidApiBase']);
      if (
        closed ||
        current.paidSessionToken !== id.token ||
        safeAccountBase(current.paidApiBase) !== id.base
      )
        return;
      checkout.cancel();
      checkoutError = '';
      const expiredEpoch = ++viewEpoch, expiredScope = scope;
      client.invalidate();
      monitor.stop();
      await viewCache.clear(expiredScope);
      const beforeClear = await getStorage(['paidSessionToken', 'paidApiBase']);
      if (closed || viewEpoch !== expiredEpoch || beforeClear.paidSessionToken !== id.token ||
        safeAccountBase(beforeClear.paidApiBase) !== id.base) return;
      scope = '';
      data = null;
      dataVerified = false;
      activeOrder = null;
      activeOrderId = '';
      await setStorage({
        paidSessionToken: '',
        paidApiBase: '',
        paidModel: '',
        paidPendingLogin: null,
      });
      const latest = await getStorage(['paidSessionToken', 'paidApiBase']);
      if (closed || latest.paidSessionToken || safeAccountBase(latest.paidApiBase)) return;
      failure(new Error('Your session has expired. Open the extension and sign in again.'));
    },
  });
const addonActions = createAddonActions({client,read:getStorage,write:setStorage,load,live:()=>!closed && Boolean(scope),open:url=>createTab({url})});
let data = null, dataVerified = false,
  viewEpoch = 0,
  tab = new URL(location.href).searchParams.get('tab') || 'details';
const KEY = 'paidAccountStateV1';
let scope = '',
  intent = null,
  activeOrder = null,
  activeOrderId = '',
  persistence = Promise.resolve(),
  activeError = '',
  checkoutError = '',
  closed = false,
  buying = false,
  orderSequence = 0,
  navigationSequence = 0;
async function persist() {
  const snapshot = { scope, intent, activeOrderId, tab };
  persistence = persistence.catch(() => {}).then(() => setStorage({ [KEY]: snapshot }));
  return persistence;
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
const checkout = createCheckoutLauncher({
  open: (url) => createTab({ url }),
  isEligible: () => !closed && !!scope && tab === 'payment',
  onError: (message) => {
    checkoutError = message;
    render();
  },
});
const visible = () =>
  !closed &&
  !!scope &&
  ['buy', 'orders', 'payment'].includes(tab) &&
  document.visibilityState !== 'hidden';
const monitor = createPaymentMonitor({
  request: (path) => client.request(path),
  isVisible: visible,
  onOrder: async (order) => {
    const ended = paymentPending(activeOrder) && paymentEndedUnpaid(order);
    if (ended && tab === 'payment') {
      tab = 'buy';
      const u = new URL(location.href);
      u.searchParams.set('tab', tab);
      history.replaceState(null, '', u);
    }
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
  onError: (error) => {
    activeError = error.message;
    render();
  },
});
const syncPolling = () => {
  if (visible()) {
    monitor.resume();
    if (activeOrderId && !activeOrder) void monitor.refresh(activeOrderId).catch(() => {});
  } else monitor.pause();
};
async function acceptOrder(order) {
  if (closed || !scope || !orderIdValid(order?.id)) return;
  const expected = viewEpoch;
  activeOrder = order;
  ++orderSequence;
  activeOrderId = order.id;
  resolveIntent(order);
  await persist();
  if (expected !== viewEpoch || closed) return;
  monitor.watch(order);
  syncPolling();
}
function failure(error) {
  monitor.pause();
  mount.replaceChildren(
    renderAccountUnavailable(
      error?.message ||
        'The account service is unavailable. Your saved session has not been removed.',
      {
        compact: false,
        onBack: () => createTab({ url: chrome.runtime.getURL('popup/popup.html') }),
        onRefresh: load,
        theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : '',
      },
    ),
  );
}
function render({ resetScroll = false } = {}) {
  if (!data || closed) return;
  const renderedScope = scope;
  const fresh = () => {
    if (!dataVerified || closed || !scope || scope !== renderedScope)
      throw new Error('Account details are updating. Please try again after the refresh.');
  };
  const scrollTop = resetScroll ? 0 : mount.querySelector('.tp-account-content')?.scrollTop || 0;
  const changeTab = async (next) => {
    ++navigationSequence;
    checkout.cancel();
    checkoutError = '';
    tab = next;
    const u = new URL(location.href);
    u.searchParams.set('tab', tab);
    history.replaceState(null, '', u);
    await persist();
    render({ resetScroll: true });
    syncPolling();
  };
  const current = renderCustomerAccount(data, {
    onBack: () => {
      location.href = chrome.runtime.getURL('popup/popup.html');
    },
    activityView,
    onActivityView: (next) => {
      activityView = next;
      render();
    },
    tab,
    refreshing: !dataVerified,
    activeOrder,
    onViewOrder: async (order) => {
      fresh();
      ++navigationSequence;
      const expected = viewEpoch;
      checkout.cancel();
      checkoutError = '';
      monitor.stop();
      await acceptOrder(order);
      if (expected !== viewEpoch || closed || !scope) return;
      await changeTab('payment');
      if (
        expected !== viewEpoch ||
        closed ||
        !scope ||
        !paymentPending(order) ||
        order.recheck_allowed !== true
      )
        return;
      try {
        const result = await client.request('/paid/orders/' + order.id + '/action', {
          body: { action: 'refresh' },
        });
        if (expected !== viewEpoch || closed || !scope || activeOrderId !== order.id) return;
        if (paymentTerminal(activeOrder) && !paymentTerminal(result)) return;
        if (paymentEndedUnpaid(result) && tab === 'payment') await changeTab('buy');
        await acceptOrder(result);
        updateHistory(result);
        activeError = '';
        render();
        if (paymentTerminal(result)) await load();
      } catch (e) {
        if (expected === viewEpoch && !closed && scope && activeOrderId === order.id) {
          activeError = e.message;
          render();
        }
      }
    },
    onTab: changeTab,
    onRequestRefund: async (p) => {
      fresh();
      const refundScope = scope, navigationAtStart = navigationSequence;
      if (!(await requestUnusedRefund(client, p, refundScope))) return;
      if (closed || scope !== refundScope) return;
      if (navigationAtStart === navigationSequence) {
        tab = 'refunds';
        const u = new URL(location.href);
        u.searchParams.set('tab', tab);
        history.replaceState(null, '', u);
        await persist();
        syncPolling();
      }
      await load();
    },
    onRefresh: load,
    onSignout: async () => {
      if (!confirm(uiMessage('Sign out of TextPhantom on this browser?'))) return;
      const signoutScope = scope;
      checkout.cancel();
      checkoutError = '';
      ++viewEpoch;
      monitor.stop();
      await client.logout();
      await viewCache.clear(signoutScope);
      scope = '';
      intent = null;
      activeOrder = null;
      activeOrderId = '';
      await persist();
      data = null;
      failure(new Error('Signed out. Open the extension to sign in again.'));
    },
    onBuyAddon: pack => { fresh(); return addonActions.buy(pack); },
    onAddonAction: (order, action) => { fresh(); return addonActions.action(order, action); },
    async onBuy(pack) {
      fresh();
      if (buying) return;
      buying = true;
      const expected = viewEpoch;
      const navigationAtStart = navigationSequence;
      try {
        if (!intent || intent.package_id !== pack.id || intent.package_version !== pack.version)
          intent = {
            request_key: crypto.randomUUID(),
            package_id: pack.id,
            package_version: pack.version,
          };
        await persist();
        if (expected !== viewEpoch || closed) return;
        const order = await client.request('/paid/orders', { body: intent });
        if (expected !== viewEpoch || closed) return;
        intent = null;
        await acceptOrder(order);
        if (expected !== viewEpoch || closed || !scope) return;
        if (navigationAtStart !== navigationSequence) {
          await load();
          return null;
        }
        await changeTab('payment');
        if (expected !== viewEpoch || closed || !scope) return;
        checkoutError = '';
        checkout.arm(order);
        await checkout.update(order);
        await load();
        // Preserve the user's navigation while the account refresh is in flight.
        return null;
      } finally {
        buying = false;
      }
    },
    async onOrderAction(order, action) {
      fresh();
      if (!['refresh', 'cancel'].includes(action)) throw new Error('Unsupported payment action.');
      const expectedScope = scope;
      if (action === 'cancel') checkout.cancel();
      checkoutError = '';
      const result = await client.request('/paid/orders/' + order.id + '/action', {
        body: { action },
      });
      if (expectedScope !== scope || closed) return null;
      if (activeOrderId !== order.id) {
        updateHistory(result);
        render();
        return null;
      }
      if (paymentTerminal(activeOrder) && !paymentTerminal(result)) return null;
      const returnToPackages =
        paymentEndedUnpaid(result) && (paymentPending(activeOrder) || action === 'cancel');
      monitor.stop();
      await acceptOrder(result);
      updateHistory(result);
      if (returnToPackages && tab === 'payment') await changeTab('buy');
      else render();
      if (paymentTerminal(result)) await load();
      return null;
    },
    async onHistory(kind, offset, filter = 'all') {
      const seq = viewEpoch;
      const page = await client.request(
        `/paid/history?kind=${kind}&offset=${offset}&limit=25${kind === 'ledger' ? '&ledger_filter=' + encodeURIComponent(filter) : ''}`,
      );
      if (seq !== viewEpoch) return;
      data.history[kind] = page;
      render();
    },
  });
  if (matchMedia('(prefers-color-scheme: dark)').matches) current.dataset.theme = 'dark';
  if (activeError || checkoutError)
    current.querySelector('.tp-account-content').prepend(
      Object.assign(document.createElement('p'), {
        className: 'tp-account-note warning',
        textContent: activeError || checkoutError,
      }),
    );
  mount.replaceChildren(current);
  current.querySelector('.tp-account-content').scrollTop = scrollTop;
}
async function load() {
  const seq = ++viewEpoch,
    orderAtStart = orderSequence;
  try {
    if (!scope) {
      const id = await client.identity(),
        hash = await accountScope(id.base, id.token),
        saved = (await getStorage([KEY]))[KEY];
      if (seq !== viewEpoch || closed) return;
      scope = hash;
      const restored = await viewCache.restore(scope, 'account');
      if (seq !== viewEpoch || closed) return;
      const currentIdentity = await client.identity();
      if (scope !== await accountScope(currentIdentity.base, currentIdentity.token))
        throw new Error('The selected account changed. Refresh to continue.');
      if (seq !== viewEpoch || closed) return;
      data = restored;
      dataVerified = false;
      if (saved?.scope === scope) {
        if (
          !new URL(location.href).searchParams.has('tab') &&
          ['details', 'buy', 'orders', 'usage', 'payment', 'refunds'].includes(saved.tab)
        )
          tab = saved.tab;
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
      if (data) render();
    }
    let result = await client.request('/paid/account', {expectedScope:scope});
    if (seq !== viewEpoch || closed) return;
    if (!validPaidAccountView(result, {requireModels:true}) || !Array.isArray(result.packages) || !result.history)
      throw new Error('Account details are temporarily unavailable. Contact support with the reference code.');
    result = paidInventoryDisplay(result, data);
    activeError = paidInventoryFailureMessage(result);
    data = result;
    dataVerified = true;
    await viewCache.remember(scope, 'account', result);
    if (seq !== viewEpoch || closed) return;
    addonActions.sync(data);
    const resolvedTab = customerAccountTab(data, tab);
    if (resolvedTab !== tab) {
      tab = resolvedTab;
      const u = new URL(location.href);
      u.searchParams.set('tab', tab);
      history.replaceState(null, '', u);
      await persist();
      if (seq !== viewEpoch || closed) return;
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
        if (wasPending && paymentEndedUnpaid(activeOrder) && tab === 'payment') {
          tab = 'buy';
          const u = new URL(location.href);
          u.searchParams.set('tab', tab);
          history.replaceState(null, '', u);
        }
        resolveIntent(activeOrder);
        monitor.watch(activeOrder);
      }
    }
    if (!activeOrderId) {
      const pending = result.history.orders?.items?.find(paymentPending);
      if (pending) await acceptOrder(pending);
    }
    render();
    syncPolling();
    if (activeOrder) await checkout.update(activeOrder);
  } catch (e) {
    if (seq === viewEpoch) {
      if (data) {
        dataVerified = false;
        activeError = e.message;
        render();
      } else {
        data = null;
        failure(e);
      }
    }
  }
}
const changed = (changes, area) => {
  if (
    area !== 'local' ||
    !['paidSessionToken', 'paidApiBase', 'customApiUrl', 'apiUrlDefault'].some((k) => k in changes)
  )
    return;
  checkout.cancel();
  checkoutError = '';
  client.invalidate();
  monitor.stop();
  ++viewEpoch;
  if (scope) void viewCache.clear(scope);
  scope = '';
  intent = null;
  activeOrder = null;
  activeOrderId = '';
  data = null;
  dataVerified = false;
  failure(
    new Error(
      'Your saved account or API address changed. Refresh this page to load the current account.',
    ),
  );
};
chrome.storage.onChanged.addListener(changed);
const visibilityChanged = () => {
  if (document.visibilityState === 'hidden') checkout.cancel();
  checkoutError = '';
  syncPolling();
};
document.addEventListener('visibilitychange', visibilityChanged);
window.addEventListener('pagehide', () => {
  checkout.cancel();
  checkoutError = '';
  closed = true;
  ++viewEpoch;
  monitor.dispose();
  addonActions.dispose();
  document.removeEventListener('visibilitychange', visibilityChanged);
  client.invalidate();
  chrome.storage.onChanged.removeListener(changed);
});
// Public metadata only. Diagnostics configuration failure must not hide the account.
(async () => {
  try {
    const id = await client.identity();
    const res = await diagnosticFetch(id.base + '/meta', {
      cache: 'no-store',
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) configureDiagnosticsFromMeta(id.base, await res.json());
  } catch {}
})();
// Account first paint must not wait for optional diagnostics metadata.
void load();
