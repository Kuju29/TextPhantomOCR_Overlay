import { normalizeUrl } from "./url.js";

const REMOTE_DEFAULTS_URL ="https://raw.githubusercontent.com/Kuju29/TextPhantomOCR_Overlay/refs/heads/main/defaults_api.json";

const DEFAULT_API_URL_FALLBACK = "";
const RESET_API_URL_FALLBACK = "";

const FETCH_TIMEOUT_MS = 2000;
const TTL_MS = 12 * 60 * 60 * 1000;

function now() {
  return Date.now();
}

function coerceUrl(v) {
  return typeof v === "string" ? normalizeUrl(v) : "";
}

function parseMaybeJson(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    if (!(t.startsWith("{") && t.endsWith("}"))) return null;
    const q1 = t.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');
    const q2 = q1.includes("'") && !q1.includes('"') ? q1.replace(/'/g, '"') : q1;
    try {
      return JSON.parse(q2);
    } catch {
      return null;
    }
  }
}

async function fetchRemoteDefaults() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REMOTE_DEFAULTS_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const raw = await res.text();
    const data = parseMaybeJson(raw);
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
    return {
      defaultApiUrl: defaultApiUrl || "",
      resetApiUrl: resetApiUrl || "",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function ensureApiDefaults({ force = false } = {}) {
  const stored = await chrome.storage.local.get({
    apiUrlDefault: DEFAULT_API_URL_FALLBACK,
    apiUrlReset: RESET_API_URL_FALLBACK,
    apiDefaultsFetchedAt: 0,
  });

  const current = {
    defaultApiUrl: coerceUrl(stored.apiUrlDefault) || DEFAULT_API_URL_FALLBACK,
    resetApiUrl: coerceUrl(stored.apiUrlReset) || RESET_API_URL_FALLBACK,
    fetchedAt: Number(stored.apiDefaultsFetchedAt) || 0,
  };

  const fresh = current.fetchedAt && now() - current.fetchedAt <= TTL_MS;
  if (!force && fresh) return current;

  const remote = await fetchRemoteDefaults();
  if (!remote) return current;

  const next = {
    defaultApiUrl: remote.defaultApiUrl || current.defaultApiUrl,
    resetApiUrl: remote.resetApiUrl || current.resetApiUrl,
    fetchedAt: now(),
  };

  await chrome.storage.local.set({
    apiUrlDefault: next.defaultApiUrl,
    apiUrlReset: next.resetApiUrl,
    apiDefaultsFetchedAt: next.fetchedAt,
  });

  return next;
}

export const API_DEFAULTS = {
  REMOTE_DEFAULTS_URL,
  DEFAULT_API_URL_FALLBACK,
  RESET_API_URL_FALLBACK,
};
