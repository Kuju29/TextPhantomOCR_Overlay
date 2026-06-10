/**
 * Remote-configured default API URLs.
 *
 * The extension ships with no hard-coded API endpoint. Instead it fetches a
 * tiny JSON file from GitHub that supplies the `defaultApiUrl` (used when the
 * user has not set a custom one) and `resetApiUrl` (used by the popup's reset
 * button). The result is cached in `chrome.storage.local` for 12 hours.
 */

import { normalizeUrl } from "./url.js";
import { getStorage, setStorage } from "./storage.js";

const REMOTE_DEFAULTS_URL =
  "https://raw.githubusercontent.com/Kuju29/TextPhantomOCR_Overlay/refs/heads/main/defaults_api.json";

const FETCH_TIMEOUT_MS = 8000;
const TTL_MS = 12 * 60 * 60 * 1000;

const coerceUrl = (v) => (typeof v === "string" ? normalizeUrl(v) : "");

/**
 * Parse JSON that may be slightly malformed (unquoted keys / single quotes).
 * @param {string} raw
 * @returns {object|null}
 */
function parseLooseJson(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    if (!(text.startsWith("{") && text.endsWith("}"))) return null;
    // Quote bare keys, then swap single quotes for double quotes.
    let fixed = text.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');
    if (fixed.includes("'") && !fixed.includes('"')) fixed = fixed.replace(/'/g, '"');
    try {
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}

/** Fetch + parse the remote defaults file, or null on any failure. */
async function fetchRemoteDefaults() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REMOTE_DEFAULTS_URL, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = parseLooseJson(await res.text());
    if (!data || typeof data !== "object") return null;

    const defaultApiUrl =
      coerceUrl(data.defaultApiUrl) ||
      coerceUrl(data.DEFAULTS_API) ||
      coerceUrl(data.apiUrlDefault) ||
      coerceUrl(data.default_api_url);
    const resetApiUrl =
      coerceUrl(data.resetApiUrl) ||
      coerceUrl(data.apiUrlReset) ||
      coerceUrl(data.reset_api_url);

    if (!defaultApiUrl && !resetApiUrl) return null;
    return { defaultApiUrl: defaultApiUrl || "", resetApiUrl: resetApiUrl || "" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return the cached/fresh API defaults, refreshing from the network when the
 * cache is stale (or `force` is set).
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{defaultApiUrl:string, resetApiUrl:string, fetchedAt:number}>}
 */
export async function ensureApiDefaults({ force = false } = {}) {
  const stored = await getStorage({
    apiUrlDefault: "",
    apiUrlReset: "",
    apiDefaultsFetchedAt: 0,
  });

  const current = {
    defaultApiUrl: coerceUrl(stored.apiUrlDefault),
    resetApiUrl: coerceUrl(stored.apiUrlReset),
    fetchedAt: Number(stored.apiDefaultsFetchedAt) || 0,
  };

  const fresh = current.fetchedAt && Date.now() - current.fetchedAt <= TTL_MS;
  if (!force && fresh) return current;

  const remote = await fetchRemoteDefaults();
  if (!remote) return current;

  const next = {
    defaultApiUrl: remote.defaultApiUrl || current.defaultApiUrl,
    resetApiUrl: remote.resetApiUrl || current.resetApiUrl,
    fetchedAt: Date.now(),
  };
  await setStorage({
    apiUrlDefault: next.defaultApiUrl,
    apiUrlReset: next.resetApiUrl,
    apiDefaultsFetchedAt: next.fetchedAt,
  });
  return next;
}

/**
 * Resolve the effective API base from storage + remote defaults.
 *
 * By default, a user-entered custom URL is treated as an explicit override,
 * while the remote default is the primary source for users who have not set
 * one. Set `preferRemote` to true only if the remote default must override
 * even an existing custom URL.
 * @param {{force?: boolean, preferRemote?: boolean}} [opts]
 * @returns {Promise<string>}
 */
export async function resolveApiBase({ force = false, preferRemote = false } = {}) {
  const stored = await getStorage({ customApiUrl: "" });
  const custom = coerceUrl(stored.customApiUrl);
  const defaults = await ensureApiDefaults({ force });
  const remote = coerceUrl(defaults.defaultApiUrl);
  return preferRemote ? remote || custom || "" : custom || remote || "";
}
