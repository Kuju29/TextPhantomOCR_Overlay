// Guards the per-image state machine: legal transitions, terminals, staleness.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  STATES,
  TERMINAL,
  IN_FLIGHT,
  MAX_STAGE_ATTEMPTS,
  isTerminal,
  canTransition,
  allowedFrom,
  createWorkflow,
  transition,
  stageExhausted,
  isCurrent,
  describeWorkflow,
} = await import("../src/shared/workflow-states.js");

const ALL = new Set(Object.values(STATES));

// --- the state set is closed and terminals absorb --------------------------
{
  for (const state of TERMINAL) {
    assert.ok(ALL.has(state), `TERMINAL names an unknown state: ${state}`);
    assert.equal(isTerminal(state), true, `${state} must report as terminal`);
    assert.deepEqual(allowedFrom(state), [], `${state} is terminal and must allow no exit`);
    for (const to of ALL) {
      assert.equal(canTransition(state, to), false, `${state} must not move to ${to}`);
    }
  }
  for (const state of IN_FLIGHT) {
    assert.ok(ALL.has(state), `IN_FLIGHT names an unknown state: ${state}`);
    assert.equal(isTerminal(state), false, `${state} is in flight, not terminal`);
  }
}

// --- transition returns a verdict, never a mutated record ------------------
{
  const record = createWorkflow({ workflowId: "w1", itemId: "img-1", request: { mode: "lens_text" } });
  const target = allowedFrom(record.state).find((s) => !IN_FLIGHT.has(s));
  assert.ok(target, "a fresh workflow must have at least one non-in-flight successor");

  const moved = transition(record, target, { reason: "test", now: 1000 });
  assert.equal(moved.ok, true, `expected ${record.state} -> ${target} to be legal`);
  assert.equal(record.state, STATES.CREATED, "the input record must not be mutated");
  assert.equal(moved.record.stateVersion, 1, "each accepted move bumps the version");
}

// --- an in-flight state cannot be entered without an operation id ----------
{
  const record = createWorkflow({ workflowId: "w2", itemId: "img-2", request: {} });
  const inflight = allowedFrom(record.state).find((s) => IN_FLIGHT.has(s));
  if (inflight) {
    const withoutId = transition(record, inflight, { reason: "test" });
    assert.equal(withoutId.ok, false, `${inflight} must refuse to start without an operation id`);
    const withId = transition(record, inflight, { reason: "test", operation: "op-1" });
    assert.equal(withId.ok, true, "an operation id makes the same move legal");
    assert.equal(withId.record.operation, "op-1", "the id is committed before the call it names");
  }
}

// --- an illegal transition is refused with a reason ------------------------
{
  const record = createWorkflow({ workflowId: "w3", itemId: "img-3", request: {} });
  const illegal = [...ALL].find((s) => s !== record.state && !canTransition(record.state, s));
  assert.ok(illegal, "there must be at least one illegal target to test");
  const refused = transition(record, illegal, { reason: "test" });
  assert.equal(refused.ok, false, `transition to ${illegal} must be refused`);
  assert.match(refused.reason, /illegal transition/, "the refusal must say why");

  const same = transition(record, record.state, { reason: "test" });
  assert.equal(same.ok, false, "re-entering the current state is refused, not a silent no-op");
}

// --- degradations are stored, not just logged ------------------------------
{
  let record = createWorkflow({ workflowId: "w4", itemId: "img-4", request: {} });
  let degraded = null;
  for (const to of ALL) {
    if (!canTransition(record.state, to)) continue;
    const attempt = transition(record, to, { reason: "lens declined", now: 1, operation: "op" });
    if (attempt.ok && attempt.record.degradations.length > record.degradations.length) {
      degraded = attempt.record;
      break;
    }
  }
  if (degraded) {
    const entry = degraded.degradations.at(-1);
    assert.equal(entry.reason, "lens declined", "the reason must survive on the record");
    assert.ok(entry.stage, "a degradation names its stage");
    assert.equal(entry.attempts, 1, "the first degradation is attempt 1");
  }
}

// --- generations catch a result produced for a previous page instance ------
{
  const generation = { pageInstanceId: "page-a", targetKey: "u", targetRevision: 0 };
  const record = createWorkflow({ workflowId: "w5", itemId: "img-5", request: {}, generation });
  assert.equal(isCurrent(record, generation), true, "the same generation is current");
  assert.equal(
    isCurrent(record, { ...generation, pageInstanceId: "page-b" }),
    false,
    "a new page instance must invalidate the old result",
  );
  assert.equal(
    isCurrent(record, { ...generation, targetRevision: 1 }),
    false,
    "a recycled <img> must invalidate the old result",
  );
  assert.equal(isCurrent(record, null), false, "no generation is not current");
}

