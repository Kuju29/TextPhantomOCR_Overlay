// Paces outgoing work per resource lane with an AIMD window that widens on success and halves on backpressure.

const MIN_WINDOW = 1;
const DEFAULT_MAX_WINDOW = 32;
// AI lanes start conservative and grow on clean round trips, so a paid key is not
// held at a free key's pace. Hugging Face keeps its own server-side throttle.
const AI_START_WINDOW = 4;
const AI_MAX_WINDOW = 24;
const HF_START_WINDOW = 2;
const HF_MAX_WINDOW = 4;
const BACKOFF_FACTOR = 0.5;

const lanes = new Map();

// Returns the initial and maximum window for a lane key.
function lanePolicy(key) {
  const id = String(key || "default").toLowerCase();
  if (!id.startsWith("ai:")) {
    return { initialWindow: 2, maxWindow: DEFAULT_MAX_WINDOW };
  }
  const hf = id.startsWith("ai:hf:") || id.startsWith("ai:huggingface:");
  return hf
    ? { initialWindow: HF_START_WINDOW, maxWindow: HF_MAX_WINDOW }
    : { initialWindow: AI_START_WINDOW, maxWindow: AI_MAX_WINDOW };
}

// Builds a fresh lane record for a key.
function makeLane(key) {
  const policy = lanePolicy(key);
  return {
    key,
    window: policy.initialWindow,
    maxWindow: policy.maxWindow,
    running: 0,
    waiters: [],
    avgMs: 0,
    samples: 0,
    pausedUntil: 0,
    ceiling: 0,
    capacityHint: 0,
    capacityTarget: 0,
    backpressured: false,
    recoverySuccesses: 0,
    unlimited: false,
    stats: { ok: 0, rejected: 0, failed: 0, backoffs: 0, ceilingHits: 0, gated: 0 },
  };
}

// The largest window worth holding open, given what the lane may actually spend.
function effectiveMax(l) {
  return l.ceiling > 0 ? Math.min(l.maxWindow, l.ceiling) : l.maxWindow;
}

// Returns the lane for a key, creating it when absent.
function lane(key) {
  const id = String(key || "default");
  let found = lanes.get(id);
  if (!found) {
    found = makeLane(id);
    lanes.set(id, found);
  }
  return found;
}

// Admits waiters while the lane has room and is not paused.
function pump(l) {
  if (l.unlimited) {
    while (l.waiters.length) {
      l.running++;
      const next = l.waiters.shift();
      next.cleanup?.();
      next.resolve();
    }
    return;
  }
  while (
    l.waiters.length &&
    l.running < Math.floor(Math.min(l.window, effectiveMax(l))) &&
    Date.now() >= l.pausedUntil
  ) {
    l.running++;
    const next = l.waiters.shift();
    next.cleanup?.();
    next.resolve();
  }
  if (l.waiters.length && l.running === 0 && Date.now() < l.pausedUntil) {
    setTimeout(() => pump(l), Math.max(1, l.pausedUntil - Date.now()));
  }
}

// Marks a lane as running against the user's own machine, where nothing is metered.
// An unlimited lane admits every caller at once and never widens or narrows.
export function setLaneUnlimited(key, on) {
  const l = lane(key);
  l.unlimited = Boolean(on);
  if (l.unlimited) pump(l);
  return l.unlimited;
}

// Waits for a slot in a lane and resolves when the caller may proceed.
export function acquire(key, signal = null) {
  const l = lane(key);
  if (l.unlimited) {
    if (signal?.aborted) {
      return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
    }
    l.running++;
    return Promise.resolve({ waitMs: 0, maxWindow: 0, window: 0, running: l.running, unlimited: true });
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const queuedAt = Date.now();
    const waiter = {
      resolve: () => resolve({
        waitMs: Math.max(0, Date.now() - queuedAt),
        maxWindow: effectiveMax(l),
        window: Math.floor(l.window),
        running: l.running,
      }),
      reject,
      cleanup: null,
    };
    if (signal) {
      const onAbort = () => {
        const index = l.waiters.indexOf(waiter);
        if (index >= 0) l.waiters.splice(index, 1);
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
    }
    l.waiters.push(waiter);
    pump(l);
  });
}

// Returns a slot after a successful round trip and widens the window. Provider
// latency is not backpressure: the API already meters this key.
export function releaseSuccess(key, ms = 0) {
  const l = lane(key);
  l.running = Math.max(0, l.running - 1);
  l.stats.ok++;
  if (l.unlimited) return;

  const latency = Number(ms) || 0;
  if (latency > 0) {
    l.avgMs = l.avgMs > 0 ? l.avgMs * 0.8 + latency * 0.2 : latency;
    l.samples++;
  }

  const cap = effectiveMax(l);
  if (l.backpressured) {
    l.recoverySuccesses++;
    if (l.recoverySuccesses >= 4) {
      l.backpressured = false;
      l.recoverySuccesses = 0;
    }
  }
  if (l.window >= cap) l.stats.ceilingHits++;
  l.window = Math.min(cap, l.window + 1 / l.window);
  pump(l);
}

// Returns a slot after server backpressure, halving the window and pausing the whole lane for `retryAfterMs`.
export function releaseRejected(key, retryAfterMs = 0) {
  const l = lane(key);
  l.running = Math.max(0, l.running - 1);
  l.stats.rejected++;
  if (l.unlimited) return;
  l.window = Math.max(MIN_WINDOW, l.window * BACKOFF_FACTOR);
  l.backpressured = true;
  l.recoverySuccesses = 0;
  l.stats.backoffs++;
  const pause = Number(retryAfterMs) || 0;
  if (pause > 0) l.pausedUntil = Math.max(l.pausedUntil, Date.now() + pause);
  pump(l);
}

