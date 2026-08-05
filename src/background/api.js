/**
 *
 * STATUS: ACTIVE — in use in the current flow.
 * API base resolution, warmup and health cache for the service worker.
 *
 * The base URL is the user's custom URL if set, otherwise the remote-default
 * URL. `/warmup` is pinged (throttled) whenever the base is read so the first
 * real job is fast.
 */

import { normalizeUrl } from "../shared/url.js";
import { API_PATHS } from "../shared/constants.js";
import { resolveApiBase } from "../shared/api-defaults.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("SW.api");

// A sleeping Hugging Face Space commonly needs more than 2.5 seconds to wake.
const WARMUP_TIMEOUT_MS = 15000;
const WARMUP_TTL_MS = 20 * 60 * 1000;

/** base URL -> last warmup timestamp */
const warmupByBase = new Map();

/** Cached `/health` result (kept for the popup's GET_API_STATUS query). */
export const healthCache = { ok: false, ts: 0, build: "" };

/**
 * Ping `/warmup` for `base`, throttled to once per `WARMUP_TTL_MS`.
 * @param {string} base
 */
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

    // Throttle only after a successful response. A failed cold start must be
    // allowed to retry instead of being suppressed for 20 minutes.
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

/**
 * Resolve the active API base URL (custom URL wins over remote default).
 * Also kicks off a throttled warmup.
 * @returns {Promise<string>}
 */
export async function getApiBase() {
  // Resolve defaults on the real request path. A Manifest V3 service worker may
  // be started by a request before the startup prefetch in index.js completes.
  const base = normalizeUrl(await resolveApiBase()) || "";
  log.debug("getApiBase", base);
  warmupApi(base);
  return base;
}
