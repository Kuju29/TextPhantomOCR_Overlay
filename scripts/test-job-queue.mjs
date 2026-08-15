// Verifies bounded automatic admission, draining and pre-start cancellation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  addTask,
  applyServerConcurrencyHint,
  describeLimits,
  setMaxConcurrency,
} = await import("../src/background/job-queue.js");
const { ensureBatch, getBatch } = await import("../src/background/batches.js");

const waitUntil = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for queue");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

setMaxConcurrency(0);
assert.ok(Number.isFinite(describeLimits().effective), "automatic admission must be finite");
assert.ok(describeLimits().effective >= 2, "automatic admission must make useful progress");
assert.ok(describeLimits().effective <= 24, "automatic admission must retain a safe ceiling");

let running = 0;
let peak = 0;
let completed = 0;
for (let i = 0; i < 500; i++) {
  addTask(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 1));
    running--;
    completed++;
  });
}
await waitUntil(() => completed === 500);
assert.ok(peak <= describeLimits().effective, `peak ${peak} exceeded effective admission`);
assert.equal(describeLimits().queued, 0, "queue must drain");
assert.equal(describeLimits().running, 0, "running count must return to zero");

setMaxConcurrency(12);
applyServerConcurrencyHint(3);
assert.equal(describeLimits().effective, 3);
applyServerConcurrencyHint(undefined);
applyServerConcurrencyHint(null);
applyServerConcurrencyHint("");
assert.equal(describeLimits().effective, 3, "missing hints must preserve learned capacity");
applyServerConcurrencyHint(9);
applyServerConcurrencyHint(9);
assert.equal(describeLimits().effective, 3, "two optimistic hints must not widen admission");
applyServerConcurrencyHint(9);
assert.equal(describeLimits().effective, 9, "three matching hints may widen admission");
applyServerConcurrencyHint(0);
assert.equal(describeLimits().effective, 12, "zero clears server hint but respects client ceiling");

setMaxConcurrency(500);
assert.equal(describeLimits().max, 64, "an unsafe explicit value is clamped to the documented hard ceiling");

setMaxConcurrency(1);
let releaseBlocker;
const blocker = new Promise((resolve) => { releaseBlocker = resolve; });
let started = 0;
addTask(() => blocker);
const ctrl = new AbortController();
addTask(() => { started++; }, { signal: ctrl.signal });
addTask(() => { started++; }, { shouldStart: () => false });
ctrl.abort();
releaseBlocker();
await waitUntil(() => describeLimits().running === 0 && describeLimits().queued === 0);
assert.equal(started, 0, "cancelled/stale queued tasks must not start");

// Behavioural cancellation race: with the only slot blocked, cancelling the
// existing batch must keep its queued server work at zero after the slot frees.
let releaseBatchBlocker;
const batchBlocker = new Promise((resolve) => { releaseBatchBlocker = resolve; });
let serverRouteCalls = 0;
const cancelledBatch = ensureBatch("cancel-before-admit", 1, 0);
addTask(() => batchBlocker);
addTask(() => { serverRouteCalls++; }, {
  shouldStart: () => !getBatch("cancel-before-admit")?.cancelled,
});
cancelledBatch.cancelled = true;
releaseBatchBlocker();
await waitUntil(() => describeLimits().running === 0 && describeLimits().queued === 0);
assert.equal(serverRouteCalls, 0, "a CANCEL_BATCH race must not start its server route");

// Integration guard: production enqueue must actually pass the pre-start
// session predicate; testing only the queue primitive would miss broken wiring.
const jobsSource = await readFile(new URL("../src/background/jobs.js", import.meta.url), "utf8");
assert.match(jobsSource, /\{ shouldStart: isAdmissible \}/,
  "production enqueue must wire session+batch cancellation into admission");
assert.match(jobsSource, /getBatch\(batchId\)\?\.cancelled\) return/,
  "processJob must defensively stop a cancelled batch before workflow/server work");
const beginRecheck = jobsSource.indexOf("if (await stopIfBatchWasCancelled()) return;",
  jobsSource.indexOf("const workflowId = await wf.begin"));
const baseLookup = jobsSource.indexOf("const base = await getApiBase();", beginRecheck);
const baseRecheck = jobsSource.indexOf("if (await stopIfBatchWasCancelled()) return;", baseLookup);
const firstPrefetch = jobsSource.indexOf("if (shouldPrefetchDataUri(payload))", baseRecheck);
const mediaReady = jobsSource.indexOf("await wf.mediaReady(workflowId);", firstPrefetch);
const mediaRecheck = jobsSource.indexOf("if (await stopIfBatchWasCancelled()) return;", mediaReady);
const pendingRegistration = jobsSource.indexOf("pendingByImage.set", mediaRecheck);
const capabilitiesProbe = jobsSource.indexOf("await getCapabilities(base)", mediaRecheck);
assert.ok(beginRecheck > 0 && beginRecheck < baseLookup,
  "cancellation must be rechecked immediately after wf.begin yields");
assert.ok(baseRecheck > baseLookup && baseRecheck < firstPrefetch,
  "cancellation must be rechecked after getApiBase and before external prefetch");
assert.ok(mediaRecheck > mediaReady && mediaRecheck < pendingRegistration,
  "cancellation must be rechecked after media awaits and before registration");
assert.ok(mediaRecheck < capabilitiesProbe,
  "cancelled work must stop before the capabilities probe");
assert.match(jobsSource, /\{ shouldStart: \(\) => pendingByJob\.has\(jobId\) \}/,
  "resumed polls removed during cancellation must not start from the queue");

console.log("Job queue test passed: auto is bounded, 500 jobs drain, hints stabilize, cancellation skips.");
