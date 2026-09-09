// Verifies bounded automatic admission, draining and pre-start cancellation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildEnqueuePolicy } from "../src/background/pipeline/enqueue-policy.js";
import { createJobPreparation } from "../src/background/pipeline/job-preparation.js";

const {
  addTask,
  applyServerConcurrencyHint,
  describeLimits,
  setMaxConcurrency,
} = await import("../src/background/job-queue.js");
const { ensureBatch, getBatch } = await import("../src/background/batches.js");
const {
  claimImageJob,
  releaseImageJob,
  scheduleOwnedImageJob,
} = await import("../src/background/jobs/lifecycle.js");

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


// Extension-first orchestration is NOT held behind the top-level image cap.
// Its Lens/AI lanes are the actual resource governors, so an image waiting on
// AI cannot prevent later images from starting their Lens stage.
setMaxConcurrency(1);
let releaseLaneManaged;
const laneManagedBlocker = new Promise((resolve) => { releaseLaneManaged = resolve; });
let laneManagedStarted = 0;
for (let i = 0; i < 20; i++) {
  addTask(async () => {
    laneManagedStarted++;
    await laneManagedBlocker;
  }, { laneManaged: true });
}
await waitUntil(() => laneManagedStarted === 20);
assert.equal(describeLimits().running, 0,
  "lane-managed extension work must not consume the bounded API-engine slots");
assert.equal(describeLimits().laneManagedRunning, 20);
releaseLaneManaged();
await waitUntil(() => describeLimits().laneManagedRunning === 0);

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

// The extracted enqueue policy is location-independent and exercises the exact
// predicates passed to the queue by production orchestration.
let currentSession = "session-a";
const policyBatch = { cancelled: false };
const extensionPolicy = buildEnqueuePolicy({
  engine: "extension",
  context: { tp_tab_session: "session-a" },
  metadata: { batch_id: "batch-a" },
}, 7, {
  getTabSessionId: (tabId) => tabId === 7 ? currentSession : "",
  getBatch: (batchId) => batchId === "batch-a" ? policyBatch : null,
});
assert.equal(extensionPolicy.laneManaged, true,
  "runs:Extension must bypass the top-level image slot and use resource lanes");
assert.equal(extensionPolicy.shouldStart(), true);
currentSession = "session-b";
assert.equal(extensionPolicy.shouldStart(), false, "a stale tab session cannot start");
currentSession = "session-a";
policyBatch.cancelled = true;
assert.equal(extensionPolicy.shouldStart(), false, "a cancelled batch cannot start");
const apiPolicy = buildEnqueuePolicy({ engine: "api" }, 7, {
  getTabSessionId: () => "session-a", getBatch: () => null,
});
assert.equal(apiPolicy.laneManaged, false,
  "runs:API server must remain bounded by the top-level image slot");

// Two discoveries of the same image can arrive in the same JavaScript turn.
// The synchronous owner claim must allow only one provider-capable workflow to
// cross the first async boundary.
{
  const identity = {
    batchId: "batch-atomic",
    imageKey: "image-atomic",
    sessionId: "session-atomic",
    engine: "extension",
    settingsEpoch: 7,
    tabId: 42,
  };
  let workflowStarts = 0;
  let providerCapableStarts = 0;
  const submit = async () => {
    const owner = claimImageJob(identity);
    if (!owner.claimed) return false;
    try {
      await Promise.resolve();
      workflowStarts++;
      providerCapableStarts++;
      return true;
    } finally {
      releaseImageJob(owner);
    }
  };
  const [firstStarted, duplicateStarted] = await Promise.all([
    submit(), submit(),
  ]);
  assert.deepEqual([firstStarted, duplicateStarted], [true, false]);
  assert.equal(workflowStarts, 1);
  assert.equal(providerCapableStarts, 1,
    "concurrent duplicate enqueue must not create a second provider-capable job");
  const afterTerminal = claimImageJob(identity);
  assert.equal(afterTerminal.claimed, true,
    "terminal release must permit an intentional later run");
  releaseImageJob(afterTerminal);
  const newBatch = claimImageJob({ ...identity, batchId: "batch-new" });
  assert.equal(newBatch.claimed, true,
    "a genuinely new batch must retain independent ownership");
  releaseImageJob(newBatch);
}

function preparationFixture(overrides = {}) {
  const calls = [];
  const cache = new Map();
  const dependencies = {
    batchIsCancelled: () => false,
    failWorkflow: async (reason) => { calls.push(["failWorkflow", reason]); },
    shouldPrefetch: () => true,
    fetchFromTab: async (_tabId, src, _frameId) => `data:image/png;base64,TAB:${src}`,
    fetchFromUrl: async (src, pageUrl) => `data:image/png;base64,URL:${src}:${pageUrl}`,
    getCached: (key) => cache.get(key),
    setCached: (key, value) => { cache.set(key, value); calls.push(["setCached", key, value]); },
    normalizeImageKey: (src) => `key:${src}`,
    classifyError: () => ({ permanent: false }),
    onDownloadStarted: () => { calls.push(["download"]); },
    onPayloadUpdated: (payload) => { calls.push(["updated", payload]); },
    onPermanentReadError: async (error) => { calls.push(["permanent", error]); },
    logInfo: (message, detail) => { calls.push(["info", message, detail]); },
    logWarn: (message, detail) => { calls.push(["warn", message, detail]); },
    ...overrides,
  };
  return { preparation: createJobPreparation(dependencies), calls, cache };
}

