import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyAiTranslationReport } from "../src/shared/lens-document.js";

assert.deepEqual(classifyAiTranslationReport({ translated: 3, missing: [] }), {
  usable: true, complete: true, translated: 3, missing: [], reason: "",
});
assert.deepEqual(classifyAiTranslationReport({ translated: 2, missing: ["g2"] }), {
  usable: true, complete: false, translated: 2, missing: ["g2"], reason: "",
});
assert.deepEqual(classifyAiTranslationReport({ translated: 0, missing: ["g1"] }), {
  usable: false, complete: false, translated: 0, missing: ["g1"],
  reason: "AI returned no usable translations",
});

const jobs = await readFile(new URL("../src/background/jobs.js", import.meta.url), "utf8");
assert.match(jobs, /return classifyAiTranslationReport\(report\)/,
  "local AI must return an explicit usable/complete/missing outcome");
assert.match(jobs, /if \(!aiOutcome\.complete\)[\s\S]*?inserting a partial single response/,
  "a usable partial response must continue to insertion without another generation");
assert.match(jobs, /const finalFidelity = aiOutcome\?\.usable[\s\S]*?canRenderFaithfully/,
  "partial output must still pass the normal geometry gate");
assert.match(jobs, /result\.aiPartial = \{[\s\S]*?missing: report\.missing\.map\(String\)/,
  "inserted partials must carry explicit missing IDs");
assert.match(jobs, /missingUnits = missingUnitIds\.map[\s\S]*?paragraphIds/,
  "partial metadata must retain the stable unit-to-paragraph ownership map");
assert.doesNotMatch(jobs, /AI text was incomplete; no automatic retry was made/,
  "missing units alone must no longer be a terminal reason");
console.log("AI partial outcome test passed: usable partials insert with metadata and fidelity gating.");
