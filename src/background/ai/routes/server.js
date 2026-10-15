// Complete runs:Extension Cloud-via-API route boundary.
// The server transport owns its request envelope, response normalization and
// usage capture; this file intentionally imports no Local AI implementation.
import { translateViaServer } from "../transports/server.js";
import { readLoginState } from "../../../shared/login-session.js";
import { RELAY_PROVIDERS, acquireBrowserRelay } from "../../login/endpoint/login_browser_relay.js";

/**
 * A Login provider that sends website requests from the customer's tab
 * (Claude) needs the relay pump running for the whole generation, on every
 * transport; without it the request fails with login_browser_relay_unavailable.
 */
async function holdLoginRelay(ai, base, read = readLoginState, acquire = acquireBrowserRelay) {
  if (ai?.provider !== "login") return () => {};
  try {
    const login = await read(["loginProvider", "paidSessionToken"]);
    if (RELAY_PROVIDERS[login?.loginProvider]) return acquire(base, login.paidSessionToken);
  } catch {}
  return () => {};
}

export async function translateServerRoute(units, options = {}) {
  const release = await holdLoginRelay(options.ai, options.base);
  try {
    return await translateViaServer(units, options);
  } finally {
    release();
  }
}
