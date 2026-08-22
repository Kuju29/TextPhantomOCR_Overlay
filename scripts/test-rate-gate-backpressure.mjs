// A 429 from the API's own rate gate must not narrow the client's lane.
//
// The bug this guards
// -------------------
// Three different things answer 429 and they mean opposite things:
//
//   provider 429      the model's own quota — "you are sending too fast".
//   server 503/429    the API is out of admission slots — "too many at once".
//   rate_gate 429     this API KEY has no token free yet, and the gate hands
//                     back exactly how long until one does.
//
// `releaseRejected` treats all three alike: it halves the lane window and sets
// `backpressured`, which then needs four clean round trips to clear. On a batch
// big enough to saturate the gate that drove the window to 1 and pinned it
// there — and with the client sending less, the server-side gate never saw the
// clean traffic it needs to raise the rate, so both sides settled at the
// slowest rate either could justify.
//
// Measured on trace-20260819-191505: 330 s of the batch's 478 s of AI time was
// spent waiting for rate-gate tokens, while the API sat idle 88% of the
// session and peaked at 6 concurrent requests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  acquire,
  describe as describeLane,
  releaseFailed,
  releaseGated,
  releaseRejected,
  releaseDeferred,
  releaseSuccess,
  reset,
} from "../src/background/scheduler.js";

const LANE = "ai:gemini:gemini-2.5-flash-lite:k1234";

// Fills the lane to its current window so every release has a slot to return.
async function occupy(key, n) {
  const grants = [];
  for (let i = 0; i < n; i++) grants.push(await acquire(key));
  return grants;
}

// --- a PROVIDER 429/503 still narrows the lane -------------------------------
{
  reset();
  await occupy(LANE, 4);
  const before = describeLane(LANE).window;
  releaseRejected(LANE, 1000);
  const after = describeLane(LANE);
  assert.ok(after.window < before,
    `a real provider backpressure must halve the window (${before} -> ${after.window})`);
  assert.equal(after.backpressured, true, "and must mark the lane backpressured");
  assert.ok(after.pausedMs > 0, "and must respect Retry-After");
}

// --- TextPhantom server_busy also does not -----------------------------------
{
  reset();
  await occupy(LANE, 4);
  const before = describeLane(LANE).window;
  releaseDeferred(LANE, 1000);
  const after = describeLane(LANE);
  assert.equal(after.window, before,
    `server admission deferral must leave provider capacity alone (${before} -> ${after.window})`);
  assert.equal(after.backpressured, false);
  assert.ok(after.pausedMs > 0, "server busy should pace retries without shrinking provider capacity");
  assert.equal(after.deferred, 1);
}

// --- a rate-gate 429 does not ------------------------------------------------
{
  reset();
  await occupy(LANE, 4);
  const before = describeLane(LANE).window;
  releaseGated(LANE, 1500);
  const after = describeLane(LANE);
  assert.equal(after.window, before,
    `a rate-gate 429 must leave the window alone (${before} -> ${after.window})`);
  assert.equal(after.backpressured, false,
    "a rate-gate 429 is pacing, not backpressure: the recovery counter must not arm");
  assert.ok(after.pausedMs > 0,
    "the advertised wait IS the throttle, so the lane must pause for it");
  assert.equal(after.gated, 1, "and it must be counted separately from rejections");
  assert.equal(after.rejected, 0);
}

// --- the difference compounds over a batch -----------------------------------
// Ten paced pages against ten overload rejections, from the same start.
{
  // Released without re-acquiring: `running` floors at 0, and the window is
  // what is being measured. Re-acquiring here would deadlock on the very
  // collapse this asserts.
  const run = (release) => {
    reset();
    for (let i = 0; i < 10; i++) release(LANE, 0);
    return describeLane(LANE).window;
  };
  const gatedWindow = run(releaseGated);
  const rejectedWindow = run(releaseRejected);
  assert.ok(
    gatedWindow > rejectedWindow * 2,
    `ten paced pages must not collapse the lane the way ten overload 429s do `
    + `(gated ${gatedWindow} vs rejected ${rejectedWindow})`,
  );
  assert.equal(rejectedWindow, 1, "overload really does bottom out, as intended");
}

// --- a failure that is neither still leaves the window alone -----------------
{
  reset();
  await occupy(LANE, 2);
  const before = describeLane(LANE).window;
  releaseFailed(LANE);
  assert.equal(describeLane(LANE).window, before);
}

