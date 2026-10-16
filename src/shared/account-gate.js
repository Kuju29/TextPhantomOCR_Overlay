/**
 * The account gate (10495) — the ONLY way any code obtains the TextPhantom
 * account session for network use.
 *
 * A user who is signed in but has not allowed data use (or revoked it) stays
 * signed in, but nothing account-related leaves the extension: no request with
 * the account token, email, cookie or chat. Every caller asks here:
 *
 *   readAccountSession()  → {ok:true, token, base, email, signal} only with
 *                           consent; otherwise {ok:false, locked, ...} and
 *                           never the token.
 *   requireAccountSession() → the same, or throws DATA_CONSENT_REQUIRED.
 *   accountState()        → {signedIn, consent, email, base} for UI (no token,
 *                           no network).
 *   onAccountGateChanged(listener) → consent or session changed (any context).
 *   accountSignal()/withAccountSignal(signal) → aborts on revocation.
 *   showConsentScreen()/ensureAccountConsent() → the consent screen.
 *   installAccountLock() → greys [data-account-control] elements while locked;
 *                           a click opens the consent screen, Allow replays it.
 *   revokeAccountConsent() → withdraw; aborts in-flight account requests at once.
 *
 * Automatic paths without consent are silent no-ops: they get {ok:false} and
 * send nothing. Consent itself is stored by shared/data-consent.js (Firefox:
 * the browser's data_collection permission; elsewhere chrome.storage).
 */
import './privacy-content.js';
import { getStorage, setStorage } from './storage.js';
import {
  DATA_CONSENT_KEY, DATA_CONSENT_OFFERED_KEY, DATA_CONSENT_REQUIRED, dataConsentError, hasDataConsent,
  onDataConsentChanged, revokeDataConsent,
} from './data-consent.js';
import { openDataConsentDialog } from './data-consent-dialog.js';

export { DATA_CONSENT_REQUIRED };
export const ACCOUNT_TOKEN_KEY = 'paidSessionToken';
// Mirror of the consent answer written by the background, for content scripts
// (they cannot read Firefox's permission state). Display/no-op hint only.
export const ACCOUNT_GATE_STATE_KEY = 'tpAccountGateV1';
const SESSION_KEYS = Object.freeze(['paidSessionToken', 'paidApiBase', 'paidEmail']);
export const ACCOUNT_SESSION_KEYS = SESSION_KEYS;

let consentKnown = null;
let generation = new AbortController();
const listeners = new Set();

/** Last answer seen in this context (null before the first read). */
export const accountConsentKnown = () => consentKnown;

function lockedError(revoked = false) {
  const error = dataConsentError({ revoked });
  if (revoked) error.name = 'AbortError';
  return error;
}

/** Aborts when data use is withdrawn (the current generation). */
export function accountSignal() { return generation.signal; }

/** `signal` combined with the revocation signal (either aborts). */
export function withAccountSignal(signal = null) {
  const gate = generation.signal;
  if (!signal) return gate;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, gate]);
  const controller = new AbortController();
  const forward = source => () => { try { controller.abort(source.reason); } catch {} };
  for (const source of [signal, gate]) {
    if (source.aborted) { forward(source)(); break; }
    source.addEventListener('abort', forward(source), { once: true });
  }
  return controller.signal;
}

function notify(detail) {
  for (const listener of [...listeners]) {
    try { void listener(detail); } catch {}
  }
}

function settle(allowed, reason = 'consent') {
  const before = consentKnown;
  consentKnown = allowed === true;
  if (before === true && !consentKnown) {
    const old = generation;
    generation = new AbortController();
    try { old.abort(lockedError(true)); } catch {}
  }
  if (before !== consentKnown) notify({ consent: consentKnown, reason });
  return consentKnown;
}

/** Re-read consent (one place), update every listener in this context. */
export async function refreshAccountGate({ read = null } = {}) {
  let allowed = false;
  try { allowed = await hasDataConsent({ read }); } catch { allowed = false; }
  return settle(allowed);
}

/** Is account data allowed right now? (async, authoritative) */
export const accountAllowed = (options = {}) => refreshAccountGate(options);

