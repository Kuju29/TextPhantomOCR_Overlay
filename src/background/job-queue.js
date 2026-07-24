/**
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
 * Outgoing job queue.
 *
 * v12 intentionally disables the old client-side processing cap. The extension
 * now submits all discovered images as quickly as the browser/network allows;
 * the backend split queues decide how many jobs actually run at once.
 *
 * A positive maxConcurrency value is kept only for future/manual debugging, but
 * the shipped default is 0 = unlimited. Server backpressure hints are ignored
 * in this build because SERVER_MAX_WORKERS/direct/AI lanes are authoritative.
 */

import { DEFAULT_MAX_CONCURRENCY } from "../shared/constants.js";

const SOFT_MAX_DEFAULT = 15;

let userMaxConcurrency = DEFAULT_MAX_CONCURRENCY; // 0 = unlimited
let softMaxConcurrency = SOFT_MAX_DEFAULT;
let forceSoftMax = false;

let running = 0;
const queue = [];

function unlimited() {
  return !Number.isFinite(Number(userMaxConcurrency)) || Number(userMaxConcurrency) <= 0;
}

/** Effective client-side submission/long-poll concurrency. */
function effectiveMax() {
  if (unlimited()) return Number.POSITIVE_INFINITY;
  let max = Math.max(1, Number(userMaxConcurrency));
  if (forceSoftMax) {
    const soft = Number(softMaxConcurrency) > 0 ? Number(softMaxConcurrency) : SOFT_MAX_DEFAULT;
    max = Math.min(max, soft);
  }
  return Math.max(1, max);
}

/** Pump the queue while slots are free. */
function pump() {
  const max = effectiveMax();
  while (queue.length && running < max) {
    running++;
    const task = queue.shift();
    Promise.resolve()
      .then(task)
      .catch((e) => console.error("[SW.queue] task error", e))
      .finally(() => {
        running--;
        pump();
      });
  }
}

/** Enqueue an async task. */
export function addTask(fn) {
  queue.push(fn);
  pump();
}

/** Set client cap. 0/invalid = unlimited. */
export function setMaxConcurrency(value) {
  const n = Number(value);
  userMaxConcurrency = Number.isFinite(n) && n > 0 ? n : 0;
  pump();
}

/** No-op in v12: server split queues own backpressure. */
export function applyServerConcurrencyHint(_value) {
  return;
}

/** Configure optional soft cap; ignored when maxConcurrency=0/unlimited. */
export function setSoftConcurrency(force, soft = SOFT_MAX_DEFAULT) {
  forceSoftMax = !!force;
  softMaxConcurrency = forceSoftMax ? soft : SOFT_MAX_DEFAULT;
  pump();
}

/** Soft cap to use for an AI key — retained for manual capped mode. */
export function aiSoftMaxForKey(key) {
  return String(key || "").trim().startsWith("hf_") ? 2 : 4;
}

/** Snapshot of current limits (for logging/UI). */
export function describeLimits() {
  return {
    max: userMaxConcurrency,
    server: 0,
    soft: softMaxConcurrency,
    forceSoft: forceSoftMax,
    effective: unlimited() ? "unlimited" : effectiveMax(),
    running,
    queued: queue.length,
  };
}