// --- success still widens ----------------------------------------------------
{
  reset();
  await occupy(LANE, 2);
  const before = describeLane(LANE).window;
  releaseSuccess(LANE, 1200);
  assert.ok(describeLane(LANE).window > before, "clean round trips must still widen the lane");
}

// --- the caller must route by the response CODE, not by the status -----------
// A source check: the three 429s are indistinguishable without it, and picking
// the wrong branch is exactly the bug above.
{
  const jobs = await readFile(new URL("../src/background/jobs.js", import.meta.url), "utf8");
  assert.match(jobs, /function isRateGateBusy\(error\)/,
    "jobs.js must classify the 429 before choosing how to release the slot");
  assert.match(jobs, /code === "rate_gate_busy"/,
    "the classifier must read the server's explicit code");
  assert.match(jobs, /if \(gated\) releaseGated\(key, retryAfterMs\);/,
    "the AI stage must use the paced release path");
  assert.match(jobs, /code === "provider_rate_limited"/,
    "a provider throttle with zero generations must be safe to re-queue");
  assert.match(jobs, /generationAttempts[^\n]*!== 0/,
    "safe re-queue classification must be based on generation attempts, not HTTP attempts");
  assert.match(jobs, /else if \(code === "provider_rate_limited"\) releaseRejected\(requestLane, retryAfterMs\);/,
    "the sync retry loop must narrow only for real provider backpressure");
  assert.match(jobs, /else releaseDeferred\(requestLane, serverRetryMs\);/,
    "server_busy/lens refresh must stay in the browser without shrinking provider capacity");
  assert.match(jobs, /generationAttempts === 0[\s\S]*code === "server_busy"/,
    "the API-engine retry loop must only keep pre-generation backpressure in the browser");

  const aiLocal = await readFile(new URL("../src/background/ai-local.js", import.meta.url), "utf8");
  assert.match(aiLocal, /error\.code = code/,
    "text-only AI must preserve the server's machine-readable backpressure code");
  assert.match(aiLocal, /error\.generationAttempts = generationAttempts/,
    "text-only AI must preserve whether a model generation actually happened");

  const apiRoute = await readFile(new URL("../api/backend/api/routes/ai_v1.py", import.meta.url), "utf8");
  assert.match(apiRoute, /run_in_executor\(request\.app\.state\.ai_executor, _run_ai\)/,
    "text.ai must use the dedicated AI executor, never asyncio's shared default pool");
  assert.match(apiRoute, /error_payload\([\s\S]*?code="server_busy"[\s\S]*?generationAttempts": 0/,
    "admission backpressure must use the canonical error payload and remain explicitly pre-provider");
  assert.match(apiRoute, /stable_code = "provider_rate_limited" if provider_limited else kind/,
    "provider throttling must keep its canonical machine-readable code");
  assert.match(apiRoute, /generation_attempts = 0 if provider_limited else 1[\s\S]*?error_payload\([\s\S]*?code=stable_code[\s\S]*?"generationAttempts": generation_attempts/,
    "provider 429/503 must still be reported as a rejected HTTP attempt, not a generation");

  const main = await readFile(new URL("../api/backend/main.py", import.meta.url), "utf8");
  const config = await readFile(new URL("../api/backend/config.py", import.meta.url), "utf8");
  const admission = await readFile(new URL("../api/backend/jobs/admission.py", import.meta.url), "utf8");
  const hfThrottle = await readFile(new URL("../api/backend/ai/throttle.py", import.meta.url), "utf8");
  assert.match(main, /_AI_LIMIT = max\(1, min\(_AI_CONFIGURED, _AI_THREADS\)\)/,
    "AI admission must never exceed the real dedicated executor size");
  assert.match(main, /max_waiters=settings\.sync_ai_max_waiters,[\s\S]*max_wait_sec=settings\.sync_ai_max_wait_sec/,
    "AI admission must have its own no-backlog waiter settings");
  assert.match(main, /adaptive=False,[\s\S]*limit_min=_AI_LIMIT,[\s\S]*limit_max=_AI_LIMIT/,
    "AI admission must stay pinned to executor capacity; provider latency must not shrink it");
  assert.match(config, /TP_SYNC_AI_MAX_WAITERS", 0/,
    "AI server backlog must default to zero waiters");
  assert.match(config, /TP_SYNC_AI_MAX_WAIT_SEC", 10\.0/,
    "AI waiter timeout is only relevant if an operator explicitly enables waiters");
  assert.match(admission, /if self\._max_waiters <= 0:[\s\S]*no server wait queue/,
    "max_waiters=0 must reject immediately instead of secretly queuing one request per identity");
  assert.match(admission, /def _hard_waiting_cap\(self\)[\s\S]*return self\._max_waiters/,
    "max_waiters must be a literal global waiter cap, not limit + max_waiters");
  assert.match(config, /HF_AI_MAX_CONCURRENCY", 0/,
    "HF must not impose a hidden TextPhantom concurrency=1 default");
  assert.match(config, /HF_AI_MIN_INTERVAL_SEC", 0\.0/,
    "HF must not impose a hidden 0.8s spacing default");
  assert.match(hfThrottle, /if gate\.semaphore is None:[\s\S]*return _call\(\)/,
    "HF throttle must truly bypass its semaphore when no manual cap was configured");

  const transport = await readFile(new URL("../src/background/transport.js", import.meta.url), "utf8");
  assert.match(transport, /detail\?\.retryAfterMs/,
    "the precise wait in the body must win over the whole-second Retry-After header");
  assert.match(transport, /httpFailure\("Lens upload failed"[\s\S]*?err\.retryAfterMs/,
    "Lens admission backpressure must preserve Retry-After for browser-side requeue");
  assert.match(transport, /httpFailure\("Grouping failed"[\s\S]*?err\.retryAfterMs/,
    "ONNX admission backpressure must preserve Retry-After for browser-side requeue");

  assert.match(jobs, /async function runStageInLane\(/,
    "Lens and ONNX must each requeue rejected work in the extension");
  assert.match(jobs, /runStageInLane\("lens:direct"/,
    "Lens must own only the Lens lane, not the whole extension-first pipeline");
  assert.match(jobs, /runStageInLane\("onnx:groups"/,
    "vertical grouping must use a separate CPU lane");
  assert.match(jobs, /state: "skipped"[\s\S]*queueWaitMs: 0, providerMs: 0/,
    "pages with no translatable text must bypass the AI scheduler entirely");

  const contextMenu = await readFile(new URL("../src/background/context-menu.js", import.meta.url), "utf8");
  assert.match(contextMenu, /rpm: enabled \? configuredRpm : 0/,
    "a stored RPM must be inert while the user's rate switch is off");
  assert.match(contextMenu, /burst: enabled \? configuredBurst : 0/,
    "a stored burst must be inert while the user's rate switch is off");

  assert.match(main, /app\.state\.lens_executor = ThreadPoolExecutor\(/,
    "Lens must have a dedicated executor");
  assert.match(main, /app\.state\.cpu_executor = ThreadPoolExecutor\(/,
    "ONNX must have a dedicated executor");
  assert.match(main, /app\.state\.pipeline_ai_executor = ThreadPoolExecutor\(/,
    "the API-server AI pipeline must not fall back to asyncio's shared executor");
  assert.match(main, /app\.state\.pipeline_lens_executor = ThreadPoolExecutor\(/,
    "the API-server Lens pipeline must not fall back to asyncio's shared executor");

  const lensRoute = await readFile(new URL("../api/backend/api/routes/lens_v1.py", import.meta.url), "utf8");
  assert.match(lensRoute, /run_in_executor\(\s*request\.app\.state\.lens_executor/,
    "Lens raw must execute on its dedicated pool");
  const groupsRoute = await readFile(new URL("../api/backend/api/routes/groups_v1.py", import.meta.url), "utf8");
  assert.match(groupsRoute, /request\.app\.state\.cpu_executor/,
    "groups must execute on its dedicated CPU pool");

  const syncRoute = await readFile(new URL("../api/backend/api/routes/translate_v1.py", import.meta.url), "utf8");
  assert.match(syncRoute, /pipeline_ai_executor[\s\S]*pipeline_lens_executor/,
    "the API-server engine must choose a dedicated executor by lane");

  assert.match(apiRoute, /if not rate\["enabled"\]/,
    "disabled user pacing must take an explicit no-gate telemetry branch");
  assert.match(apiRoute, /"gated": False/,
    "disabled user pacing must report gated=false instead of stale adaptive RPM telemetry");
}

console.log(
  "Rate-gate backpressure test passed: only provider backpressure narrows AI; "
  + "server admission stays browser-side and manual rate pacing stays time-only.",
);
