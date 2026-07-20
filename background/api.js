/**
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
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

const WARMUP_TIMEOUT_MS = 2500;
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
  warmupByBase.set(b, now);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WARMUP_TIMEOUT_MS);
  try {
    await fetch(b.replace(/\/+$/, "") + API_PATHS.WARMUP, {
      method: "GET",
      cache: "force-cache",
      signal: ctrl.signal,
    });
  } catch {
    /* warmup is best-effort */
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