// Cancellation checkpoint occurs before callers enter prefetch work.
{
  let prefetchChecks = 0;
  const fixture = preparationFixture({
    batchIsCancelled: () => true,
    shouldPrefetch: () => { prefetchChecks++; return true; },
  });
  assert.equal(await fixture.preparation.stopIfBatchWasCancelled(), true);
  assert.deepEqual(fixture.calls, [["failWorkflow", "cancelled with batch"]]);
  assert.equal(prefetchChecks, 0, "cancelled preparation must not inspect or fetch image media");
}

// Cache hit bypasses both network paths and hydrates the payload immediately.
{
  let networkCalls = 0;
  const fixture = preparationFixture({
    fetchFromTab: async () => { networkCalls++; },
    fetchFromUrl: async () => { networkCalls++; },
  });
  const payload = { src: "https://cdn.test/cached.png", metadata: {} };
  fixture.cache.set(`key:${payload.src}`, "data:image/png;base64,CACHED");
  assert.deepEqual(await fixture.preparation.prefetchDataUri(payload), {
    stopped: false, cached: true,
  });
  assert.equal(payload.imageDataUri, "data:image/png;base64,CACHED");
  assert.equal(networkCalls, 0);
}

// A server-side HTTP 403 falls back to the browser tab, where page credentials
// and anti-hotlink context may legitimately make the same image readable.
{
  const fixture = preparationFixture({
    fetchFromUrl: async () => { throw new Error("HTTP 403 from image host"); },
    fetchFromTab: async (tabId, src, frameId) => {
      fixture.calls.push(["tabFetch", tabId, src, frameId]);
      return "data:image/webp;base64,FALLBACK";
    },
  });
  const payload = { src: "https://protected.test/page.webp", metadata: {} };
  const outcome = await fixture.preparation.prefetchDataUri(payload, {
    tabId: 19, frameId: 3, pageUrl: "https://protected.test/chapter",
  });
  assert.deepEqual(outcome, { stopped: false });
  assert.equal(payload.imageDataUri, "data:image/webp;base64,FALLBACK");
  assert.deepEqual(fixture.calls.find(([name]) => name === "tabFetch"),
    ["tabFetch", 19, payload.src, 3]);
  assert.equal(payload.metadata.pipeline.at(-1).stage, "prefetch_datauri_tab");
}

// Permanent browser-only failures stop preparation and publish a typed error.
{
  const fixture = preparationFixture({
    fetchFromTab: async () => { throw new Error("tab cannot read blob"); },
  });
  const payload = { src: "blob:https://reader.test/id", metadata: {} };
  assert.deepEqual(await fixture.preparation.prefetchDataUri(payload, { tabId: 5 }), {
    stopped: true,
  });
  const permanent = fixture.calls.find(([name]) => name === "permanent");
  assert.equal(permanent[1].code, "IMG_BLOCKED");
  assert.equal(permanent[1].payload, payload);
}

// A fresh successful read updates cache, pipeline metadata and observers.
{
  const fixture = preparationFixture();
  const payload = { src: "https://cdn.test/new.png", metadata: { pipeline: [{ stage: "queued" }] } };
  assert.deepEqual(await fixture.preparation.prefetchDataUri(payload, {
    pageUrl: "https://reader.test/chapter",
  }), { stopped: false });
  assert.equal(fixture.cache.get(`key:${payload.src}`), payload.imageDataUri);
  assert.deepEqual(payload.metadata.pipeline.map(({ stage }) => stage), ["queued", "prefetch_datauri"]);
  assert.ok(!Number.isNaN(Date.parse(payload.metadata.timestamp)));
  assert.equal(fixture.calls.filter(([name]) => name === "updated").length, 1);
}

// These remaining lifecycle checks stay until cancellation preparation is
// extracted behind an injectable module; they must not be silently weakened.
const jobsSource = await readFile(new URL("../src/background/jobs.js", import.meta.url), "utf8");
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
const capabilitiesProbe = jobsSource.indexOf("await getFreshCapabilitiesForScope(base", mediaRecheck);
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
assert.match(jobsSource, /return scheduleOwnedImageJob\(\{[\s\S]{0,700}?work: \(\) => processJob\(payload/,
  "production enqueue must pass work through atomic image ownership");

// Exercise the production ownership scheduler itself, not only its map.
{
  let scheduled = 0;
  let started = 0;
  let releaseWork;
  const held = new Promise((resolve) => { releaseWork = resolve; });
  const args = {
    identity: {
      batchId: "batch-scheduler", imageKey: "image-scheduler",
      sessionId: "session-scheduler", engine: "extension",
      settingsEpoch: 8, tabId: 8,
    },
    isAdmissible: () => true,
    schedule: (fn, options) => {
      scheduled++;
      assert.equal(options.shouldStart(), true);
      void fn();
    },
    work: async () => { started++; await held; },
    laneManaged: true,
  };
  assert.equal(scheduleOwnedImageJob(args), true);
  assert.equal(scheduleOwnedImageJob(args), false);
  await Promise.resolve();
  assert.equal(scheduled, 1);
  assert.equal(started, 1);
  releaseWork();
}

console.log("Job queue test passed: auto is bounded, 500 jobs drain, hints stabilize, cancellation skips.");
