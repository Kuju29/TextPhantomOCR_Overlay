/**
 * Concurrency-limited task queue for outgoing jobs.
 *
 * Two limits interact:
 * - `maxConcurrency` — the user's hard cap (0 = unlimited).
 * - `softMaxConcurrency` — a softer cap applied for AI jobs (HF keys get a
 *   lower value because the HF router is heavily rate-limited).
 *
 * The effective limit is the user cap, unless `forceSoftMax` is on (AI mode),
 * in which case the smaller of the two wins.
 */

const SOFT_MAX_DEFAULT = 15;

let maxConcurrency = 10;
let softMaxConcurrency = SOFT_MAX_DEFAULT;
let forceSoftMax = false;

let running = 0;
const queue = [];

/** Effective concurrency limit given the current mode. */
function effectiveMax() {
  const soft = Number(softMaxConcurrency) > 0 ? Number(softMaxConcurrency) : SOFT_MAX_DEFAULT;
  const hard = Number(maxConcurrency) || 0;
  if (forceSoftMax) return hard > 0 && hard < soft ? hard : soft;
  return hard;
}

/** Pump the queue while a worker slot is free. */
function pump() {
  if (!queue.length) return;
  const max = effectiveMax();
  if (max && running >= max) return;
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

/** Enqueue an async task. */
export function addTask(fn) {
  queue.push(fn);
  pump();
}

/** Set the user's hard concurrency cap (0 = unlimited). */
export function setMaxConcurrency(value) {
  maxConcurrency = Number(value) >= 0 ? Number(value) : 0;
}

/**
 * Configure the soft cap for the current batch.
 * @param {boolean} force - true for AI jobs
 * @param {number} [soft] - the soft cap value (defaults to {@link SOFT_MAX_DEFAULT})
 */
export function setSoftConcurrency(force, soft = SOFT_MAX_DEFAULT) {
  forceSoftMax = !!force;
  softMaxConcurrency = forceSoftMax ? soft : SOFT_MAX_DEFAULT;
}

/** Soft cap to use for an AI key — HF keys are throttled harder. */
export function aiSoftMaxForKey(key) {
  return String(key || "").trim().startsWith("hf_") ? 3 : 10;
}

/** Snapshot of the current limits (for logging). */
export function describeLimits() {
  return {
    max: maxConcurrency || "unlimited",
    soft: softMaxConcurrency,
    forceSoft: forceSoftMax,
    effective: effectiveMax() || "unlimited",
  };
}
