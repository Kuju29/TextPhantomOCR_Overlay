import { note } from "../shared/trace.js";
// Paces outgoing work per resource lane. Cloud AI lanes remain provider-driven:
// server admission pressure is not provider evidence, while provider backpressure
// narrows the exact provider/model/key lane. Local Auto is different: one machine
// owns the model, so it probes endpoint+model throughput/latency and keeps the best
// measured window instead of widening forever on eventual success.

import { getStorage, setStorage } from "../shared/storage.js";
import {
  isLocalAiPayload,
  isLocalCapacityFailure,
  localCapacityConfig,
  localRuntimeIdentity,
} from "./local-capacity.js";

const MIN_WINDOW = 1;
const DEFAULT_MAX_WINDOW = 32;
// Fallback only when the API has not published executable capacity yet.
// In provider-managed mode, setLaneCapacityHint() starts a fresh key at the
// server's REAL active-worker capacity immediately. There is no benefit in
// making ready work sit in a browser queue while both server and provider are
// idle. A real provider 429/503 still halves this exact key/model lane.
const AI_START_WINDOW = 8;
const AI_MAX_WINDOW = 64;
const BACKOFF_FACTOR = 0.5;
const LOCAL_AUTO_PROBE_SAMPLES = 2;
const LOCAL_AUTO_MIN_THROUGHPUT_GAIN = 1.08;
const LOCAL_AUTO_MAX_LATENCY_RATIO = 1.75;
const LOCAL_AUTO_REPROBE_SUCCESSES = 12;
const LOCAL_AUTO_LEARNING_VERSION = 1;

// Learned concurrency is local to the user's browser and contains only the
// already-hashed lane id, never the API key. Two hours is long enough to avoid
// re-learning on every chapter while short enough to follow provider quota/load
// changes.
const AI_LEARNING_STORAGE_KEY = "aiConcurrencyLearningV1";
const AI_LEARNING_TTL_MS = 2 * 60 * 60 * 1000;
const AI_LEARNING_MAX_ENTRIES = 128;
let learningCache = null;
let learningLoadPromise = null;
let learningGeneration = 0;

const lanes = new Map();
let diagnosticLaneSequence = 0;
function auditCapacity(l, reason, evidence = null) {
  const next={window:l.window,ceiling:effectiveMax(l),pausedUntil:l.pausedUntil,unlimited:l.unlimited};
  const before=l.auditPolicy;
  l.auditPolicy=next;
  if (!before || JSON.stringify(before)===JSON.stringify(next)) return;
  const view=v=>({window:v.window,ceiling:v.ceiling,pauseMs:Math.max(0,v.pausedUntil-Date.now()),unlimited:v.unlimited});
  note("background/scheduler.js","capacityDecision",{schema:"tp.audit/1",event:"capacity_changed",reason,
    scope:{id:l.diagnosticLaneId},before:view(before),after:view(next),
    ...(evidence ? {evidence} : {}), effectiveFrom:"next_request",persistence:"memory_only"});
}

// Returns the initial and maximum window for a lane key.
function lanePolicy(key) {
  const id = String(key || "default").toLowerCase();
  if (!id.startsWith("ai:")) {
    return { initialWindow: 2, maxWindow: DEFAULT_MAX_WINDOW };
  }
  return { initialWindow: AI_START_WINDOW, maxWindow: AI_MAX_WINDOW };
}

// Builds a fresh lane record for a key.
function makeLane(key) {
  const policy = lanePolicy(key);
  return {
    key,
    diagnosticLaneId:`c${++diagnosticLaneSequence}`,
    auditPolicy:{window:policy.initialWindow,ceiling:policy.maxWindow,pausedUntil:0,unlimited:false},
    window: policy.initialWindow,
    maxWindow: policy.maxWindow,
    running: 0,
    resetPending: 0,
    waiters: [],
    avgMs: 0,
    samples: 0,
    pausedUntil: 0,
    ceiling: 0,
    capacityHint: 0,
    capacityTarget: 0,
    userCeiling: 0,
    backpressured: false,
    recoverySuccesses: 0,
    learningLoaded: false,
    learnedWindow: 0,
    learnedUpdatedAt: 0,
    lastPersistedWindow: 0,
    // Fresh lanes without a server capacity hint still use slow start. Once
    // a provider has pushed back we permanently switch this lane to additive
    // recovery, so a recovered key never jumps straight back into the overload
    // that just rejected it. Provider-managed lanes with a real capacity hint
    // start at that capacity immediately.
    slowStart: true,
    unlimited: false,
    localCapacity: null,
    localAuto: {
      bestWindow: 0,
      bestLatencyMs: 0,
      bestScore: 0,
      probeWindow: 0,
      probeSamples: 0,
      probeTotalMs: 0,
      stable: false,
      cooldownSuccesses: 0,
    },
    stats: {
      ok: 0,
      rejected: 0,
      failed: 0,
      backoffs: 0,
      ceilingHits: 0,
      gated: 0,
    },
  };
}

