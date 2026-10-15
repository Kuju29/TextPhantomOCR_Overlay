// A shared TextPhantom API rate-limits and caps queued jobs, AI
// conversations and repair runs per browser install (X-TP-Install, see
// src/paid/install-id.js). Every request that does work therefore carries the
// same install id the Paid/support calls already send. The id is read once per
// service-worker start and kept here; it is never logged or traced.
//
// An install-limited request (429 identity_rate_limited + Retry-After) did no
// work on the server, so callers may wait the given time and send it again —
// bounded per delay and in total, never a tight loop.
import { INSTALL_HEADER, installHeaders } from "../../paid/install-id.js";

const VALID = /^[a-f0-9]{32}$/;
let value = "";
let pending = null;

/** Resolve (once per service-worker start) the install id for request headers. */
export function installReady() {
  if (value) return Promise.resolve(value);
  if (!pending) {
    pending = installHeaders({ create: true }).then(
      (headers) => {
        const id = String(headers?.[INSTALL_HEADER] || "");
        if (VALID.test(id)) value = id;
        else pending = null; // storage unavailable now: try again on the next request
        return value;
      },
      () => {
        pending = null;
        return "";
      },
    );
  }
  return pending;
}

/** The cached header (empty until installReady() resolved with a valid id). */
export function installHeader() {
  return value ? { [INSTALL_HEADER]: value } : {};
}

/** installReady() + installHeader() for callers that build headers inline. */
export async function installRequestHeaders() {
  await installReady();
  return installHeader();
}

export const INSTALL_RATE_LIMITED = "identity_rate_limited";
// Retry-After is honoured up to this long per wait (the API sends whole seconds).
export const INSTALL_RETRY_MAX_MS = 60_000;
// Total time one piece of work may spend waiting on install limits before the
// error is shown to the user instead.
export const INSTALL_RETRY_BUDGET_MS = 5 * 60_000;

export function isInstallRateLimited(error) {
  const code = String(error?.code || error?.tpError?.code || "");
  return Number(error?.status ?? error?.httpStatus) === 429 && code === INSTALL_RATE_LIMITED;
}

/** Bounded wait for an install-limited request: Retry-After, 1 s .. 60 s. */
export function installRetryDelayMs(error) {
  const ms = Number(error?.retryAfterMs);
  return Math.min(INSTALL_RETRY_MAX_MS, Math.max(1000, Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : 1000));
}

// While work waits out an install limit, the in-page status says so with a
// countdown ("Server busy — waiting {seconds}s before continuing"). Each wait
// registers its end time here; it is cleared as soon as that work goes on.
const installWaits = new Map();
const installWaitListeners = new Set();
let installWaitSequence = 0;
function installWaitChanged() {
  for (const listener of installWaitListeners) {
    try { listener(); } catch { /* Status display never affects the work. */ }
  }
}

/** Register one install-limit wait of `ms`; call the returned function when the work resumes. */
export function beginInstallWait(ms, now = Date.now()) {
  const id = ++installWaitSequence;
  installWaits.set(id, now + Math.max(0, Number(ms) || 0));
  installWaitChanged();
  return () => {
    if (installWaits.delete(id)) installWaitChanged();
  };
}

/** Latest end time (ms epoch) of the install-limit waits still running, or 0. */
export function installWaitUntil(now = Date.now()) {
  let until = 0;
  for (const end of installWaits.values()) if (end > now && end > until) until = end;
  return until;
}

/** Notified when an install-limit wait starts or ends; returns an unsubscribe function. */
export function onInstallWaitChange(listener) {
  installWaitListeners.add(listener);
  return () => installWaitListeners.delete(listener);
}

/** Wait out an install limit (Retry-After) while the status shows the countdown. */
export async function waitInstallLimit(ms, waitFor) {
  const end = beginInstallWait(ms);
  try { return await waitFor(ms); }
  finally { end(); }
}

/** Test seam: forget the cached id (a new service-worker start). */
export function resetInstallHeaderForTest() {
  value = "";
  pending = null;
  installWaits.clear();
}
