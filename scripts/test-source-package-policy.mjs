import assert from "node:assert/strict";
import { isForbiddenProjectArchiveEntry } from "./source-package-policy.mjs";

for (const forbidden of [
  "src/shared/ai/workload/learning.js.tmp", "x.py.orig", "src/.#edit.js", "src/thing.js~",
  "e2e", "e2e/README.md", "./e2e/src/cli.mjs",
  "launcher", "launcher/run.ps1", "LAUNCHER/build.bat",
  "api/tests", "api/tests/test_queue.py",
  "api/logs", "api/logs/ai-wire/job/04_provider_request.json",
  "api/state", "api/state/rate-gate.json",
]) {
  assert.equal(isForbiddenProjectArchiveEntry(forbidden), true, `${forbidden} must not ship`);
}
for (const allowed of ["src/e2e-helper.js", "api/backend/launcher_compat.py", "README.md", "packages/TextPhantom.zip"]) {
  assert.equal(isForbiddenProjectArchiveEntry(allowed), false, `${allowed} is not a forbidden top-level project path`);
}
console.log("Source package policy passed: tests, launcher, logs, state and AI wire captures are excluded from project archives.");