// Applies the local-runtime capacity policy without changing time/RPM pacing.
// Auto starts at one and widens only after successful provider execution. Its
// browser-capacity ceiling is a resource bound, never initial burst permission.
// Runtime metadata is telemetry, not a second hard cap. Safe remains one;
// Manual remains explicitly 1-4.
export function setLocalCapacityPolicy(key, config = {}) {
  const l = lane(key);
  const mode = ["auto", "safe", "manual"].includes(config.mode)
    ? config.mode
    : "auto";
  const modeMax = mode === "auto" ? AI_MAX_WINDOW : 4;
  const ceiling = Math.max(
    1,
    Math.min(modeMax, Math.floor(Number(config.ceiling) || 1)),
  );
  const initial = Math.max(
    1,
    Math.min(ceiling, Math.floor(Number(config.initial) || 1)),
  );
  const evidence = Math.max(0, Number(config.evidence) || 0);
  const samePolicy =
    l.localCapacity?.mode === mode &&
    l.localCapacity?.evidence === evidence &&
    l.localCapacity?.ceiling === ceiling;
  l.localCapacity = {
    mode,
    evidence,
    ceiling,
    capacitySource: String(config.capacitySource || "user_selected"),
  };
  l.unlimited = false;
  l.ceiling = ceiling;
  l.userCeiling = ceiling;
  l.capacityHint = ceiling;
  l.capacityTarget = initial;
  // Payload construction calls this once per image. Preserve learning across
  // images when the policy is unchanged; reset only after an actual mode or
  // capability change.
  if (!samePolicy) {
    if (mode === "manual") l.window = ceiling;
    else l.window = initial;
    l.localAuto = { bestWindow: 0, bestLatencyMs: 0, bestScore: 0,
      probeWindow: Math.floor(l.window), probeSamples: 0, probeTotalMs: 0,
      stable: false, cooldownSuccesses: 0 };
  } else if (l.window > ceiling) {
    l.window = ceiling;
  }
  pump(l,"user_policy");
  return { ...l.localCapacity, ceiling, initial };
}

// The largest window worth holding open, given what the lane may actually spend.
function effectiveMax(l) {
  let cap = l.ceiling > 0 ? Math.min(l.maxWindow, l.ceiling) : l.maxWindow;
  if (l.userCeiling > 0) cap = Math.min(cap, l.userCeiling);
  return Math.max(MIN_WINDOW, cap);
}

function storageAvailable() {
  return typeof chrome !== "undefined" && Boolean(chrome?.storage?.local);
}

function isLearnedAiLane(key) {
  const id = String(key || "").toLowerCase();
  return id.startsWith("ai:") || id.startsWith("ai-local:");
}

async function loadLearningCache() {
  if (!storageAvailable()) return {};
  if (learningCache) return learningCache;
  if (!learningLoadPromise) {
    const generation = learningGeneration;
    learningLoadPromise = getStorage({ [AI_LEARNING_STORAGE_KEY]: {} })
      .then((items) => {
        if (generation !== learningGeneration) return learningCache || {};
        const raw = items?.[AI_LEARNING_STORAGE_KEY];
        learningCache = raw && typeof raw === "object" ? { ...raw } : {};
        return learningCache;
      })
      .catch(() => {
        learningCache = {};
        return learningCache;
      });
  }
  return learningLoadPromise;
}

function pruneLearning(cache) {
  const now = Date.now();
  for (const [key, value] of Object.entries(cache)) {
    const at = Number(value?.updatedAt) || 0;
    if (!at || now - at > AI_LEARNING_TTL_MS) delete cache[key];
  }
  const entries = Object.entries(cache);
  if (entries.length <= AI_LEARNING_MAX_ENTRIES) return;
  entries.sort(
    (a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0),
  );
  const keep = new Set(
    entries.slice(0, AI_LEARNING_MAX_ENTRIES).map(([key]) => key),
  );
  for (const key of Object.keys(cache)) if (!keep.has(key)) delete cache[key];
}

