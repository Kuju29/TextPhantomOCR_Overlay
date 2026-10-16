/**
 * Popup account lock (10495). While data use is not allowed every account
 * control ([data-account-control] in popup.html: Buy credits, Account details,
 * Refresh, Translation source/model, every Login control, Contact admin) is
 * greyed; a click opens the consent screen and, on Allow, runs again once the
 * account is re-read. "Sign out" is never locked. The locked banner of the
 * Paid area (#ai-paid-consent) is rendered by paid-service-controller.js.
 *
 * Also offers the consent once to an account that was signed in before
 * consent existed (10494); afterwards only the user's own actions ask.
 */
import { getStorage, setStorage } from "../../shared/storage.js";
import { DATA_CONSENT_OFFERED_KEY, COOKIE_LOGIN_PROVIDERS } from "../../shared/data-consent.js";
import { accountState, installAccountLock, showConsentScreen } from "../../shared/account-gate.js";

export function createAccountLockController({ doc = document, read = getStorage, write = setStorage,
  whenReady = async () => {}, loginProvider = () => "" } = {}) {
  let disposed = false;
  const lock = installAccountLock({ doc,
    // Login Gemini/DeepSeek: the same Allow click asks for the cookies permission.
    consentOptions: el => el?.id === "ai-login-connect" && COOKIE_LOGIN_PROVIDERS.includes(loginProvider()) ? { permissions: ["cookies"] } : {},
    // Replay only after the session was re-read through the gate.
    onAllowed: async () => { await whenReady(); } });

  async function initialize() {
    const state = await accountState({ read });
    if (disposed || state.consent || !state.signedIn) return;
    const saved = await read([DATA_CONSENT_OFFERED_KEY]);
    if (disposed || saved[DATA_CONSENT_OFFERED_KEY]) return;
    await write({ [DATA_CONSENT_OFFERED_KEY]: { at: Date.now() } });
    await showConsentScreen();
  }
  function dispose() { disposed = true; lock.dispose(); }
  return { initialize, dispose, lock };
}