// --- stage attempts are bounded --------------------------------------------
{
  assert.equal(MAX_STAGE_ATTEMPTS, 3, "the attempt budget is part of the contract");
  const record = createWorkflow({ workflowId: "w6", itemId: "img-6", request: {} });
  assert.equal(stageExhausted(record, "lens"), false, "a fresh stage has attempts left");
  const spent = { ...record, adapters: { lens: { attempts: MAX_STAGE_ATTEMPTS } } };
  assert.equal(stageExhausted(spent, "lens"), true, "the budget must actually stop the stage");
}

// --- a workflow stays describable for the logs -----------------------------
{
  const record = createWorkflow({ workflowId: "w7", itemId: "img-7", request: {} });
  const described = describeWorkflow(record);
  assert.equal(described.workflowId, "w7");
  assert.equal(described.itemId, "img-7");
  assert.equal(described.state, STATES.CREATED);
  assert.deepEqual(described.degradations, []);
}

// --- Lens success followed by a direct-local failure belongs to AI ----------
{
  let record = createWorkflow({ workflowId: "w8", itemId: "img-8", request: { source: "ai" } });
  const move = (to, options = {}) => {
    const moved = transition(record, to, options);
    assert.equal(moved.ok, true, `${record.state} -> ${to} must be legal`);
    record = moved.record;
  };
  move(STATES.MEDIA_READY);
  move(STATES.LENS_REQUESTED, { operation: "lens-direct:w8" });
  move(STATES.LENS_READY);
  move(STATES.AI_REQUESTED, { operation: "ai-route:w8" });
  assert.equal(canTransition(record.state, STATES.LENS_DEGRADED), false,
    "a local AI throw after Lens success must never be blamed on Lens");
  move(STATES.AI_DEGRADED, { reason: "local AI returned no text" });
  move(STATES.FAILED, { reason: "local AI returned no text" });
  assert.equal(record.degradations.at(-1)?.stage, "ai");
}

// --- admission backpressure keeps one request in flight until success -------
{
  let record = createWorkflow({ workflowId: "w9", itemId: "img-9", request: { engine: "api" } });
  const move = (to, options = {}) => {
    const moved = transition(record, to, options);
    assert.equal(moved.ok, true, `${record.state} -> ${to} must be legal`);
    record = moved.record;
  };
  move(STATES.MEDIA_READY);
  move(STATES.LENS_REQUESTED, { operation: "sync:w9" });
  // Two server_busy/provider_rate_limited waits cause no workflow transition;
  // the eventual response completes the one operation committed above.
  assert.equal(transition(record, STATES.LENS_REQUESTED, { operation: "sync:w9:retry" }).ok, false,
    "a retry must not re-enter the same REQUESTED state");
  move(STATES.LENS_READY);
  move(STATES.TEXT_READY);
}

// Guard the orchestration wiring as well as the pure transition table.
{
  const jobs = await readFile(new URL("../src/background/jobs.js", import.meta.url), "utf8");
  assert.match(jobs, /if \(directStage === "ai"\)[\s\S]*?wf\.aiDegraded/,
    "the direct-local catch must attribute failures to AI");
  assert.match(jobs, /let serverRequestTracked = false;[\s\S]*?if \(!serverRequestTracked\)/,
    "sync retries must commit their workflow operation only once");
  const transient = jobs.slice(
    jobs.indexOf("if (isBusy && safeDeferred)"),
    jobs.indexOf("if (slotHeld)", jobs.indexOf("if (isBusy && safeDeferred)") + 30),
  );
  assert.doesNotMatch(transient, /wf\.(?:lensRequested|aiRequested|lensDegraded|aiDegraded)/,
    "transient backpressure must remain in the current REQUESTED state");
  for (const phase of [
    "waiting", "downloading", "lens", "grouping", "ai_queued",
    "ai_generating", "server_processing", "rendering", "done", "error", "cancelled",
  ]) {
    assert.match(jobs, new RegExp(`mark(?:Job|Image)Phase\\([^\\n]*["']${phase}["']`),
      `jobs must report the real ${phase} boundary`);
  }
  assert.match(jobs, /markJobPhase\(jobId, "ai_queued"\)[\s\S]*?acquire\(key, signal\)[\s\S]*?markJobPhase\(jobId, "ai_generating"\)/,
    "AI must say queued before scheduler admission and generating only after admission");
  assert.match(jobs, /markImagePhase\(batchId, imageKey, "rendering"\)[\s\S]*?enqueueDomInsert/,
    "rendering must begin before DOM insertion");
  assert.match(jobs, /markImagePhase\(b\.id, k, "waiting", \{\s*attempt: 2,[\s\S]*?lastError: ""/,
    "retry pass must reopen terminal errors with a new attempt and clear the stale reason");
  assert.match(jobs, /discardBatchResults[\s\S]*?markImagePhase\(bid, key, "cancelled"/,
    "discarding a batch must terminally cancel active per-image phases");
  assert.match(jobs, /apiEngine && !lensDone[\s\S]*?"server_processing"[\s\S]*?Server processing \(Lens\/AI\)/,
    "the combined API engine must not pretend its opaque server pipeline is still only in Lens");
}

console.log("Workflow state test passed: closed state set, terminals absorb, generations invalidate.");
