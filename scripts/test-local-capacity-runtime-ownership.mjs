import assert from "node:assert/strict";
import { applyRuntimeCapacityHints } from "../src/background/jobs/capacity-policy.js";
import { configureLocalCapacityForPayload, describe, laneKeyFor, reset } from "../src/background/scheduler.js";
import { waitForLocalRequest } from "../src/background/ai/local-request-rate.js";

const caps = { adaptive: { lens: { limit: 8 }, ai: { limit: 24 } },
  capacityGroups: { limit: 8 } };
const payload = (mode, manualConcurrency = 1) => ({ mode: "lens_text", source: "ai",
  ai: { provider: "ollama", model: "chat:9b", base_url: "http://localhost:11434" },
  limits: { aiLocalCapacityMode: mode, manualConcurrency } });

for (const [mode, manualConcurrency, expected] of [
  ["safe", 1, 1], ["manual", 2, 2], ["auto", 1, 1],
]) {
  reset();
  const local = payload(mode, manualConcurrency);
  configureLocalCapacityForPayload(local);
  const before = describe(laneKeyFor(local));
  applyRuntimeCapacityHints(caps, local);
  const after = describe(laneKeyFor(local));
  assert.equal(after.window, expected, `${mode}: API AI slots must not replace Local policy`);
  assert.equal(after.ceiling, before.ceiling, `${mode}: the Local ceiling must remain owned by Local settings`);
  assert.equal(describe("lens:direct").effectiveMax, 8, "server Lens slots still apply");
  assert.equal(describe("groups:partition").effectiveMax, 8, "server grouping slots still apply");
}
reset();
const cloud = { mode: "lens_text", source: "ai", ai: { provider: "groq", model: "chat",
  api_key: "fixture" } };
applyRuntimeCapacityHints(caps, cloud);
assert.equal(describe(laneKeyFor(cloud)).effectiveMax, 24,
  "Cloud generations still use the API AI limit");
await assert.rejects(waitForLocalRequest({ provider: "ollama", model: "chat:9b" },
  { enabled: true, rpm: 0 }), (error) => error.code === "invalid_local_request_rate");
console.log("Local capacity and manual RPM remain separate; API AI slots affect only Cloud.");
