// Provider-driven AI concurrency: learn clean capacity locally, isolate it per
// provider/model/key, preserve it across lane recreation, and let an explicit
// user Burst override the learned value.
import assert from "node:assert/strict";

const storage = {};
globalThis.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        if (Array.isArray(keys)) {
          const out = {};
          for (const key of keys) out[key] = storage[key];
          cb(out);
          return;
        }
        if (keys && typeof keys === "object") {
          const out = { ...keys };
          for (const key of Object.keys(keys)) {
            if (Object.prototype.hasOwnProperty.call(storage, key)) out[key] = storage[key];
          }
          cb(out);
          return;
        }
        cb({ ...storage });
      },
      set(patch, cb) {
        Object.assign(storage, patch || {});
        cb?.();
      },
    },
  },
};

const {
  acquire,
  releaseSuccess,
  releaseRejected,
  releaseDeferred,
  setLaneCapacityHint,
  describe,
  reset,
} = await import("../src/background/scheduler.js");

const KEY = "ai:gemini:gemini-2.5-flash:keyhash-a";
setLaneCapacityHint(KEY, 24, 0);
assert.equal(describe(KEY).window, 24,
  "a fresh provider-managed key should use real server capacity immediately");
for (let i = 0; i < 8; i++) {
  await acquire(KEY);
  releaseSuccess(KEY, 8000);
}
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(Math.floor(describe(KEY).window), 24,
  "clean replies keep a fresh provider-managed lane at server capacity");
assert.ok(storage.aiConcurrencyLearningV1?.[KEY]?.window >= 24,
  "the clean capacity must persist in browser storage");

// Recreating the lane (new chapter / service workflow) resumes learned speed.
reset();
setLaneCapacityHint(KEY, 24, 0);
const learnedGrant = await acquire(KEY);
assert.ok(learnedGrant.window >= 16,
  `a recreated lane should resume learned concurrency, got ${learnedGrant.window}`);
releaseSuccess(KEY, 8000);

// Shared server pressure never erases provider knowledge.
const beforeDeferred = describe(KEY).window;
await acquire(KEY);
releaseDeferred(KEY, 1000);
assert.equal(describe(KEY).window, beforeDeferred,
  "server_busy must not rewrite learned provider capacity");

// A real provider throttle does, because that is authoritative quota evidence.
await new Promise((resolve) => setTimeout(resolve, 1100));
await acquire(KEY);
releaseRejected(KEY, 0);
await new Promise((resolve) => setTimeout(resolve, 0));
const backedOff = Math.floor(describe(KEY).window);
assert.ok(backedOff < beforeDeferred, "provider backpressure must reduce learned concurrency");
reset();
setLaneCapacityHint(KEY, 24, 0);
const backedOffGrant = await acquire(KEY);
assert.ok(backedOffGrant.window <= backedOff,
  "a new lane must remember the provider's reduced safe window");
assert.equal(describe(KEY).slowStart, false,
  "provider backpressure recovery mode must persist across lane recreation");
releaseSuccess(KEY, 8000);

// The user's explicit Burst is always stricter than remembered/automatic speed.
reset();
setLaneCapacityHint(KEY, 24, 4);
const manualGrant = await acquire(KEY);
assert.equal(manualGrant.maxWindow, 4, "manual Burst must cap the effective lane");
assert.equal(manualGrant.window, 4, "manual Burst must override learned startup speed");
releaseSuccess(KEY, 8000);

// A different API key gets its own learning lane and does not inherit this one.
const OTHER = "ai:gemini:gemini-2.5-flash:keyhash-b";
setLaneCapacityHint(OTHER, 24, 0);
const otherGrant = await acquire(OTHER);
assert.equal(otherGrant.window, 24,
  "another fresh key uses capacity immediately but must not inherit someone else's reduced history");
releaseSuccess(OTHER, 8000);

const serialized = JSON.stringify(storage.aiConcurrencyLearningV1 || {});
assert.ok(!serialized.includes("actual-secret"), "learning storage must never contain raw API keys");

console.log("Provider-driven AI test passed: capacity-first startup, learned per-key backoff, server deferral, and manual Burst all hold.");