/**
 * The account session for a network request, or a locked result.
 * @param {{read?: (keys:string[])=>Promise<object>, keys?: string[]}} [options]
 *   `read` reads storage (default chrome.storage.local); `keys` are extra keys
 *   read in the same call (returned in `values`, never the token).
 */
export async function readAccountSession({ read = getStorage, keys = [] } = {}) {
  const wanted = [...new Set([...SESSION_KEYS, DATA_CONSENT_KEY, ...keys.filter(key => key !== ACCOUNT_TOKEN_KEY)])];
  const stored = await read(wanted) || {};
  // One read: an injected store answers the consent record from the same snapshot.
  const consent = await refreshAccountGate({ read: read === getStorage ? null : async () => stored });
  const token = String(stored.paidSessionToken || '');
  const values = Object.fromEntries(Object.entries(stored).filter(([key]) => key !== ACCOUNT_TOKEN_KEY && key !== DATA_CONSENT_KEY));
  const base = String(stored.paidApiBase || '').replace(/\/+$/, '');
  const email = String(stored.paidEmail || '');
  const signal = generation.signal;
  if (!consent) return { ok: false, locked: Boolean(token), signedIn: Boolean(token), consent: false, reason: 'consent', base, email, values, signal };
  if (!token) return { ok: false, locked: false, signedIn: false, consent: true, reason: 'signed_out', base, email, values, signal };
  return { ok: true, locked: false, signedIn: true, consent: true, token, base, email, values, signal };
}

/** readAccountSession(), or throw: DATA_CONSENT_REQUIRED (nothing sent) / SIGN_IN_REQUIRED.
 * `revoked: true` (a job that already passed the gate when it started) reports
 * DATA_CONSENT_REVOKED instead. */
export async function requireAccountSession({ revoked = false, ...options } = {}) {
  const session = await readAccountSession(options);
  if (session.ok) return session;
  if (!session.consent) throw dataConsentError({ revoked });
  throw Object.assign(new Error('Sign in to your TextPhantom account first.'), { code: 'SIGN_IN_REQUIRED', status: 401, requestDispatched: false });
}

/** A request for `provider`: Paid and Login carry the account token, so they
 * need the gate (a job that started with consent and finds it gone reports
 * DATA_CONSENT_REVOKED). Returns the revocation signal, or null for others. */
export async function accountRequestGate(provider, options = {}) {
  if (!['paid', 'login'].includes(String(provider || ''))) return null;
  return (await requireAccountSession({ ...options, revoked: true })).signal;
}
/** Abort `controller` with `reason` when `gate` aborts; returns the unlink. */
export function abortOnRevoke(gate, controller, reason) {
  if (!gate) return () => {};
  const onAbort = () => controller.abort(reason);
  if (gate.aborted) onAbort(); else gate.addEventListener('abort', onAbort, { once: true });
  return () => gate.removeEventListener('abort', onAbort);
}
/** The error of a request stopped by a withdrawn consent. */
export const revokedRequestError = (extra = {}) => Object.assign(dataConsentError({ revoked: true }), extra);

/** Throws DATA_CONSENT_REQUIRED unless data use is allowed (no token needed). */
export async function requireAccountConsent(options = {}) {
  if (!(await refreshAccountGate(options))) throw lockedError();
}

/** UI state without the token and without network. */
export async function accountState({ read = getStorage } = {}) {
  const stored = await read([...SESSION_KEYS, DATA_CONSENT_KEY]) || {};
  const consent = await refreshAccountGate({ read: read === getStorage ? null : async () => stored });
  return { signedIn: Boolean(String(stored.paidSessionToken || '')), consent,
    email: String(stored.paidEmail || ''), base: String(stored.paidApiBase || '').replace(/\/+$/, '') };
}

let watching = null;
function watch() {
  if (watching) return;
  const stopConsent = onDataConsentChanged(() => { void refreshAccountGate(); });
  const storage = globalThis.chrome?.storage?.onChanged || globalThis.browser?.storage?.onChanged;
  const onStorage = (changes, area) => {
    if (area !== 'local' || !changes) return;
    if (SESSION_KEYS.some(key => key in changes)) notify({ consent: consentKnown === true, reason: 'session' });
    if (changes[ACCOUNT_GATE_STATE_KEY]) void refreshAccountGate();
  };
  try { storage?.addListener?.(onStorage); } catch {}
  watching = () => { stopConsent(); try { storage?.removeListener?.(onStorage); } catch {} watching = null; };
}

