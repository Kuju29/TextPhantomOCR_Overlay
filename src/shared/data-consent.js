/**
 * Optional-data consent (10494). The single place that answers "may
 * TextPhantom send account data?" for every feature that needs it:
 *
 *  - Paid sign-in: the account email and credit purchase history
 *    (personallyIdentifyingInfo, financialAndPaymentInfo);
 *  - Login Gemini/DeepSeek: the website session cookie (authenticationInfo);
 *  - Contact admin: the messages and files the user sends (personalCommunications).
 *
 * One consent covers all three, asked once, only when the user first starts one
 * of them. Firefox/Thunderbird keep the answer in the browser's built-in data
 * collection permissions (one permissions.request for all four types);
 * other browsers keep it in chrome.storage.local with a version.
 *
 * Diagnostics (technicalAndInteraction) are separate and never prompted here:
 * see readDiagnosticsUpload() in settings.js.
 */
export const DATA_CONSENT_VERSION = 1;
export const DATA_CONSENT_KEY = 'tpDataConsentV1';
// Set once the popup has offered the consent to an already signed-in account.
export const DATA_CONSENT_OFFERED_KEY = 'tpDataConsentOfferedV1';
export const DATA_CONSENT_TYPES = Object.freeze([
  'personallyIdentifyingInfo',
  'financialAndPaymentInfo',
  'authenticationInfo',
  'personalCommunications',
]);
export const DIAGNOSTICS_DATA_TYPE = 'technicalAndInteraction';
export const DATA_CONSENT_REQUIRED = 'DATA_CONSENT_REQUIRED';
// 10495: the page message (English source; the Thai is in error-contract.js
// and page-ui-text.js). The background opens the consent tab before saying so.
export const DATA_CONSENT_MESSAGE = 'Allow data use first. A permission tab is open. Nothing was sent and no credits were used.';
// Thunderbird (and any Gecko build whose permissions API rejects
// `data_collection`) keeps the answer in storage instead; remembered here.
export const DATA_CONSENT_MODE_KEY = 'tpDataConsentModeV1';
// Login providers whose connection reads a website cookie. Claude and ChatGPT
// requests leave from this browser and read no cookie.
export const COOKIE_LOGIN_PROVIDERS = Object.freeze(['login_gemini', 'login_deepseek']);

function lastError() {
  try { return globalThis.chrome?.runtime?.lastError || null; } catch { return null; }
}

// Gecko's `browser.*` is promise-only (an extra callback argument is a schema
// error); `chrome.*` is callback-first in Gecko and either in Chromium.
const promiseNamespace = () => Boolean(globalThis.browser?.permissions);
function permissionsApi() {
  return promiseNamespace() ? globalThis.browser.permissions : globalThis.chrome?.permissions || null;
}
function storageArea() {
  return promiseNamespace() ? globalThis.browser.storage?.local || null : globalThis.chrome?.storage?.local || null;
}

/** Call an extension method of the namespace chosen above. */
function call(object, method, args) {
  if (promiseNamespace()) {
    try { return Promise.resolve(object[method](...args)); } catch (error) { return Promise.reject(error); }
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => { if (!settled) { settled = true; error ? reject(error) : resolve(value); } };
    let returned;
    try {
      returned = object[method](...args, value => {
        const error = lastError();
        done(error ? new Error(error.message || String(error)) : null, value);
      });
    } catch (error) { done(error); return; }
    if (returned && typeof returned.then === 'function') returned.then(value => done(null, value), done);
  });
}

// Set once the browser refused the `data_collection` key (schema error), e.g.
// Thunderbird builds without built-in data consent. Feature detection, no UA.
let builtinUnsupported = false;
let modeRead = null;
export const markBuiltinConsentUnsupported = () => schemaRefusal();
const schemaRefusal = () => { builtinUnsupported = true; try { void storageArea()?.set?.({ [DATA_CONSENT_MODE_KEY]: 'storage' }); } catch {} };
function readMode() {
  return modeRead ||= (async () => {
    try {
      const area = storageArea();
      if (!area?.get) return;
      const saved = (await call(area, 'get', [[DATA_CONSENT_MODE_KEY]]))?.[DATA_CONSENT_MODE_KEY];
      if (saved === 'storage') builtinUnsupported = true;
    } catch {}
  })();
}

/** Like call(), but a synchronous throw (schema error) escapes to the caller,
 * so the caller can still act inside the same user click. */
export function invokeNow(object, method, args) {
  if (promiseNamespace()) return Promise.resolve(object[method](...args));
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  const returned = object[method](...args, value => {
    const error = lastError();
    if (error) reject(new Error(error.message || String(error))); else resolve(value);
  });
  if (returned && typeof returned.then === 'function') returned.then(resolve, reject);
  return promise;
}

/** True where the browser itself records data-collection consent (Gecko 140+). */
export function usesBuiltinDataConsent() {
  if (builtinUnsupported) return false;
  try {
    const declared = globalThis.chrome?.runtime?.getManifest?.()?.browser_specific_settings?.gecko?.data_collection_permissions;
    return Boolean(declared && typeof permissionsApi()?.request === 'function');
  } catch { return false; }
}

/** Does the browser hold these optional data-collection permissions?
 * A schema refusal switches this profile to the storage record (Thunderbird). */
export async function hasDataCollection(types) {
  const api = permissionsApi();
  if (!api?.contains) return false;
  try { return (await call(api, 'contains', [{ data_collection: [...types] }])) === true; }
  catch { schemaRefusal(); return false; }
}

