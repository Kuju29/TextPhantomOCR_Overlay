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
} = await import("../src/background/scheduler.js");

const jobsSource = await readFile(new URL("../src/background/jobs.js", import.meta.url), "utf8");
assert.match(jobsSource,
  /const requestLane = laneKeyFor\(outbound\);[\s\S]{0,400}configureLocalCapacityForPayload\(outbound\);[\s\S]{0,900}await acquire\(requestLane/,
  "API-engine path must configure local capacity before its first acquire");
assert.match(jobsSource,
  /if \(gated\) releaseGated\(requestLane,[\s\S]{0,180}else if \(localRequest\) releaseLocalFailure\(requestLane, e, retryAfterMs\)/,
  "API-local safe-deferred catch must classify by generation evidence");
assert.match(jobsSource,
  /if \(slotHeld\) \{\s*if \(localRequest\) releaseLocalFailure\(requestLane, e, retryAfterMs\);\s*else if \(isBusy\) releaseRejected/,
  "API-local terminal catch must not reject from HTTP status alone");

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

// --- local capacity is per runtime endpoint + model and starts safely -------
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
  assert.equal(describe(key).effectiveMax, 1, "unknown Auto capacity must stay at one");
  assert.equal(describe(key).unlimited, false, "remove time pacing must not remove capacity");

  reset();
  const evidenced = local("small", {
    capacityMode: "auto", localCapability: { recommendedMax: 2 },
  });
  const evidenceKey = laneKeyFor(evidenced);
  configureLocalCapacityForPayload(evidenced);
  assert.equal(Math.floor(describe(evidenceKey).window), 1, "Auto must begin at one");
  assert.equal(describe(evidenceKey).effectiveMax, 2, "runtime evidence may permit conservative growth");
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

  assert.equal(restoredWindowForPolicy("auto", 2, 2), 2,
    "evidenced Auto restores its learned safe window after worker restart");
  assert.equal(restoredWindowForPolicy("auto", 1, 2), 1,
    "unknown Auto clamps stale learning to one");
  assert.equal(restoredWindowForPolicy("safe", 1, 2), 1,
    "Safe never borrows an Auto window");

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
  }), "rejected");
  assert.ok(describe(failureKey).window < beforeAdmission503,
    "post-generation local OOM/503 must narrow capacity");
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