export function restoredLocalAutoLearning(saved, ceiling) {
  const cap = Math.max(MIN_WINDOW, Math.floor(Number(ceiling) || 1));
  const learned = Math.max(0, Math.floor(Number(saved?.window) || 0));
  const latency = Math.max(0, Number(saved?.localBestLatencyMs) || 0);
  const score = Math.max(0, Number(saved?.localBestScore) || 0);
  const valid = Number(saved?.localAutoVersion) === LOCAL_AUTO_LEARNING_VERSION &&
    learned >= MIN_WINDOW && latency > 0 && score > 0;
  return valid
    ? { valid:true, window:Math.min(cap, learned), latencyMs:latency, score }
    : { valid:false, window:MIN_WINDOW, latencyMs:0, score:0 };
}

async function ensureLearningLoaded(l) {
  if (l.learningLoaded) return;
  l.learningLoaded = true;
  if (!isLearnedAiLane(l.key) || !storageAvailable()) return;
  const cache = await loadLearningCache();
  pruneLearning(cache);
  const saved = cache[l.key];
  const at = Number(saved?.updatedAt) || 0;
  const learned = Number(saved?.window) || 0;
  if (!at || Date.now() - at > AI_LEARNING_TTL_MS || learned < MIN_WINDOW)
    return;
  l.learnedWindow = learned;
  l.learnedUpdatedAt = at;
  // Preserve whether the saved window came from provider backpressure. A lane
  // that was forced into additive recovery must not become slow-start merely
  // because the service worker/browser restarted.
  if (saved?.slowStart === false) l.slowStart = false;
  if (l.localCapacity?.mode === "auto") {
    const restored = restoredLocalAutoLearning(saved, effectiveMax(l));
    if (!restored.valid) {
      // Pre-.54 Local Auto learned from successful completions alone. Those
      // windows can be badly over-wide for a large local model, so never treat
      // them as throughput-proven after upgrading. Cloud learning is untouched.
      l.learnedWindow = 0;
      l.learnedUpdatedAt = 0;
      l.window = MIN_WINDOW;
      l.localAuto = { bestWindow:0, bestLatencyMs:0, bestScore:0,
        probeWindow:MIN_WINDOW, probeSamples:0, probeTotalMs:0, stable:false, cooldownSuccesses:0 };
      note("background/scheduler.js","capacityDecision",{schema:"tp.audit/1",event:"capacity_profile_reset",
        reason:"legacy_local_success_only_learning",scope:{id:l.diagnosticLaneId},
        before:{storedWindow:learned},after:{window:MIN_WINDOW},effectiveFrom:"next_request",persistence:"memory_only"});
      return;
    }
    l.localAuto.bestWindow = restored.window;
    l.localAuto.bestLatencyMs = restored.latencyMs;
    l.localAuto.bestScore = restored.score;
    l.localAuto.probeWindow = restored.window;
    l.localAuto.probeSamples = 0;
    l.localAuto.probeTotalMs = 0;
    l.localAuto.stable = true;
    l.localAuto.cooldownSuccesses = 0;
    if (!l.backpressured) l.window = restored.window;
  } else if (!l.backpressured && !l.localCapacity && l.userCeiling <= 0) {
    // Cloud/provider-managed learning keeps its existing behavior.
    l.window = Math.min(effectiveMax(l), Math.max(MIN_WINDOW, learned));
  }
  auditCapacity(l,"stored_capacity");
}

// Pure seam used by restore and regression tests. Safe/Manual are explicit
// choices and never borrow an old Auto window. Unknown Auto has ceiling=1.
export function restoredWindowForPolicy(mode, ceiling, learned) {
  const cap = Math.max(MIN_WINDOW, Math.floor(Number(ceiling) || 1));
  if (String(mode) !== "auto") return cap;
  return Math.min(cap, Math.max(MIN_WINDOW, Math.floor(Number(learned) || 1)));
}