// The record lives in extension storage (where the consent screen writes it);
// an injected reader is used only where there is no extension storage.
async function storedConsent(read) {
  const area = storageArea();
  const saved = area?.get ? (await call(area, 'get', [[DATA_CONSENT_KEY]]))?.[DATA_CONSENT_KEY]
    : typeof read === 'function' ? (await read([DATA_CONSENT_KEY]))?.[DATA_CONSENT_KEY] : null;
  return saved?.version === DATA_CONSENT_VERSION && saved?.granted === true;
}

/** Consent for account data, Login cookie and support messages.
 * `read` (optional) reads the storage record with an injected storage. */
export async function hasDataConsent({ read = null } = {}) {
  await readMode();
  if (usesBuiltinDataConsent()) {
    const granted = await hasDataCollection(DATA_CONSENT_TYPES);
    if (usesBuiltinDataConsent()) return granted;
  }
  return storedConsent(read);
}

function saveStoredConsent() {
  const area = storageArea();
  if (!area?.set) return Promise.resolve(false);
  return call(area, 'set', [{ [DATA_CONSENT_KEY]: { version: DATA_CONSENT_VERSION, granted: true, at: Date.now() } }]).then(() => true);
}

/**
 * Record the user's Allow. MUST be called synchronously inside the click handler
 * of the consent screen's Allow button: Firefox only shows its prompt for a user
 * action, and Chrome asks for `permissions` (e.g. cookies for Login) the same way.
 * Firefox asks for all four data types and `permissions` in ONE prompt.
 * Where the browser refuses the `data_collection` key (Thunderbird), the answer
 * is kept in storage and `permissions` are asked in the same click.
 * @param {{permissions?: string[]}} [options]
 * @returns {Promise<{consent: boolean, permissions: boolean}>}
 */
export function requestDataConsent({ permissions = [] } = {}) {
  const extra = permissions.length ? { permissions: [...permissions] } : {};
  const api = permissionsApi();
  const storageAnswer = asked => {
    const saved = saveStoredConsent();
    return Promise.all([saved, asked]).then(([consent, granted]) => ({ consent: consent === true, permissions: consent === true && granted }));
  };
  const askPermissions = () => permissions.length && api?.request
    ? call(api, 'request', [extra]).then(value => value === true, () => false)
    : Promise.resolve(!permissions.length);
  if (usesBuiltinDataConsent()) {
    // No await before this call: it must stay inside the user's click.
    let asked;
    try { asked = invokeNow(api, 'request', [{ data_collection: [...DATA_CONSENT_TYPES], ...extra }]); }
    catch { schemaRefusal(); return storageAnswer(askPermissions()); }
    return asked.then(async granted => {
      const consent = granted === true && await hasDataConsent();
      return { consent, permissions: consent && (!permissions.length || await call(api, 'contains', [extra]) === true) };
    }, () => {
      // Rejected (unknown `data_collection`): storage record. The browser
      // prompt for `permissions` may need a new click; report what is held.
      schemaRefusal();
      const held = permissions.length && api?.contains ? call(api, 'contains', [extra]).then(v => v === true, () => false) : Promise.resolve(!permissions.length);
      return storageAnswer(held.then(ok => ok || askPermissions()));
    });
  }
  return storageAnswer(askPermissions());
}

/** Withdraw consent. The features ask again the next time they are used. */
export async function revokeDataConsent() {
  if (usesBuiltinDataConsent()) {
    try { await call(permissionsApi(), 'remove', [{ data_collection: [...DATA_CONSENT_TYPES] }]); }
    catch { schemaRefusal(); }
  }
  const area = storageArea();
  if (area?.remove) await call(area, 'remove', [[DATA_CONSENT_KEY]]);
  // The user decided: no one-time offer pops up on the next popup open (10495).
  if (area?.set) { try { await call(area, 'set', [{ [DATA_CONSENT_OFFERED_KEY]: { at: Date.now(), revoked: true } }]); } catch {} }
  return !(await hasDataConsent());
}

/** Run `listener` when the consent may have changed (any context). */
export function onDataConsentChanged(listener) {
  const storage = globalThis.chrome?.storage?.onChanged || globalThis.browser?.storage?.onChanged;
  const api = permissionsApi();
  const onStorage = (changes, area) => { if (area === 'local' && changes?.[DATA_CONSENT_KEY]) listener(); };
  const onPermission = () => listener();
  try { storage?.addListener?.(onStorage); } catch {}
  try { api?.onAdded?.addListener?.(onPermission); api?.onRemoved?.addListener?.(onPermission); } catch {}
  return () => {
    try { storage?.removeListener?.(onStorage); } catch {}
    try { api?.onAdded?.removeListener?.(onPermission); api?.onRemoved?.removeListener?.(onPermission); } catch {}
  };
}

/** The refusal every gated request uses. Nothing was sent; no credit was used.
 * `revoked`: a running Paid/Login job stopped because consent was withdrawn. */
export const DATA_CONSENT_REVOKED = 'DATA_CONSENT_REVOKED';
export const DATA_CONSENT_REVOKED_MESSAGE = 'Data use was turned off. Account work stopped; finished translations stay.';
export function dataConsentError({ revoked = false } = {}) {
  if (revoked) return Object.assign(new Error(DATA_CONSENT_REVOKED_MESSAGE), {
    code: DATA_CONSENT_REVOKED, revoked: true, retryable: false,
  });
  return Object.assign(new Error(DATA_CONSENT_MESSAGE), {
    code: DATA_CONSENT_REQUIRED, requestDispatched: false, retryable: false,
  });
}

export async function assertDataConsent() {
  if (!(await hasDataConsent())) throw dataConsentError();
}
