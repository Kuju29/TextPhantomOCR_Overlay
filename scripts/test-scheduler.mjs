// Guards the AI lane's AIMD window, the server-reported ceiling, and unlimited mode.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  acquire,
  releaseSuccess,
  releaseReplay,
  releaseLocalFailure,
  releaseRejected,
  releaseDeferred,
  releaseFailed,
  setLaneCeiling,
  setLaneCapacityHint,
  setLaneSlotCeiling,
  setLaneUnlimited,
  configureLocalCapacityForPayload,
  laneKeyFor,
  describe,
  reset,
  restoredWindowForPolicy,
  restoredLocalAutoLearning,
} = await import("../src/background/scheduler.js");

const jobsSource = await readFile(new URL("../src/background/pipeline/server-translation.js", import.meta.url), "utf8");
const extensionAiSource = await readFile(new URL("../src/background/pipeline/ai-execution.js", import.meta.url), "utf8");
assert.doesNotMatch(extensionAiSource,
  /if\s*\(!localCapacity\)[\s\S]{0,180}setLaneSlotCeiling\(key,\s*0\)/,
  "Cloud AI setup must not erase the server-advertised capacity ceiling");
assert.match(jobsSource,
  /const requestLane = laneKeyFor\(outbound\);[\s\S]{0,400}configureLocalCapacityForPayload\(outbound\);[\s\S]{0,900}await acquire\(requestLane/,
  "API-engine path must configure local capacity before its first acquire");
const safeDeferredStart = jobsSource.indexOf("const safeDeferred =");
const safeDeferredContinue = jobsSource.indexOf("continue;", safeDeferredStart);
const safeDeferredEnd = jobsSource.indexOf("if (slotHeld) {", safeDeferredContinue);
assert.ok(safeDeferredStart >= 0 && safeDeferredContinue > safeDeferredStart && safeDeferredEnd > safeDeferredContinue,
  "API-local safe-deferred catch must remain present");
const safeDeferredCatch = jobsSource.slice(safeDeferredStart, safeDeferredEnd);
assert.match(safeDeferredCatch,
  /generationAttempts\s*===\s*0[\s\S]*if\s*\(isBusy\s*&&\s*safeDeferred\)/,
  "API-local safe-deferred catch must require zero generation attempts");
assert.match(safeDeferredCatch,
  /if\s*\(gated\)\s*releaseGated\(requestLane,\s*retryAfterMs\);\s*else\s+if\s*\(localRequest\)\s*releaseLocalFailure\(requestLane,\s*error,\s*retryAfterMs\)/,
  "API-local safe-deferred catch must classify by generation evidence");
assert.match(jobsSource,
  /if \(slotHeld\) \{\s*if \(localRequest\) releaseLocalFailure\(requestLane, error, retryAfterMs\);\s*else if \(isBusy\) releaseRejected/,
  "API-local terminal catch must not reject from HTTP status alone");
assert.match(jobsSource,
  /localProviderMs[\s\S]{0,220}releaseSuccess\(requestLane, localRequest && localProviderMs > 0 \? localProviderMs : requestMs\)/,
  "Local Auto must learn provider execution latency when the API reports it, not browser HTTP overhead");

const { localCapacityConfig, isLocalCapacityFailure } = await import(
  "../src/background/local-capacity.js"
);

// --- lane keys -------------------------------------------------------------
{
  const ai = laneKeyFor({
    mode: "lens_text",
    source: "ai",
    ai: { provider: "gemini", model: "gemini-2.5-flash", api_key: "K" },
  });
  assert.ok(ai.startsWith("ai:gemini:gemini-2.5-flash:"), `unexpected AI lane key ${ai}`);

  const otherKey = laneKeyFor({
    mode: "lens_text",
    source: "ai",
    ai: { provider: "gemini", model: "gemini-2.5-flash", api_key: "OTHER" },
  });
  assert.notEqual(ai, otherKey, "two API keys must not share one lane");
  assert.equal(
    laneKeyFor({
      engine: "api", mode: "lens_text", source: "ai",
      ai: { provider: "gemini", model: "gemini-2.5-flash", api_key: "K" },
    }),
    ai,
    "API and Extension engines must use the same bounded AI lane policy",
  );

  assert.equal(
    laneKeyFor({ mode: "lens_text", source: "original" }),
    "lens:direct",
    "non-AI work belongs to the lens lane",
  );
}

// --- server-advertised Cloud capacity remains authoritative ---------------
reset();
{
  const cloud = {
    mode: "lens_text", source: "ai",
    ai: { provider: "openrouter", model: "fixture", api_key: "secret" },
  };
  const key = laneKeyFor(cloud);
  setLaneCapacityHint(key, 24);
  assert.equal(configureLocalCapacityForPayload(cloud), null,
    "Cloud payload must not acquire a Local capacity policy");
  setLaneUnlimited(key, false);
  assert.equal(describe(key).effectiveMax, 24,
    "Cloud setup must preserve the API's advertised 24-slot ceiling");
  for (let i = 0; i < 40; i++) releaseSuccess(key, 10);
  assert.equal(describe(key).effectiveMax, 24);
  assert.ok(describe(key).window <= 24,
    "Provider successes must never widen past executable server capacity");
}

// --- local capacity is per runtime endpoint + model and provider-managed ----
reset();
{
  const local = (model, limits = {}, base_url = "http://localhost:11434") => ({
    mode: "lens_text", source: "ai",
    ai: { provider: "ollama", model, base_url },
    limits,
  });
  const qwen = local("qwen3.8:27b", { aiUnlimited: true, aiLocalCapacityMode: "auto" });
  const key = laneKeyFor(qwen);
  assert.ok(key.startsWith("ai-local:ollama:"), `unexpected local lane ${key}`);
  assert.notEqual(key, laneKeyFor(local("qwen3.5:12b")), "models must not share learning");
  assert.notEqual(key, laneKeyFor(local("qwen3.8:27b", {}, "http://192.168.1.9:11434")),
    "runtime endpoints must not share learning");
  configureLocalCapacityForPayload(qwen);
  assert.equal(describe(key).effectiveMax, localCapacityConfig(qwen).ceiling,
    "Auto uses the runtime CPU safety ceiling, not a hard-coded minimum of eight");
  assert.ok(describe(key).effectiveMax >= 2 && describe(key).effectiveMax <= 24);
  assert.equal(Math.floor(describe(key).window), 1,
    "unknown Auto runtime must begin with one conservative generation");
  assert.equal(describe(key).unlimited, false, "remove time pacing must not remove capacity");
  const boundedCapacity = describe(key).effectiveMax;
  const first = await acquire(key);
  assert.ok(first.waitMs < 100, "the conservative first generation must have no time/RPM delay");
  const second = acquire(key);
  await Promise.resolve();
  assert.equal(describe(key).queued, 1,
    "unknown runtime must not burst a second generation before success evidence");
  releaseSuccess(key, 1);
  await second;
  assert.equal(Math.floor(describe(key).window), 2,
    "one successful execution must ramp Auto capacity additively");
  releaseSuccess(key, 1);
  assert.ok(describe(key).window <= boundedCapacity,
    "successful ramp-up must remain inside the browser safety ceiling");

  reset();
  const evidenced = local("small", {
    capacityMode: "auto", localCapability: { recommendedMax: 2 },
  });
  const evidenceKey = laneKeyFor(evidenced);
  configureLocalCapacityForPayload(evidenced);
  assert.equal(describe(evidenceKey).effectiveMax, localCapacityConfig(evidenced).ceiling,
    "runtime metadata must not override the runtime CPU safety ceiling");
  assert.equal(Math.floor(describe(evidenceKey).window), 1,
    "metadata alone must not count as successful execution evidence");
  await acquire(evidenceKey);
  releaseSuccess(evidenceKey, 1000);
  assert.ok(describe(evidenceKey).window > 1, "a real successful generation may grow evidenced Auto");
  const learned = describe(evidenceKey).window;
  configureLocalCapacityForPayload(evidenced);
  assert.equal(describe(evidenceKey).window, learned,
    "the next image must not reset unchanged Auto learning to one");

  reset();
  const manual = local("small", { capacityMode: "manual", manualConcurrency: 99 });
  const manualKey = laneKeyFor(manual);
  configureLocalCapacityForPayload(manual);
  assert.equal(describe(manualKey).effectiveMax, 4, "Manual must clamp to the supported 1-4 range");
  assert.equal(Math.floor(describe(manualKey).window), 4);

  reset();
  const safe = local("small", {
    aiLocalCapacityMode: "safe", aiLocalCapabilityConcurrency: 4,
  });
  configureLocalCapacityForPayload(safe);
  assert.equal(describe(laneKeyFor(safe)).effectiveMax, 1, "Safe is fixed at one");

  assert.equal(localCapacityConfig(local("x", { aiLocalCapacityMode: "bogus" })).mode, "auto");
  assert.equal(isLocalCapacityFailure({ generationAttempts: 0, status: 503 }), false,
    "pre-generation 503 is not model capacity evidence");
  assert.equal(isLocalCapacityFailure({ generationAttempts: 1, code: "local_timeout" }), true,
    "a real generation timeout is model capacity evidence");

  assert.equal(restoredWindowForPolicy("auto", 8, 2), 2,
    "evidenced Auto restores its learned safe window after worker restart");
  assert.equal(restoredWindowForPolicy("auto", 1, 2), 1,
    "unknown Auto clamps stale learning to one");
  assert.equal(restoredWindowForPolicy("safe", 1, 2), 1,
    "Safe never borrows an Auto window");
  assert.equal(restoredLocalAutoLearning({ window:9, updatedAt:Date.now() }, 24).valid, false,
    "pre-.54 success-only Local Auto learning must not survive as a proven capacity");
  assert.deepEqual(restoredLocalAutoLearning({ window:2, localAutoVersion:1, localBestLatencyMs:12000, localBestScore:0.00016 }, 24),
    { valid:true, window:2, latencyMs:12000, score:0.00016 },
    "throughput-proven Local Auto learning may survive a worker restart");

  // evidenceKey was reset above, so create a fresh evidenced lane for replay.
  reset();
  configureLocalCapacityForPayload(evidenced);
  const replayKey = laneKeyFor(evidenced);
  await acquire(replayKey);
  const replayWindow = describe(replayKey).window;
  releaseReplay(replayKey);
  assert.equal(describe(replayKey).window, replayWindow,
    "an idempotent replay must not grow Auto");

  reset();
  configureLocalCapacityForPayload(evidenced);
  const failureKey = laneKeyFor(evidenced);
  await acquire(failureKey);
  releaseSuccess(failureKey, 1000);
  await acquire(failureKey);
  const beforeAdmission503 = describe(failureKey).window;
  assert.equal(releaseLocalFailure(failureKey, {
    status: 503, generationAttempts: 0, code: "server_busy",
  }), "deferred");
  assert.equal(describe(failureKey).window, beforeAdmission503,
    "pre-generation local 503 must not narrow capacity");
  await acquire(failureKey);
  assert.equal(releaseLocalFailure(failureKey, {
    status: 503, generationAttempts: 1, code: "local_oom",
  }, 5000), "rejected");
  assert.ok(describe(failureKey).window < beforeAdmission503,
    "post-generation local OOM/503 must narrow capacity");
  assert.equal(describe(failureKey).pausedMs, 0,
    "direct-local Retry-After must not install time pacing");

  reset();
  const saturated = local("gemma-saturated", { aiLocalCapacityMode: "auto" });
  const saturatedKey = laneKeyFor(saturated);
  configureLocalCapacityForPayload(saturated);
  await acquire(saturatedKey);
  releaseSuccess(saturatedKey, 10000);
  assert.equal(Math.floor(describe(saturatedKey).window), 2,
    "Auto should probe one step above its first measured baseline");
  const slowProbeA = acquire(saturatedKey), slowProbeB = acquire(saturatedKey);
  await Promise.all([slowProbeA, slowProbeB]);
  releaseSuccess(saturatedKey, 30000);
  releaseSuccess(saturatedKey, 30000);
  assert.equal(Math.floor(describe(saturatedKey).window), 1,
    "a higher window with worse throughput and 3x latency must fall back to the proven model-specific window");
  assert.equal(describe(saturatedKey).localBestWindow, 1);
  assert.equal(describe(saturatedKey).localStable, true);

  reset();
  const scalable = local("gemma-scalable", { aiLocalCapacityMode: "auto" });
  const scalableKey = laneKeyFor(scalable);
  configureLocalCapacityForPayload(scalable);
  await acquire(scalableKey);
  releaseSuccess(scalableKey, 10000);
  const goodProbeA = acquire(scalableKey), goodProbeB = acquire(scalableKey);
  await Promise.all([goodProbeA, goodProbeB]);
  releaseSuccess(scalableKey, 15000);
  releaseSuccess(scalableKey, 15000);
  assert.equal(describe(scalableKey).localBestWindow, 2,
    "a higher window may become the new baseline only when throughput actually improves");
  assert.equal(Math.floor(describe(scalableKey).window), 3,
    "after a proven gain Auto may probe exactly one further step");
}

// --- the AI window must actually grow --------------------------------------
reset();
{
  const key = "ai:gemini:m:aimd";
  const before = (await acquire(key)).maxWindow;
  releaseSuccess(key, 7000);
  for (let i = 0; i < 59; i++) {
    await acquire(key);
    releaseSuccess(key, 7000);
  }
  const lane = describe(key);
  assert.ok(before >= 8, `AI lane should start at 8 or more, got ${before}`);
  assert.ok(
    lane.window > 8,
    `AI window must widen on clean round trips (stuck at ${lane.window})`,
  );
  assert.ok(lane.window <= lane.maxWindow, "window must respect its ceiling");
}

// --- provider-managed startup uses real executable capacity immediately ----
{
  const key = "ai:gemini:m:fast-start";
  setLaneCapacityHint(key, 24, 0);
  assert.equal(Math.floor(describe(key).window), 24,
    "fresh provider-managed AI must start at the server's real active capacity");
  for (let i = 0; i < 8; i++) {
    await acquire(key);
    releaseSuccess(key, 9000);
  }
  assert.equal(Math.floor(describe(key).window), 24,
    "clean round trips must keep the lane at real capacity");
  await acquire(key);
  releaseRejected(key, 0);
  assert.equal(describe(key).slowStart, false,
    "one provider 429/503 must permanently switch this lane to additive recovery");
  const afterReject = describe(key).window;
  for (let i = 0; i < 4; i++) {
    await acquire(key);
    releaseSuccess(key, 9000);
  }
  assert.ok(describe(key).window < afterReject + 1,
    "recovery after backpressure must be additive, not a second fast-start burst");
}

// --- backpressure narrows it ----------------------------------------------
{
  const key = "ai:gemini:m:aimd";
  const wide = describe(key).window;
  await acquire(key);
  releaseRejected(key, 0);
  const narrow = describe(key).window;
  assert.ok(narrow < wide, `429 must halve the window (${wide} -> ${narrow})`);
  for (let i = 0; i < 8; i++) {
    await acquire(key);
    releaseSuccess(key, 7000);
  }
  assert.ok(describe(key).window > narrow, "clean replies must recover after 429/503 backpressure");
}

// --- cancellation removes a queued waiter without leaking a slot ------------
reset();
{
  const key = "ai:gemini:m:cancel";
  const held = await Promise.all(Array.from({ length: 8 }, () => acquire(key)));
  assert.equal(held.length, 8);
  const ctrl = new AbortController();
  const waiting = acquire(key, ctrl.signal);
  await Promise.resolve();
  assert.equal(describe(key).queued, 1);
  ctrl.abort();
  await assert.rejects(waiting, (error) => error?.name === "AbortError");
  assert.equal(describe(key).queued, 0);
  assert.equal(describe(key).running, 8);
  for (let i = 0; i < 8; i++) releaseSuccess(key, 8000);
  assert.equal(describe(key).running, 0);
}

// --- a non-backpressure failure leaves capacity alone ----------------------
reset();
{
  const key = "ai:gemini:m:aimd";
  await acquire(key);
  releaseSuccess(key, 7000);
  const before = describe(key).window;
  await acquire(key);
  releaseFailed(key);
  assert.equal(describe(key).window, before, "a plain failure must not move the window");
}

// --- TextPhantom server capacity never teaches the provider lane to slow ----
reset();
{
  const key = "ai:gemini:m:server-deferred";
  setLaneCapacityHint(key, 24, 0);
  await acquire(key);
  const before = describe(key).window;
  releaseDeferred(key, 1000);
  const after = describe(key);
  assert.equal(after.window, before, "server_busy must not narrow provider concurrency");
  assert.equal(after.backpressured, false, "server_busy must not arm provider backoff");
  assert.ok(after.pausedMs > 0, "server_busy should pause this browser lane briefly to avoid a 503 storm");
  assert.equal(after.deferred, 1, "server deferrals are tracked separately");
}

// --- server RPM is telemetry, not a duplicate client throttle --------------
reset();
{
  const key = "ai:gemini:m:ceiling";
  await acquire(key);
  releaseSuccess(key, 7000);
  const before = describe(key).effectiveMax;
  assert.equal(setLaneCeiling(key, 12, 8000), before, "12 rpm must not collapse concurrency to 1-2");
  assert.equal(describe(key).ceiling, 0, "RPM observation must not install a ceiling");
}

// --- 24 slow pages retain the initial burst absent explicit backpressure -----
reset();
{
  const key = "ai:gemini:m:burst";
  const pending = Array.from({ length: 24 }, () => acquire(key));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(describe(key).running, 8, "first provider burst must admit eight pages");
  assert.equal(describe(key).queued, 16);
  setLaneCeiling(key, 12, 8000);
  assert.ok(describe(key).effectiveMax >= 8, "server RPM must not collapse the burst");
  for (let i = 0; i < 24; i++) releaseSuccess(key, i === 4 ? 23000 : 8000);
  await Promise.all(pending);
  assert.ok(describe(key).window >= 8, "a slow outlier without provider backpressure must not narrow the lane");
}

// --- a slot ceiling clamps the effective maximum ---------------------------
reset();
{
  const key = "lens:direct";
  setLaneSlotCeiling(key, 3);
  assert.equal(describe(key).effectiveMax, 3, "the lens lane must honour the API's slot count");
  setLaneSlotCeiling(key, 0);
  assert.equal(describe(key).ceiling, 0, "0 clears the ceiling");
}

// --- server AI capacity is a REAL ceiling, not an instruction to flood it ---
reset();
{
  const key = "ai:gemini:m:capacity";
  assert.equal(setLaneCapacityHint(key, 24, 0), 24,
    "provider-managed mode should use executable server capacity immediately");
  const jobs = Array.from({ length: 16 }, () => acquire(key));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(describe(key).running, 16, "ready pages should not wait below real server capacity");
  assert.equal(describe(key).queued, 0);
  for (let i = 0; i < 16; i++) releaseSuccess(key, 8000);
  await Promise.all(jobs);
  assert.equal(describe(key).running, 0);
  assert.equal(Math.floor(describe(key).window), 24, "clean replies keep the full executable capacity");

  setLaneCapacityHint(key, 8, 0);
  assert.equal(describe(key).effectiveMax, 8, "a lower server hint clamps immediately");
  reset();
  const pinned = "ai:gemini:m:pinned-burst";
  setLaneCapacityHint(pinned, 16, 4);
  assert.equal(describe(pinned).capacityTarget, 4, "an explicit user burst is a real concurrency ceiling");
  assert.equal(describe(pinned).effectiveMax, 4);
  assert.equal(Math.floor(describe(pinned).window), 4);
}

// --- repeated hints cannot erase explicit backpressure ----------------------
reset();
{
  const key = "ai:gemini:m:hint-backoff";
  setLaneCapacityHint(key, 24, 0);
  await acquire(key);
  releaseRejected(key, 0);
  const narrowed = describe(key).window;
  setLaneCapacityHint(key, 24, 0);
  assert.equal(describe(key).window, narrowed, "same hint must preserve 429/503 backoff");
  let previous = narrowed;
  for (let i = 0; i < 4; i++) {
    await acquire(key);
    releaseSuccess(key, 8000);
    const current = describe(key).window;
    assert.ok(current - previous < 1, `recovery event must be additive, got ${previous} -> ${current}`);
    previous = current;
  }
  assert.equal(describe(key).backpressured, false);
  assert.ok(describe(key).window < 13, "clean recovery must not jump directly back to server capacity");
  for (let i = 0; i < 400 && describe(key).window < 23.9; i++) {
    await acquire(key);
    const before = describe(key).window;
    releaseSuccess(key, 8000);
    assert.ok(describe(key).window - before < 1, "later recovery must remain additive");
  }
  assert.ok(describe(key).window >= 23.9, "sustained clean replies must eventually recover capacity");
}

// --- unlimited admits everyone and never adapts ----------------------------
reset();
{
  const key = "ai:ollama:llama3:local";
  setLaneUnlimited(key, true);
  const slots = await Promise.all(Array.from({ length: 50 }, () => acquire(key)));
  assert.equal(slots.length, 50, "an unlimited lane must admit every caller");
  assert.ok(slots.every((s) => s.unlimited === true), "slots must report unlimited");
  assert.equal(describe(key).running, 50, "all 50 must be counted as running");

  const windowBefore = describe(key).window;
  for (let i = 0; i < 50; i++) releaseSuccess(key, 100);
  assert.equal(describe(key).window, windowBefore, "unlimited must not move the window");
  assert.equal(describe(key).running, 0, "every slot must be given back");

  setLaneUnlimited(key, false);
  await acquire(key);
  releaseSuccess(key, 100);
  assert.ok(describe(key).window > windowBefore, "AIMD resumes once limits come back");
}

reset();
console.log("Scheduler test passed: fast provider-driven AI widens, provider backpressure narrows, server deferral does not, and user ceilings hold.");