function persistLearning(l, { force = false } = {}) {
  if (!isLearnedAiLane(l.key) || !storageAvailable()) return;
  const learnedCandidate = l.localCapacity?.mode === "auto" && l.localAuto?.bestWindow > 0
    ? l.localAuto.bestWindow : l.window;
  const safe = Math.max(
    MIN_WINDOW,
    Math.floor(Math.min(learnedCandidate, effectiveMax(l))),
  );
  if (!force && safe === l.lastPersistedWindow) return;
  l.lastPersistedWindow = safe;
  l.learnedWindow = safe;
  l.learnedUpdatedAt = Date.now();
  const generation = learningGeneration;
  void loadLearningCache()
    .then((cache) => {
      if (generation !== learningGeneration) return undefined;
      cache[l.key] = {
        window: safe,
        updatedAt: l.learnedUpdatedAt,
        slowStart: l.slowStart !== false,
        ...(l.localCapacity?.mode === "auto" ? {
          localAutoVersion: LOCAL_AUTO_LEARNING_VERSION,
          localBestLatencyMs: Math.max(0, Math.round(Number(l.localAuto?.bestLatencyMs) || 0)),
          localBestScore: Math.max(0, Number(l.localAuto?.bestScore) || 0),
        } : {}),
      };
      pruneLearning(cache);
      return setStorage({ [AI_LEARNING_STORAGE_KEY]: cache });
    })
    .catch(() => {});
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
function pump(l, reason="unchanged", evidence=null) {
  auditCapacity(l,reason,evidence);
  if (l.resetPending > 0) return;
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
  if (l.unlimited) pump(l,"user_policy");
  else auditCapacity(l, "user_policy");
  return l.unlimited;
}

// Waits for a slot in a lane and resolves when the caller may proceed.
export async function acquire(key, signal = null) {
  const l = lane(key);
  await ensureLearningLoaded(l);
  if (l.unlimited) {
    if (signal?.aborted) {
      return Promise.reject(
        new DOMException("The operation was aborted", "AbortError"),
      );
    }
    l.running++;
    return Promise.resolve({
      diagnosticLaneId: l.diagnosticLaneId,
      waitMs: 0,
      maxWindow: 0,
      window: 0,
      running: l.running,
      unlimited: true,
    });
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const queuedAt = Date.now();
    const waiter = {
      resolve: () =>
        resolve({
          diagnosticLaneId: l.diagnosticLaneId,
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

function resetLocalProbe(l, window = Math.floor(l.window)) {
  l.localAuto.probeWindow = Math.max(MIN_WINDOW, Math.floor(window || 1));
  l.localAuto.probeSamples = 0;
  l.localAuto.probeTotalMs = 0;
}

function localAutoSuccess(l, latency) {
  const state = l.localAuto;
  const cap = effectiveMax(l);
  const current = Math.max(MIN_WINDOW, Math.floor(l.window));
  if (!(latency > 0)) {
    pump(l, "local_success_no_latency");
    return;
  }
  if (state.probeWindow !== current) resetLocalProbe(l, current);
  state.probeSamples += 1;
  state.probeTotalMs += latency;
  const sampleLatency = state.probeTotalMs / state.probeSamples;

  // First positive execution establishes a machine+endpoint+model baseline and
  // permits exactly one higher-concurrency probe. No CPU-thread count is used
  // as proof that the model can actually run that many generations.
  if (state.bestWindow <= 0) {
    state.bestWindow = current;
    state.bestLatencyMs = sampleLatency;
    state.bestScore = current / sampleLatency;
    state.stable = false;
    state.cooldownSuccesses = 0;
    if (current < cap) {
      l.window = current + 1;
      resetLocalProbe(l, l.window);
      persistLearning(l, { force: true });
      pump(l, "local_throughput_probe", {bestWindow:state.bestWindow, baselineMs:Math.round(state.bestLatencyMs)});
    } else {
      persistLearning(l, { force: true });
      pump(l, "local_capacity_ceiling");
    }
    return;
  }

  if (current === state.bestWindow) {
    // Keep the baseline responsive to the current machine load, but only probe
    // upward periodically after a previously rejected probe.
    state.bestLatencyMs = state.bestLatencyMs > 0
      ? state.bestLatencyMs * 0.8 + latency * 0.2 : latency;
    state.bestScore = current / state.bestLatencyMs;
    if (state.stable) {
      state.cooldownSuccesses += 1;
      if (state.cooldownSuccesses < LOCAL_AUTO_REPROBE_SUCCESSES || current >= cap) {
        persistLearning(l);
        pump(l, "local_stable_capacity");
        return;
      }
      state.stable = false;
      state.cooldownSuccesses = 0;
    }
    if (current < cap) {
      l.window = current + 1;
      resetLocalProbe(l, l.window);
      persistLearning(l);
      pump(l, "local_throughput_probe", {bestWindow:state.bestWindow, baselineMs:Math.round(state.bestLatencyMs)});
    } else {
      persistLearning(l);
      pump(l, "local_capacity_ceiling");
    }
    return;
  }

  // Higher windows are experiments. Require more than one completion because
  // manga units vary in size. Accept only a real throughput gain without a
  // disproportionate latency increase; otherwise return to the best window.
  if (state.probeSamples < LOCAL_AUTO_PROBE_SAMPLES) {
    pump(l, "local_probe_collecting");
    return;
  }
  const probeLatency = sampleLatency;
  const probeScore = current / probeLatency;
  const baselineLatency = Math.max(1, state.bestLatencyMs || probeLatency);
  const baselineScore = Math.max(Number.EPSILON, state.bestScore || state.bestWindow / baselineLatency);
  const throughputGain = probeScore / baselineScore;
  const latencyRatio = probeLatency / baselineLatency;
  const evidence = {
    bestWindow: state.bestWindow, probeWindow: current,
    baselineMs: Math.round(baselineLatency), probeMs: Math.round(probeLatency),
    throughputGain: Math.round(throughputGain * 1000) / 1000,
    latencyRatio: Math.round(latencyRatio * 1000) / 1000,
    samples: state.probeSamples,
  };
  if (throughputGain >= LOCAL_AUTO_MIN_THROUGHPUT_GAIN &&
      latencyRatio <= LOCAL_AUTO_MAX_LATENCY_RATIO) {
    state.bestWindow = current;
    state.bestLatencyMs = probeLatency;
    state.bestScore = probeScore;
    state.stable = false;
    state.cooldownSuccesses = 0;
    if (current < cap) {
      l.window = current + 1;
      resetLocalProbe(l, l.window);
      persistLearning(l, { force: true });
      pump(l, "local_throughput_gain", evidence);
    } else {
      persistLearning(l, { force: true });
      pump(l, "local_capacity_ceiling", evidence);
    }
    return;
  }
  l.window = Math.max(MIN_WINDOW, Math.min(cap, state.bestWindow));
  state.stable = true;
  state.cooldownSuccesses = 0;
  resetLocalProbe(l, l.window);
  persistLearning(l, { force: true });
  pump(l, "local_throughput_no_gain", evidence);
}

// Returns a slot after a successful round trip and widens the window. Cloud
// lanes remain provider-backpressure driven. Local Auto additionally learns
// machine+endpoint+model throughput so a successful-but-saturated model does
// not keep widening merely because it eventually answered.
export function releaseSuccess(key, ms = 0) {
  const l = lane(key);
  if (consumeResetRelease(l)) return;
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
  if (l.localCapacity?.mode === "auto") {
    localAutoSuccess(l, latency);
    return;
  }
  const growth = l.slowStart ? 1 : 1 / Math.max(1, l.window);
  l.window = Math.min(cap, l.window + growth);
  persistLearning(l);
  pump(l,"provider_success");
}

// Releases an idempotent/cache replay. No model generation completed now, so
// it is neither success evidence nor latency evidence for Auto capacity.
export function releaseReplay(key) {
  const l = lane(key);
  if (consumeResetRelease(l)) return;
  l.running = Math.max(0, l.running - 1);
  l.stats.replayed = (l.stats.replayed || 0) + 1;
  pump(l);
}

// Returns a slot after REAL provider backpressure, halving the provider window
// and pausing this exact provider/model/key lane for Retry-After. Server_busy
// must use releaseDeferred instead: it says nothing about provider capacity.
export function releaseRejected(key, retryAfterMs = 0) {
  const l = lane(key);
  if (consumeResetRelease(l)) return;
  l.running = Math.max(0, l.running - 1);
  l.stats.rejected++;
  if (l.unlimited) return;
  l.window = Math.max(MIN_WINDOW, l.window * BACKOFF_FACTOR);
  l.backpressured = true;
  l.slowStart = false;
  l.recoverySuccesses = 0;
  l.stats.backoffs++;
  if (l.localCapacity?.mode === "auto") {
    const safe = Math.max(MIN_WINDOW, Math.floor(l.window));
    l.localAuto.bestWindow = Math.min(l.localAuto.bestWindow || safe, safe);
    l.localAuto.bestLatencyMs = 0;
    l.localAuto.bestScore = 0;
    l.localAuto.stable = true;
    l.localAuto.cooldownSuccesses = 0;
    resetLocalProbe(l, safe);
  }
  const pause = Number(retryAfterMs) || 0;
  if (pause > 0) l.pausedUntil = Math.max(l.pausedUntil, Date.now() + pause);
  persistLearning(l, { force: true });
  pump(l,"provider_backpressure");
}

// Returns a slot rejected by TextPhantom admission before provider generation.
// This is SERVER pacing, not provider backpressure: keep the learned/window
// value intact, but briefly pause this browser lane so hundreds of queued pages
// do not hammer a full HF process with a 503 storm. The backlog stays here.
export function releaseDeferred(key, retryAfterMs = 0) {
  const l = lane(key);
  if (consumeResetRelease(l)) return;
  l.running = Math.max(0, l.running - 1);
  l.stats.deferred = (l.stats.deferred || 0) + 1;
  const pause = Number(retryAfterMs) || 0;
  if (pause > 0) l.pausedUntil = Math.max(l.pausedUntil, Date.now() + pause);
  pump(l,"server_admission_defer");
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
  if (consumeResetRelease(l)) return;
  l.running = Math.max(0, l.running - 1);
  l.stats.gated++;
  if (l.unlimited) return;
  // The lane pause IS the throttle, and it is lane-wide on purpose: the bucket
  // belongs to the API key, so every request on this lane faces the same empty
  // bucket. Nothing else changes — not the window, not the backpressure flag.
  const pause = Number(retryAfterMs) || 0;
  if (pause > 0) l.pausedUntil = Math.max(l.pausedUntil, Date.now() + pause);
  pump(l,"rate_gate_defer");
}

// Returns a slot after a failure that is not backpressure, leaving the window unchanged.
export function releaseFailed(key) {
  const l = lane(key);
  if (consumeResetRelease(l)) return;
  l.running = Math.max(0, l.running - 1);
  l.stats.failed++;
  pump(l);
}

// Releases a direct/API local-runtime attempt using generation evidence rather
// than HTTP status alone. Admission failures did not exercise model capacity.
export function releaseLocalFailure(key, error, retryAfterMs = 0) {
  // Local generations are protected by slot capacity, not time pacing. Never
  // carry Retry-After into the lane: a real OOM/overload still narrows the
  // concurrency window, while the next queued request can start as soon as a
  // slot is free. The caller's one-provider-call contract remains unchanged.
  void retryAfterMs;
  const attempts = Number(
    error?.generationAttempts || error?.providerAttempts || 0,
  );
  if (attempts < 1) {
    releaseDeferred(key, 0);
    return "deferred";
  }
  const status = Number(error?.status) || 0;
  if (status === 429 || status === 503 || isLocalCapacityFailure(error)) {
    releaseRejected(key, 0);
    return "rejected";
  }
  releaseFailed(key);
  return "failed";
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
  auditCapacity(l,"runtime_capacity_hint");
  return l.ceiling;
}

// Records the server's REAL executable AI capacity as a hard ceiling. A fresh
// provider-managed key starts at this capacity immediately; a saved provider
// backoff resumes at its learned lower value. An explicit user Burst is stricter
// than both and becomes the user's own concurrency ceiling.
export function setLaneCapacityHint(key, slots, burst = 0) {
  const l = lane(key);
  if (l.unlimited) return 0;
  const n = Number(slots) || 0;
  l.capacityHint = n > 0 ? Math.max(MIN_WINDOW, Math.floor(n)) : 0;
  l.ceiling = l.capacityHint;
  const b = Math.max(0, Math.floor(Number(burst) || 0));
  // An explicitly enabled Burst is a user limit, not a hint. Auto/provider-
  // managed mode passes zero and therefore has no TextPhantom concurrency cap
  // other than real executable server capacity.
  l.userCeiling = b > 0 ? Math.max(MIN_WINDOW, b) : 0;
  const hard = effectiveMax(l);
  const learned = l.learnedWindow > 0 ? Math.floor(l.learnedWindow) : 0;
  l.capacityTarget =
    b > 0
      ? Math.min(hard, b)
      : // Fresh provider-managed work starts at the real executable capacity. If
        // this exact key/model already learned a smaller safe value after provider
        // backpressure, that learned value wins once storage has loaded.
        learned > 0
        ? Math.min(hard, learned)
        : hard;
  if (l.window > hard) l.window = hard;
  if (!l.backpressured && l.window < l.capacityTarget)
    l.window = l.capacityTarget;
  pump(l,"runtime_capacity_hint");
  return l.capacityTarget;
}

// Returns a snapshot of one lane, or of every lane when no key is given.
export function describe(key = "") {
  if (key) {
    const l = lanes.get(String(key));
    if (!l) return null;
    return {
      key: l.key,
      diagnosticLaneId: l.diagnosticLaneId,
      window: Math.round(l.window * 100) / 100,
      maxWindow: l.maxWindow,
      unlimited: l.unlimited,
      ceiling: l.ceiling,
      capacityHint: l.capacityHint,
      capacityTarget: l.capacityTarget,
      userCeiling: l.userCeiling,
      learnedWindow: l.learnedWindow,
      learnedAgeMs: l.learnedUpdatedAt
        ? Math.max(0, Date.now() - l.learnedUpdatedAt)
        : 0,
      backpressured: l.backpressured,
      slowStart: l.slowStart,
      effectiveMax: effectiveMax(l),
      running: l.running,
      queued: l.waiters.length,
      avgMs: Math.round(l.avgMs),
      ...(l.localCapacity?.mode === "auto" ? {
        localBestWindow: l.localAuto.bestWindow,
        localBestLatencyMs: Math.round(l.localAuto.bestLatencyMs || 0),
        localProbeWindow: l.localAuto.probeWindow,
        localProbeSamples: l.localAuto.probeSamples,
        localStable: l.localAuto.stable,
      } : {}),
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

/** Forget adaptive backpressure immediately; storage removal is owned by the UI reset transaction. */
export function resetAdaptiveLearning() {
  learningGeneration += 1;
  learningCache = {};
  learningLoadPromise = Promise.resolve(learningCache);
  for (const [key, l] of lanes) {
    const policy = lanePolicy(key);
    l.window = policy.initialWindow;
    l.maxWindow = policy.maxWindow;
    l.ceiling = 0;
    l.capacityHint = 0;
    l.capacityTarget = 0;
    l.userCeiling = 0;
    l.unlimited = false;
    l.localCapacity = null;
    l.localAuto = { bestWindow: 0, bestLatencyMs: 0, bestScore: 0,
      probeWindow: 0, probeSamples: 0, probeTotalMs: 0,
      stable: false, cooldownSuccesses: 0 };
    l.learnedWindow = 0;
    l.learnedUpdatedAt = 0;
    l.lastPersistedWindow = 0;
    l.backpressured = false;
    l.slowStart = true;
    l.recoverySuccesses = 0;
    l.pausedUntil = 0;
    l.resetPending = Math.max(0, l.running);
    if (l.resetPending === 0 && l.waiters.length === 0) lanes.delete(key);
    else if (l.resetPending === 0) pump(l, "settings_reset");
  }
}

function consumeResetRelease(l) {
  if (!(l.resetPending > 0)) return false;
  l.running = Math.max(0, l.running - 1);
  l.resetPending = Math.max(0, l.resetPending - 1);
  if (l.resetPending === 0) {
    if (l.waiters.length === 0) lanes.delete(l.key);
    else pump(l, "settings_reset_complete");
  }
  return true;
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
  const mode = String(payload?.mode || "")
    .trim()
    .toLowerCase();
  const source = String(payload?.source || "")
    .trim()
    .toLowerCase();
  if (mode === "lens_text" && source === "ai") {
    // AI lanes must stay keyed on (provider, model, key) to match the API's rate_gate metering.
    const ai = payload?.ai || {};
    const provider = String(ai.provider || "auto")
      .trim()
      .toLowerCase();
    const model = String(ai.model || "auto")
      .trim()
      .toLowerCase();
    if (isLocalAiPayload(payload)) {
      const identity = localRuntimeIdentity(payload);
      return `ai-local:${identity.protocol}:${aiKeyLane(identity.endpoint)}:${model}`;
    }
    return `ai:${provider}:${model}:${aiKeyLane(ai.api_key)}`;
  }
  return "lens:direct";
}

export function configureLocalCapacityForPayload(payload) {
  if (!isLocalAiPayload(payload)) return null;
  const key = laneKeyFor(payload);
  return { key, ...setLocalCapacityPolicy(key, localCapacityConfig(payload)) };
}
