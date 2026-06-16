/**
 * Concurrency-limited task queue for outgoing jobs.
 *
 * Two limits interact:
 * - `userMaxConcurrency` — user's hard cap (0/invalid = safe default).
 * - `serverHintConcurrency` — temporary backpressure hint from the API.
 * - `softMaxConcurrency` — softer cap applied for AI jobs.
 */

import { DEFAULT_MAX_CONCURRENCY } from "../shared/constants.js";

const SOFT_MAX_DEFAULT = 15;
const SERVER_HINT_TTL_MS = 30000;

let userMaxConcurrency = DEFAULT_MAX_CONCURRENCY;
let serverHintConcurrency = DEFAULT_MAX_CONCURRENCY;
let serverHintUntil = 0;
let softMaxConcurrency = SOFT_MAX_DEFAULT;
let forceSoftMax = false;

let running = 0;
const queue = [];

function currentServerHint() {
  if (Date.now() > serverHintUntil) return DEFAULT_MAX_CONCURRENCY;
  return Math.max(1, Number(serverHintConcurrency) || DEFAULT_MAX_CONCURRENCY);
}

/** Effective concurrency limit given the current mode. */
function effectiveMax() {
  const hard = Math.max(1, Number(userMaxConcurrency) || DEFAULT_MAX_CONCURRENCY);
  const server = currentServerHint();
  let max = Math.min(hard, server);
  if (forceSoftMax) {
    const soft = Number(softMaxConcurrency) > 0 ? Number(softMaxConcurrency) : SOFT_MAX_DEFAULT;
    max = Math.min(max, soft);
  }
  return Math.max(1, max);
}

/** Pump the queue while worker slots are free. */
function pump() {
  while (queue.length && running < effectiveMax()) {
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

/** Set the user's hard concurrency cap (0/invalid = safe default). */
export function setMaxConcurrency(value) {
  userMaxConcurrency = Number(value) > 0 ? Number(value) : DEFAULT_MAX_CONCURRENCY;
  pump();
}

/** Temporary server-side backpressure hint; expires automatically. */
export function applyServerConcurrencyHint(value) {
  const hinted = Number(value);
  if (!Number.isFinite(hinted) || hinted <= 0) return;
  serverHintConcurrency = Math.max(1, hinted);
  serverHintUntil = Date.now() + SERVER_HINT_TTL_MS;
  pump();
}

/**
 * Configure the soft cap for the current batch.
 * @param {boolean} force - true for AI jobs
 * @param {number} [soft] - the soft cap value (defaults to {@link SOFT_MAX_DEFAULT})
 */
export function setSoftConcurrency(force, soft = SOFT_MAX_DEFAULT) {
  forceSoftMax = !!force;
  softMaxConcurrency = forceSoftMax ? soft : SOFT_MAX_DEFAULT;
  pump();
}

/** Soft cap to use for an AI key — HF keys are throttled harder. */
export function aiSoftMaxForKey(key) {
  return String(key || "").trim().startsWith("hf_") ? 2 : 4;
}

/** Snapshot of the current limits (for logging). */
export function describeLimits() {
  return {
    max: userMaxConcurrency,
    server: currentServerHint(),
    soft: softMaxConcurrency,
    forceSoft: forceSoftMax,
    effective: effectiveMax(),
    running,
    queued: queue.length,
  };
}
