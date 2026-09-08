import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { releaseAiLaneFailure } from "../src/background/pipeline/ai-execution.js";
import { acquire, describe, reset } from "../src/background/scheduler.js";

const files = {
  jobs: await readFile(new URL("../src/background/jobs.js", import.meta.url), "utf8"),
  lifecycle: await readFile(new URL("../src/background/jobs/lifecycle.js", import.meta.url), "utf8"),
  idempotency: await readFile(new URL("../src/background/jobs/idempotency.js", import.meta.url), "utf8"),
  imagePolicy: await readFile(new URL("../src/background/jobs/image-source-policy.js", import.meta.url), "utf8"),
  batchRetry: await readFile(new URL("../src/background/jobs/batch-retry.js", import.meta.url), "utf8"),
  lensDirect: await readFile(new URL("../src/background/pipeline/lens-direct.js", import.meta.url), "utf8"),
  serverTranslation: await readFile(new URL("../src/background/pipeline/server-translation.js", import.meta.url), "utf8"),
  resultDelivery: await readFile(new URL("../src/background/jobs/result-delivery.js", import.meta.url), "utf8"),
  aiExecution: await readFile(new URL("../src/background/pipeline/ai-execution.js", import.meta.url), "utf8"),
};

for (const state of ["settingsEpoch", "currentBatchId", "inFlight"]) {
  assert.match(files.lifecycle, new RegExp(`(?:let|const) ${state}\\b`), `${state} must live in lifecycle`);
  for (const [name, source] of Object.entries(files)) {
    if (name === "lifecycle") continue;
    assert.doesNotMatch(source, new RegExp(`(?:let|const) ${state}\\b`), `${state} is duplicated in ${name}`);
  }
}

assert.doesNotMatch(files.jobs, /function (?:stableString|sha256Hex|idempotencyKeyForPayload)\b/);
assert.doesNotMatch(files.jobs, /const dataUriDomains\b/);
assert.doesNotMatch(files.jobs, /function runRetryPass\b/);
assert.doesNotMatch(files.jobs, /function (?:imageBytesFor|runLensDirectPath|runServerTranslation|submitAndPollServer)\b/);
assert.match(files.jobs, /createBatchRetryCoordinator\(\{/);
assert.match(files.batchRetry, /function finalizeBatch\(batch\)/);
assert.match(files.batchRetry, /async function runRetryPass\(batch\)/);
assert.ok(files.jobs.split("\n").length <= 1200, "jobs.js must remain composition/orchestration, not regain extracted implementations");

const declarations = [...files.jobs.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)];
for (let index = 0; index < declarations.length; index += 1) {
  const start = declarations[index].index;
  const end = declarations[index + 1]?.index ?? files.jobs.length;
  const lines = files.jobs.slice(start, end).split("\n").length;
  const grandfathered = { processJobInner: 331, runSyncTranslate: 317 };
  const limit = grandfathered[declarations[index][1]] || 300;
  assert.ok(lines <= limit, `${declarations[index][1]} is ${lines} lines; split responsibility before it exceeds ${limit}`);
}
for (const name of ["planLocalAi", "runLocalAi", "waitForRetry", "runLocalAiInLane"]) {
  assert.doesNotMatch(files.jobs, new RegExp(`function ${name}\\b`), `${name} must not remain implemented in jobs.js`);
  assert.match(files.aiExecution, new RegExp(`function ${name}\\b`), `${name} must be owned by ai-execution.js`);
}
assert.match(files.jobs, /createAiExecution\(\{/,
  "jobs.js must compose the extracted AI execution owner");
for (const name of ["handleResult", "handleJobError", "handleStaleJob", "failJobImmediately"]) {
  assert.doesNotMatch(files.jobs, new RegExp(`function ${name}\\b`), `${name} must not remain implemented in jobs.js`);
  assert.match(files.resultDelivery, new RegExp(`function ${name}\\b`), `${name} must be owned by result-delivery.js`);
}

const lifecycle = await import("../src/background/jobs/lifecycle.js");
const epoch = lifecycle.getSettingsEpoch();
lifecycle.bumpSettingsEpoch();
assert.equal(lifecycle.getSettingsEpoch(), (epoch + 1) >>> 0);
lifecycle.setCurrentBatchId("batch-owner-test");
assert.equal(lifecycle.getCurrentBatchId(), "batch-owner-test");
const first = lifecycle.beginInFlight("job-1", 7, "batch-1");
const second = lifecycle.beginInFlight("job-2", 7, "batch-2");
assert.equal(lifecycle.abortBatchInFlight("batch-1", "test"), 1);
assert.equal(first.signal.aborted, true);
assert.equal(second.signal.aborted, false);
assert.equal(lifecycle.abortTabInFlight(7, "test"), 1);
assert.equal(second.signal.aborted, true);

reset();
const failureLane = "ai:cloud:ownership-failure";
await acquire(failureLane);
const originalFailure = Object.assign(new Error("busy before generation"), {
  code: "rate_gate_busy",
  status: 429,
  generationAttempts: 0,
});
const classification = releaseAiLaneFailure(
  failureLane,
  { ai: { provider: "openrouter", base_url: "https://openrouter.ai/api/v1" } },
  originalFailure,
  { retryAfterMs: 50 },
);
assert.equal(classification.gated, true,
  "the extracted failure path must preserve rate-gate classification");
assert.equal(describe(failureLane).running, 0,
  "the extracted failure path must release its scheduler slot");
assert.equal(describe(failureLane).gated, 1,
  "the rate-gate release must use the gated path rather than provider backoff");

console.log("Background job ownership passed: mutable lifecycle, idempotency, image policy and retry have one owner.");
