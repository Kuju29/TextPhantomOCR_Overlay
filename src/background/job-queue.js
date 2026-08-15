// Bounds top-level jobs before they allocate image/request resources.
// A user value of 0 means automatic admission, not infinite parallelism.

import { DEFAULT_MAX_CONCURRENCY } from "../shared/constants.js";

const AUTO_FALLBACK = 8;
const AUTO_MIN = 2;
const AUTO_MAX = 24;
const EXPLICIT_MAX = 64;
const SERVER_GROW_CONFIRMATIONS = 3;

let userMaxConcurrency = DEFAULT_MAX_CONCURRENCY;
let serverMaxConcurrency = 0;
let pendingServerIncrease = 0;
let pendingServerConfirmations = 0;

let running = 0;
const queue = [];

function clampInteger(value, low, high) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(high, Math.max(low, n)) : 0;
}

// Hardware concurrency is only a signal: jobs include network waits but also
// hold decoded page images, so cap high-core machines to bounded retention.
function automaticMax() {
  const cores = clampInteger(globalThis.navigator?.hardwareConcurrency, 1, 128);
  if (!cores) return AUTO_FALLBACK;
  return clampInteger(Math.ceil(cores * 1.5), AUTO_MIN, AUTO_MAX);
}

function effectiveMax() {
  const clientMax = userMaxConcurrency > 0 ? userMaxConcurrency : automaticMax();
  return serverMaxConcurrency > 0 ? Math.min(clientMax, serverMaxConcurrency) : clientMax;
}

function skipTask(task) {
  if (task.signal?.aborted) return true;
  if (typeof task.shouldStart !== "function") return false;
  try {
    return task.shouldStart() === false;
  } catch (error) {
    console.error("[SW.queue] admission check error", error);
    return true;
  }
}

// Cancelled/stale entries are discarded without consuming a running slot.
function pump() {
  const max = effectiveMax();
  while (queue.length && running < max) {
    const task = queue.shift();
    if (skipTask(task)) continue;
    running++;
    Promise.resolve()
      .then(task.fn)
      .catch((e) => console.error("[SW.queue] task error", e))
      .finally(() => {
        running--;
        pump();
      });
  }
}

// Optional admission guards preserve addTask(fn) compatibility while allowing
// callers to cancel or reject stale work before it starts.
export function addTask(fn, { signal = null, shouldStart = null } = {}) {
  if (typeof fn !== "function") throw new TypeError("addTask requires a function");
  queue.push({ fn, signal, shouldStart });
  pump();
}

// 0/invalid restores hardware-aware automatic admission.
export function setMaxConcurrency(value) {
  const n = Number(value);
  userMaxConcurrency = Number.isFinite(n) && n > 0
    ? clampInteger(n, 1, EXPLICIT_MAX)
    : 0;
  pump();
}

// Reductions take effect immediately. Increases need repeated evidence so one
// optimistic response cannot suddenly release a large queued batch.
export function applyServerConcurrencyHint(value) {
  // Missing fields are common on older status messages and are not evidence
  // that a previously learned server ceiling should be removed.
  if (value == null || String(value).trim() === "") return;
  const next = clampInteger(value, 1, EXPLICIT_MAX);
  if (!next) {
    serverMaxConcurrency = 0;
    pendingServerIncrease = 0;
    pendingServerConfirmations = 0;
    pump();
    return;
  }
  if (!serverMaxConcurrency || next <= serverMaxConcurrency) {
    serverMaxConcurrency = next;
    pendingServerIncrease = 0;
    pendingServerConfirmations = 0;
  } else {
    if (pendingServerIncrease !== next) {
      pendingServerIncrease = next;
      pendingServerConfirmations = 1;
    } else {
      pendingServerConfirmations++;
    }
    if (pendingServerConfirmations >= SERVER_GROW_CONFIRMATIONS) {
      serverMaxConcurrency = next;
      pendingServerIncrease = 0;
      pendingServerConfirmations = 0;
    }
  }
  pump();
}

// Returns a snapshot of the current limits and queue depth.
export function describeLimits() {
  return {
    max: userMaxConcurrency,
    auto: automaticMax(),
    server: serverMaxConcurrency,
    effective: effectiveMax(),
    running,
    queued: queue.length,
  };
}
