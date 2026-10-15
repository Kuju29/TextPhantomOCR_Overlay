/** OAuth flows and safe outcomes live in browser session memory, never local. */
import { getStorage, setStorage } from './storage.js';
import { LOGIN_PENDING_AUTH, LOGIN_OUTCOME } from './login-auth.js';
const privateKeys = new Set([LOGIN_PENDING_AUTH, LOGIN_OUTCOME, 'loginSessionId', 'loginAccountId', 'loginWebchatConnectionsV1', 'loginWebchatTurnsV1', 'loginProviderViewCacheV1', 'manualProviderViewCacheV1', 'loginConnectionsV2']);
const memoryError = () => Object.assign(new Error('In-memory Login storage is unavailable on this browser.'),{code:'login_memory_storage_unavailable',stage:'browser_session_storage'});
let retired;
function retireLegacyLocalAuth() {
  return retired ||= new Promise((resolve, reject) => {
    const local = globalThis.chrome?.storage?.local;
    if (!local?.remove) return resolve();
    local.remove([...privateKeys], () => globalThis.chrome?.runtime?.lastError ? reject(new Error('Could not retire the previous Login flow.')) : resolve());
  });
}
function sessionCall(method, value) {
  return new Promise((resolve, reject) => {
    const session = globalThis.chrome?.storage?.session;
    if (!session) return reject(memoryError());
    try {
      session[method](value, result => {
        const error = globalThis.chrome?.runtime?.lastError;
        if (error) reject(memoryError());
        else resolve(result || {});
      });
    } catch { reject(memoryError()); }
  });
}
export const getLoginSession = async keys => { await retireLegacyLocalAuth(); return sessionCall('get', keys); };
export const setLoginSession = patch => sessionCall('set', patch);
export async function readLoginState(keys) {
  const ordinary = keys.filter(key => !privateKeys.has(key));
  const temporary = keys.filter(key => privateKeys.has(key));
  // Missing RAM storage disables Login identifiers, while ordinary modes can
  // still load their settings. Never read a private value from local storage.
  const stored = ordinary.length ? await getStorage(ordinary) : {};
  if (!temporary.length) return stored;
  try { return {...stored, ...await getLoginSession(temporary)}; }
  catch { return {...stored, loginMemoryStorageError: 'login_memory_storage_unavailable'}; }
}
export async function writeLoginState(patch) {
  const ordinary = Object.fromEntries(Object.entries(patch).filter(([key]) => !privateKeys.has(key)));
  const temporary = Object.fromEntries(Object.entries(patch).filter(([key]) => privateKeys.has(key)));
  if (Object.keys(temporary).length) await setLoginSession(temporary);
  if (Object.keys(ordinary).length) await setStorage(ordinary);
}
