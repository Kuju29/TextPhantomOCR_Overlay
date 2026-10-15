import { getStorage, setStorage } from '../shared/storage.js';
import { configuredAccountBase, safeAccountBase } from '../paid/client.js';
import { diagnosticFetch } from '../shared/diagnostics.js';
import { installHeaders } from '../paid/install-id.js';

const failure = (code, message, status) => Object.assign(new Error(message), { code, status });
const allowed = path => ['/paid/support', '/paid/support/status', '/paid/support/messages', '/paid/support/action', '/paid/support/presence', '/paid/support/attachments',
  '/paid/auth/status', '/paid/auth/request', '/paid/auth/verify', '/paid/auth/logout'].includes(path) ||
  /^\/paid\/support\/messages\?(?:after|before)=\d+$/.test(path) || /^\/paid\/support\/attachments\/att_[a-f0-9]{32}$/.test(path) ||
  /^\/paid\/support\/wait\?after=\d+&version=\d+&timeout=\d+$/.test(path);

export function createSupportClient({ read = getStorage, write = setStorage, fetchFn = diagnosticFetch } = {}) {
  let epoch = 0;
  const pending = new Set();
  async function scope(auth = true) {
    const values = await read(['paidSessionToken', 'paidApiBase', 'customApiUrl', 'apiUrlDefault']);
    const base = configuredAccountBase(values), token = String(values.paidSessionToken || '');
    if (!base) throw failure('API_UNAVAILABLE', 'The selected API is unavailable.');
    if (auth && (!token || safeAccountBase(values.paidApiBase) !== base))
      throw failure('SIGN_IN_REQUIRED', 'Sign in with your email to contact support.', 401);
    return { base, token, tokenBase: safeAccountBase(values.paidApiBase) };
  }
  // signal: caller-owned cancellation (a long-poll stops when the chat closes); timeoutMs
  // overrides the default bound (the wait endpoint answers within ~25 s).
  async function request(path, { body = null, file = null, commandId = '', auth = true, binary = false, identity: expected = null, signal = null, timeoutMs = 0 } = {}) {
    if (!allowed(path)) throw failure('INVALID_SUPPORT_PATH', 'Unsupported support operation.');
    const start = epoch, identity = await scope(auth);
    if (start !== epoch || expected && (expected.base !== identity.base || expected.token !== identity.token || expected.tokenBase !== identity.tokenBase))
      throw failure('STALE_SUPPORT_RESPONSE', 'Your account changed. Reopen support to continue.');
    const controller = new AbortController();
    pending.add(controller);
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs || (file || binary ? 45000 : 20000));
    try {
      const install = await installHeaders({ read, create: false });
      const response = await fetchFn(identity.base + path, { method: body !== null || file ? 'POST' : 'GET',
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: binary ? 'application/octet-stream' : 'application/json', ...install,
          ...(auth ? { Authorization: 'Bearer ' + identity.token } : {}),
          ...(file ? { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Command-ID': commandId }
            : body !== null ? { 'Content-Type': 'application/json' } : {}) },
        ...(file ? { body: file } : body !== null ? { body: JSON.stringify(body) } : {}) });
      // A non-JSON error page (proxy/old API) still reports its HTTP status to the caller.
      const value = binary && response.ok ? await response.blob() : response.ok ? await response.json()
        : await response.json().catch(() => { throw failure('SUPPORT_FAILED', 'Support request failed.', response.status); });
      const current = await scope(false);
      if (start !== epoch || identity.base !== current.base || identity.token !== current.token || identity.tokenBase !== current.tokenBase)
        throw failure('STALE_SUPPORT_RESPONSE', 'Your account changed. Reopen support to continue.');
      if (!response.ok) throw failure(value?.error?.code || 'SUPPORT_FAILED', value?.error?.message || 'Support request failed.', response.status);
      return value;
    } finally { clearTimeout(timeout); pending.delete(controller); signal?.removeEventListener('abort', cancel); }
  }
  function invalidate() { epoch++; for (const item of pending) item.abort(); pending.clear(); }
  async function signIn(email, code) {
    const identity = await scope(false);
    const result = await request('/paid/auth/verify', { body: { email, code }, auth: false });
    if (!result.token || !/^[A-Za-z0-9_-]{40,100}$/.test(result.token)) throw failure('INVALID_SESSION', 'Sign-in could not be confirmed.');
    const current = await scope(false);
    if (current.base !== identity.base || current.token !== identity.token) throw failure('STALE_SUPPORT_RESPONSE', 'Your account changed.');
    await write({ paidSessionToken: result.token, paidApiBase: identity.base, paidEmail: email, paidPendingLogin: null });
    invalidate();
    return result;
  }
  async function signOut() {
    const identity = await scope();
    try { await request('/paid/auth/logout', { body: {} }); }
    finally {
      const current = await scope(false);
      if (current.base === identity.base && current.token === identity.token)
        await write({ paidSessionToken: '', paidApiBase: '', supportUnread: null });
      invalidate();
    }
  }
  return { scope, request, signIn, signOut, invalidate };
}

export async function supportScopeId(identity) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity.base + '\0' + identity.token));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
