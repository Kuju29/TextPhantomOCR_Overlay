import { getStorage, setStorage } from '../shared/storage.js';
import { diagnosticFetch, recordDiagnostic } from '../shared/diagnostics.js';
import { normalizeUrl } from '../shared/url.js';
import { accountViewScope } from './view-cache.js';
import { installHeaders } from './install-id.js';
import { readAccountSession, withAccountSignal, DATA_CONSENT_REQUIRED } from '../shared/account-gate.js';
export function safeAccountBase(value) {
  const base = normalizeUrl(String(value || ''));
  if (!base) return '';
  try {
    const u = new URL(base);
    if (u.username || u.password || u.search || u.hash) return '';
    return u.protocol === 'https:' ||
      (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      ? base
      : '';
  } catch {
    return '';
  }
}
// An empty custom URL selects the managed default. An explicit invalid
// override must never fall back to another service with the customer's token.
export function configuredAccountBase(values = {}) {
  const custom = String(values.customApiUrl || '').trim();
  return safeAccountBase(custom || values.apiUrlDefault || '');
}
const fail = (code, message) => Object.assign(new Error(message), { code });
function accountPathAllowed(path) {
  return (
    ['/paid/account', '/paid/auth/logout', '/paid/orders', '/paid/refunds', '/paid/addons', '/paid/addon-orders', '/paid/price-quote'].includes(path) ||
    /^\/paid\/addon-orders\/ado_[a-f0-9]{32}(?:\/action)?$/.test(path) ||
    /^\/paid\/orders\/ord_[a-f0-9]{32}(?:\/action)?$/.test(path) ||
    /^\/paid\/history\?kind=(?:orders|payments|usage|lots|refunds)&offset=\d+&limit=25$/.test(
      path,
    ) ||
    /^\/paid\/history\?kind=ledger&offset=\d+&limit=25(?:&ledger_filter=(?:all|added|used|admin|expired))?$/.test(
      path,
    )
  );
}
export function createAccountClient({
  read = getStorage,
  write = setStorage,
  fetchFn = diagnosticFetch,
  timeoutMs = 20000,
  onSessionExpired = () => {},
} = {}) {
  const pending = new Set();
  const reads = new Map();
  let epoch = 0;
  // 10495: the account session only through the gate. Without data-use
  // consent every account request is refused before anything is sent.
  async function identity() {
    const session = await readAccountSession({ read, keys: ['customApiUrl', 'apiUrlDefault'] });
    const values = session.values;
    const base = safeAccountBase(values.paidApiBase),
      configured = configuredAccountBase(values);
    if (!session.consent)
      throw Object.assign(fail(DATA_CONSENT_REQUIRED, 'Allow data use to open your account. You are still signed in.'), { locked: true, signedIn: session.signedIn, requestDispatched: false });
    if (!base || !session.ok)
      throw fail('SIGN_IN_REQUIRED', 'Open the TextPhantom extension and sign in to Paid first.');
    if (base !== configured)
      throw fail(
        'SESSION_SCOPE_MISMATCH',
        'Your API address changed. Sign in on the selected API before opening this account.',
      );
    return { base, token: session.token };
  }
  async function request(path, { body = null, expectedScope = '' } = {}) {
    if (!accountPathAllowed(path))
      throw fail('INVALID_ACCOUNT_PATH', 'This account operation is not supported.');
    const started = epoch, id = await identity();
    if (expectedScope && expectedScope !== await accountViewScope(id.base, id.token))
      throw fail('STALE_ACCOUNT_RESPONSE', 'The selected account changed. Refresh to continue.');
    if (started !== epoch) throw fail('STALE_ACCOUNT_RESPONSE', 'The account changed while this request was running. Refresh to continue.');
    // Coalesce only simultaneous reads. Orders/refunds are explicit mutations
    // and retain their own server-owned idempotency keys and responses.
    const key = body === null ? JSON.stringify([started, id.base, id.token, path]) : '';
    if (key && reads.has(key)) return reads.get(key);
    const operation = execute(path, body, id, started);
    if (key) {
      reads.set(key, operation);
      void operation.finally(() => { if (reads.get(key) === operation) reads.delete(key); }).catch(() => {});
    }
    return operation;
  }
  async function execute(path, body, id, started) {
    const controller = new AbortController();
    pending.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // One random id per browser profile; the API forwards only a valid one to Center.
      const install = await installHeaders({ read, create: false });
      const res = await fetchFn(id.base + path, {
        method: body === null ? 'GET' : 'POST',
        cache: 'no-store',
        redirect: 'error',
        credentials: 'omit',
        signal: withAccountSignal(controller.signal),
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + id.token,
          ...install,
          ...(body === null ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      const value = await res.json();
      const current = await identity();
      if (epoch !== started || id.base !== current.base || id.token !== current.token)
        throw fail(
          'STALE_ACCOUNT_RESPONSE',
          'The account changed while this request was running. Refresh to continue.',
        );
      if (!res.ok) {
        const err = fail(
          value?.error?.code || 'ACCOUNT_REQUEST_FAILED',
          value?.error?.message || 'The account service could not complete this request.',
        );
        err.status = res.status;
        err.reference =
          value?.error?.request_id ||
          res.headers?.get?.('X-TP-Center-Request-ID') ||
          res.tpTraceId ||
          '';
        if (err.reference) err.message += ' · Reference: ' + err.reference;
        if (res.status === 401) await onSessionExpired(id, err);
        throw err;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw fail('ACCOUNT_RESPONSE_INVALID', 'The account service returned an invalid response.');
      recordDiagnostic(
        'paid.account.completed',
        {
          path,
          outcome: body === null ? 'ok' : 'received',
          action: body?.action || '',
          job_id: value.id || '',
        },
        id.base,
      );
      return value;
    } finally {
      clearTimeout(timer);
      pending.delete(controller);
    }
  }
  function invalidate() {
    epoch++;
    reads.clear();
    for (const c of pending) c.abort();
    pending.clear();
  }
  async function logout() {
    let id;
    try { id = await identity(); }
    catch (error) {
      // Without consent: sign out on this device only; no request is sent.
      if (error.code !== DATA_CONSENT_REQUIRED) throw error;
      await write({ paidSessionToken: '', paidApiBase: '', paidModel: '', paidPendingLogin: null });
      invalidate(); return;
    }
    try {
      await request('/paid/auth/logout', { body: {} });
    } finally {
      const current = await identity().catch(() => null);
      if (!current || current.token === id.token && current.base === id.base)
        await write({
          paidSessionToken: '',
          paidApiBase: '',
          paidModel: '',
          paidPendingLogin: null,
        });
      invalidate();
    }
  }
  return { request, identity, invalidate, logout };
}
