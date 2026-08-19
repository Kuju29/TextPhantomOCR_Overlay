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

// --- a provider/server 429 still narrows the lane ----------------------------
{
  reset();
  await occupy(LANE, 4);
  const before = describeLane(LANE).window;
  releaseRejected(LANE, 1000);
  const after = describeLane(LANE);
  assert.ok(after.window < before,
    `a real backpressure 429 must halve the window (${before} -> ${after.window})`);
  assert.equal(after.backpressured, true, "and must mark the lane backpressured");
  assert.ok(after.pausedMs > 0, "and must respect Retry-After");
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
  assert.match(jobs, /if \(gated\) releaseGated\(key, Number\(e\?\.retryAfterMs\) \|\| 0\);/,
    "the AI stage must use the paced release path");
  assert.match(jobs, /if \(gated\) releaseGated\(requestLane, retryAfterMs\);/,
    "the sync retry loop must use it too");

  const transport = await readFile(new URL("../src/background/transport.js", import.meta.url), "utf8");
  assert.match(transport, /detail\?\.retryAfterMs/,
    "the precise wait in the body must win over the whole-second Retry-After header");
}

console.log(
  "Rate-gate backpressure test passed: paced 429s wait without narrowing the lane, "
  + "overload 429s still narrow it, and the two are told apart by code.",
);
