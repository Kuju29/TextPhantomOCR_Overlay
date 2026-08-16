// Resolves the API base URL for the service worker and keeps its warmup and health state.

import { normalizeUrl } from "../shared/url.js";
import { API_PATHS } from "../shared/constants.js";
import { resolveApiBase } from "../shared/api-defaults.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("SW.api");

const WARMUP_TIMEOUT_MS = 15000;
const WARMUP_TTL_MS = 20 * 60 * 1000;

const warmupByBase = new Map();

// Last known `/health` result, read by the popup's GET_API_STATUS query.
export const healthCache = { ok: false, ts: 0 };

// Pings `/warmup` for a base URL, throttled to once per WARMUP_TTL_MS.
export async function warmupApi(base) {
  const b = normalizeUrl(base);
  if (!b) return;
  const now = Date.now();
  if (now - (warmupByBase.get(b) || 0) < WARMUP_TTL_MS) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WARMUP_TIMEOUT_MS);
  try {
    const response = await fetch(b.replace(/\/+$/, "") + API_PATHS.WARMUP, {
      method: "GET",
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!response.ok) throw new Error(`Warmup HTTP ${response.status}`);

    warmupByBase.set(b, Date.now());
    healthCache.ok = true;
    healthCache.ts = Date.now();
    return true;
  } catch (error) {
    healthCache.ok = false;
    healthCache.ts = Date.now();
    log.warn("API warmup failed", error?.message || String(error));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Returns the active API base URL, custom URL winning over remote default, and kicks off a throttled warmup.
export async function getApiBase() {
  const base = normalizeUrl(await resolveApiBase()) || "";
  log.debug("getApiBase", base);
  warmupApi(base);
  return base;
}