/** Run `listener({consent, reason})` when consent or the session changes. */
export function onAccountGateChanged(listener) {
  listeners.add(listener);
  watch();
  return () => { listeners.delete(listener); };
}

/**
 * The consent screen. Allow (in the dialog's click) records consent; the gate
 * is refreshed before this resolves, so callers can proceed at once.
 * @returns {Promise<{consent:boolean, permissions:boolean|null, shown:boolean}>}
 */
export async function showConsentScreen(options = {}) {
  const result = await openDataConsentDialog(options);
  if (result?.consent) { settle(true); await refreshAccountGate(); }
  return result;
}

/** Consent already given → {consent:true, shown:false}; otherwise the screen. */
export async function ensureAccountConsent({ read = null, ...options } = {}) {
  if (await refreshAccountGate({ read })) return { consent: true, permissions: null, shown: false };
  return showConsentScreen(options);
}

/** Withdraw data use. In-flight account requests in this context abort at once;
 * other contexts follow through the storage/permission change. */
export async function revokeAccountConsent() {
  settle(false, 'revoked');
  let done = false;
  try { done = await revokeDataConsent(); } finally { await refreshAccountGate(); }
  return done;
}

/** Background: keep the mirror for content scripts and react to revocation
 * (Chrome: storage change; Firefox: permissions.onRemoved). */
export function installAccountGateBackground({ onLocked = () => {}, onUnlocked = () => {}, write = setStorage } = {}) {
  let last = null;
  const publish = async () => {
    const allowed = await refreshAccountGate();
    if (allowed === last) return;
    const previous = last;
    last = allowed;
    // A revocation anywhere (also Firefox's add-on settings) is the user's
    // decision: the popup's one-time offer must not pop up after it.
    const revoked = !allowed && previous === true ? { [DATA_CONSENT_OFFERED_KEY]: { at: Date.now(), revoked: true } } : {};
    try { await write({ [ACCOUNT_GATE_STATE_KEY]: { consent: allowed, at: Date.now() }, ...revoked }); } catch {}
    if (!allowed && previous !== null) { try { await onLocked(); } catch {} }
    if (allowed && previous === false) { try { await onUnlocked(); } catch {} }
  };
  const stop = onAccountGateChanged(detail => { if (detail?.reason !== 'session') void publish(); });
  // Registered synchronously at worker start so the event wakes the worker.
  const api = globalThis.browser?.permissions || globalThis.chrome?.permissions;
  const onRemoved = () => { void publish(); };
  try { api?.onRemoved?.addListener?.(onRemoved); } catch {}
  void publish();
  return () => { stop(); try { api?.onRemoved?.removeListener?.(onRemoved); } catch {} };
}

// ------------------------------------------------------------- UI: lock helper
let replayContext = null;
/** Inside a click replayed after Allow: {permissions} granted in that dialog. */
export const accountReplay = () => replayContext;

const LOCK_STYLE = `
[data-account-locked] [data-account-control]:not([data-account-free]){opacity:.45;filter:grayscale(.7);cursor:not-allowed}
[data-account-locked] [data-account-control]:not([data-account-free]) *{cursor:not-allowed}
`;

function disabledDescriptor(el) {
  for (let proto = Object.getPrototypeOf(el); proto; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'disabled');
    if (descriptor?.get && descriptor?.set) return descriptor;
  }
  return null;
}

/**
 * Grey every `[data-account-control]` while data use is not allowed. A greyed
 * control stays clickable: the click opens the consent screen instead of its
 * own action. On Allow a button-like control is clicked again (replay); a
 * select or field is just unlocked. `[data-account-free]` (Sign out) is never
 * locked. Controllers keep writing `.disabled`; while locked the element stays
 * clickable and the controller's value is restored on unlock.
 */
