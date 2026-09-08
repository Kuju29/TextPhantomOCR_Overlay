// Resolves the API base URL for the service worker and keeps its warmup and health state.

import { normalizeUrl } from "../shared/url.js";
import { API_PATHS } from "../shared/constants.js";
import { resolveApiBase } from "../shared/api-defaults.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("SW.api");

const WARMUP_TIMEOUT_MS = 15000;
const WARMUP_TTL_MS = 20 * 60 * 1000;

const warmupByBase = new Map();
const warmupInFlight = new Map();
const activeByBase = new Map();

// Last known `/health` result, read by the popup's GET_API_STATUS query.
export const healthCache = { ok: false, ts: 0, base: "" };

export function noteApiSuccess(base) {
  const b = normalizeUrl(base);
  if (!b) return;
  healthCache.ok = true;
  healthCache.ts = Date.now();
  healthCache.base = b;
}

export function noteApiActivity(base) {
  const b = normalizeUrl(base);
  if (b && healthCache.ok === true && healthCache.base === b)
    healthCache.ts = Date.now();
}

export function beginApiRequest(base) {
  const b = normalizeUrl(base);
  if (!b) return () => {};
  activeByBase.set(b, (activeByBase.get(b) || 0) + 1);
  noteApiActivity(b);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const next = Math.max(0, (activeByBase.get(b) || 1) - 1);
    if (next) activeByBase.set(b, next);
    else activeByBase.delete(b);
  };
}

export function apiHealthSnapshot(base, maxAgeMs = 60_000) {
  const b = normalizeUrl(base);
  const matches = Boolean(b && healthCache.base === b);
  const active = matches && (activeByBase.get(b) || 0) > 0;
  const fresh = active || Date.now() - Number(healthCache.ts || 0) < maxAgeMs;
  return {
    ok: healthCache.ok === true && fresh && matches,
    ts: healthCache.ts,
    base: healthCache.base,
    fresh,
    snapshot: true,
    active,
  };
}

// Pings `/warmup` for a base URL, throttled to once per WARMUP_TTL_MS.
export async function warmupApi(base) {
  const b = normalizeUrl(base);
  if (!b) return;
  if (healthCache.base !== b) {
    healthCache.ok = false;
    healthCache.ts = 0;
    healthCache.base = b;
  }
  const now = Date.now();
  if (now - (warmupByBase.get(b) || 0) < WARMUP_TTL_MS) return;
  const existing = warmupInFlight.get(b);
  if (existing) return existing;
  const request = runWarmup(b);
  warmupInFlight.set(b, request);
  try {
    return await request;
  } finally {
    if (warmupInFlight.get(b) === request) warmupInFlight.delete(b);
  }
}

async function runWarmup(b) {
  const healthTsAtStart = healthCache.ts;
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
    noteApiSuccess(b);
    return true;
  } catch (error) {
    // A slow warmup failure must not overwrite a newer successful Lens/AI
    // response from the same server.
    if (healthCache.base !== b || healthCache.ts === healthTsAtStart) {
      healthCache.ok = false;
      healthCache.ts = Date.now();
      healthCache.base = b;
    }
    log.warn("API warmup failed", error?.message || String(error));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Returns the active API base URL, custom URL winning over remote default, and kicks off a throttled warmup.
export async function getApiBase({ warm = true } = {}) {
  const base = normalizeUrl(await resolveApiBase()) || "";
  log.debug("getApiBase", base);
  if (warm) warmupApi(base);
  return base;
}
