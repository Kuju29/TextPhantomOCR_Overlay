/**
 * 10495: what a Paid/Login request needs from the account gate, in one call.
 * `gate` is the revocation signal (null for other providers); a withdrawn
 * consent throws DATA_CONSENT_REVOKED before anything is sent. A Claude/ChatGPT
 * Login turn is sent by the API through this browser's own website tab, so the
 * relay pump runs for the request (its token also comes from the gate).
 */
import { readLoginState } from "../../shared/login-session.js";
import { readAccountSession, accountRequestGate } from "../../shared/account-gate.js";
import { RELAY_PROVIDERS, acquireBrowserRelay } from "../login/endpoint/login_browser_relay.js";

export async function holdLoginRelay(provider, base, { read = readLoginState, acquire = acquireBrowserRelay } = {}) {
  if (provider !== "login") return () => {};
  try {
    const session = await readAccountSession({ read, keys: ["loginProvider"] });
    if (session.ok && RELAY_PROVIDERS[session.values.loginProvider]) return acquire(base, session.token, {gate: session.signal});
  } catch {}
  return () => {};
}

export async function accountRequest(payload, base, { relay = false } = {}) {
  const gate = await accountRequestGate(payload?.ai?.provider, { read: readLoginState });
  return { gate, releaseRelay: relay ? await holdLoginRelay(payload?.ai?.provider, base) : () => {} };
}