export function installAccountLock({ doc = globalThis.document, selector = '[data-account-control]',
  consentOptions = () => ({}), onAllowed = null, read = null } = {}) {
  if (!doc?.documentElement) return { dispose() {}, refresh: async () => false, locked: () => false };
  let locked = consentKnown !== true, disposed = false, opening = false;
  const patched = new Set();
  if (!doc.getElementById?.('tp-account-lock-style')) {
    const style = doc.createElement('style'); style.id = 'tp-account-lock-style'; style.textContent = LOCK_STYLE;
    (doc.head || doc.documentElement).append(style);
  }
  const controls = () => [...(doc.querySelectorAll?.(selector) || [])];
  const free = el => Boolean(el?.closest?.('[data-account-free]'));
  function patch(el) {
    if (patched.has(el) || free(el)) return;
    const descriptor = disabledDescriptor(el);
    if (descriptor) {
      let wanted = descriptor.get.call(el);
      Object.defineProperty(el, 'disabled', { configurable: true,
        get() { return wanted; },
        set(value) { wanted = Boolean(value); descriptor.set.call(el, locked ? false : wanted); } });
      el.__tpAccountApply = () => descriptor.set.call(el, locked ? false : wanted);
    }
    patched.add(el);
  }
  function apply() {
    if (disposed) return;
    for (const el of controls()) patch(el);
    if (locked) doc.documentElement.setAttribute?.('data-account-locked', '');
    else doc.documentElement.removeAttribute?.('data-account-locked');
    for (const el of patched) {
      if (!el.isConnected && el.isConnected !== undefined) { continue; }
      el.__tpAccountApply?.();
      if (locked) el.setAttribute?.('aria-disabled', 'true');
      else if (el.getAttribute?.('aria-disabled') === 'true') el.removeAttribute?.('aria-disabled');
    }
  }
  const target = event => {
    const el = event.target?.closest?.(selector);
    return el && !free(event.target) && !free(el) ? el : null;
  };
  const buttonLike = el => !['SELECT', 'INPUT', 'TEXTAREA', 'DETAILS'].includes(el.tagName);
  async function ask(el) {
    if (opening) return;
    opening = true;
    try {
      const result = await showConsentScreen(consentOptions(el) || {});
      if (!result?.consent || disposed) return;
      locked = false; apply();
      await onAllowed?.(el, result);
      if (disposed || !buttonLike(el) || el.isConnected === false) return;
      replayContext = { permissions: result.permissions === true };
      try { el.click(); } finally { replayContext = null; }
    } finally { opening = false; }
  }
  const intercept = event => {
    if (!locked || disposed) return;
    const el = target(event);
    if (!el) return;
    if (event.type === 'keydown' && !['Enter', ' ', 'Spacebar', 'ArrowDown', 'ArrowUp'].includes(event.key) && buttonLike(el)) return;
    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
    if (event.type === 'click' || event.type === 'submit' || (event.type === 'mousedown' && !buttonLike(el)) ||
        (event.type === 'keydown' && !buttonLike(el))) void ask(el);
  };
  const types = ['click', 'mousedown', 'keydown', 'submit'];
  for (const type of types) doc.addEventListener?.(type, intercept, true);
  let observer = null;
  if (typeof globalThis.MutationObserver === 'function') {
    observer = new MutationObserver(() => { if (locked) apply(); else for (const el of controls()) patch(el); });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
  }
  const refresh = async () => {
    const allowed = await refreshAccountGate({ read });
    locked = !allowed; apply();
    return locked;
  };
  const stop = onAccountGateChanged(detail => {
    if (detail?.reason === 'session') return;
    locked = detail?.consent !== true; apply();
  });
  apply();
  void refresh();
  return {
    refresh, locked: () => locked, apply,
    dispose() {
      stop(); observer?.disconnect();
      for (const type of types) doc.removeEventListener?.(type, intercept, true);
      locked = false; apply(); disposed = true;
    },
  };
}

// Every extension context that loads the gate follows consent changes, so a
// revocation aborts that context's account requests at once.
try { if (globalThis.chrome?.runtime?.id) watch(); } catch {}