// Returns a slot after the API's own rate gate refused a token: waits out the
// gate's advertised delay WITHOUT narrowing the window.
//
// A provider 429 and a rate-gate 429 arrive as the same status code and mean
// opposite things. The provider is complaining about CONCURRENCY, and halving
// the window is the right answer. The gate is reporting that this API key's
// token bucket is empty, which is a RATE, and no window is narrow enough to
// make a bucket refill faster — the delay it hands back already is the answer.
//
// Treating them alike cost more than the extra latency. `releaseRejected` also
// sets `backpressured`, which then needs four clean round trips to clear, so a
// batch big enough to saturate the gate drove its own window down to 1 and
// stayed there; the server-side gate then saw too little clean traffic to earn
// a rate increase, and both sides settled at the slowest rate either could
// justify. Measured on trace-20260819-191505: 330 s of 478 s of AI time spent
// waiting for tokens, with the server otherwise idle 88% of the session.
export function releaseGated(key, retryAfterMs = 0) {
  const l = lane(key);
  l.running = Math.max(0, l.running - 1);
  l.stats.gated++;
  if (l.unlimited) return;
  // The lane pause IS the throttle, and it is lane-wide on purpose: the bucket
  // belongs to the API key, so every request on this lane faces the same empty
  // bucket. Nothing else changes — not the window, not the backpressure flag.
  const pause = Number(retryAfterMs) || 0;
  if (pause > 0) l.pausedUntil = Math.max(l.pausedUntil, Date.now() + pause);
  pump(l);
}

// Returns a slot after a failure that is not backpressure, leaving the window unchanged.
export function releaseFailed(key) {
  const l = lane(key);
  l.running = Math.max(0, l.running - 1);
  l.stats.failed++;
  pump(l);
}

// Backward-compatible observer for older call sites. Server RPM is already
// enforced by the API rate gate and must not become a second client throttle.
// Direct capacity hints use setLaneSlotCeiling instead.
export function setLaneCeiling(key, rpm, providerMs) {
  const l = lane(key);
  void rpm;
  void providerMs;
  return l.unlimited ? 0 : effectiveMax(l);
}

// Caps a lane at a concurrency the server reported directly, for lanes the API
// bounds by slots rather than by a rate.
export function setLaneSlotCeiling(key, slots) {
  const l = lane(key);
  if (l.unlimited) return 0;
  const n = Number(slots) || 0;
  l.ceiling = n > 0 ? Math.max(MIN_WINDOW, Math.floor(n)) : 0;
  if (l.window > effectiveMax(l)) l.window = effectiveMax(l);
  return l.ceiling;
}

// Seeds a server-metered AI lane from advertised processing capacity. With no
// explicit provider burst, the server's admission limit is the bounded backlog
// contract and may be used fully. A pinned burst keeps startup to at most two
// bursts; later clean completions grow normally. Repeated hints never erase an
// explicit 429/503 backoff.
export function setLaneCapacityHint(key, slots, burst = 0) {
  const l = lane(key);
  if (l.unlimited) return 0;
  const n = Number(slots) || 0;
  const previous = l.capacityHint;
  l.capacityHint = n > 0 ? Math.max(MIN_WINDOW, Math.floor(n)) : 0;
  l.ceiling = l.capacityHint;
  const hard = effectiveMax(l);
  const b = Math.max(0, Math.floor(Number(burst) || 0));
  l.capacityTarget = b > 0 ? Math.min(hard, Math.max(AI_START_WINDOW, b * 2)) : hard;
  if (l.window > hard) l.window = hard;
  if (!l.backpressured && l.capacityHint > previous) {
    l.window = Math.max(l.window, l.capacityTarget);
    pump(l);
  }
  return l.capacityTarget;
}

// Returns a snapshot of one lane, or of every lane when no key is given.
export function describe(key = "") {
  if (key) {
    const l = lanes.get(String(key));
    if (!l) return null;
    return {
      key: l.key,
      window: Math.round(l.window * 100) / 100,
      maxWindow: l.maxWindow,
      unlimited: l.unlimited,
      ceiling: l.ceiling,
      capacityHint: l.capacityHint,
      capacityTarget: l.capacityTarget,
      backpressured: l.backpressured,
      effectiveMax: effectiveMax(l),
      running: l.running,
      queued: l.waiters.length,
      avgMs: Math.round(l.avgMs),
      pausedMs: Math.max(0, l.pausedUntil - Date.now()),
      ...l.stats,
    };
  }
  return Array.from(lanes.keys()).map((k) => describe(k));
}

// Clears every lane.
export function reset() {
  lanes.clear();
}

// Returns a short non-secret label distinguishing one AI key's lane from another's.
function aiKeyLane(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return "nokey";
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

// Returns the scheduler lane a job payload belongs to.
export function laneKeyFor(payload) {
  const mode = String(payload?.mode || "").trim().toLowerCase();
  const source = String(payload?.source || "").trim().toLowerCase();
  if (mode === "lens_text" && source === "ai") {
    // AI lanes must stay keyed on (provider, model, key) to match the API's rate_gate metering.
    const ai = payload?.ai || {};
    const provider = String(ai.provider || "auto").trim().toLowerCase();
    const model = String(ai.model || "auto").trim().toLowerCase();
    return `ai:${provider}:${model}:${aiKeyLane(ai.api_key)}`;
  }
  return "lens:direct";
}
