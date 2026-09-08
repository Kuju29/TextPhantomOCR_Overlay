import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyAiTranslationReport } from "../src/shared/lens-document.js";
import { classifyAiOutcomeIds } from "../src/background/pipeline/ai-outcome-classification.js";
import { classifyDirectLocalMissingIds } from "../src/shared/ai/direct-local/result-classification.js";

assert.deepEqual(classifyAiOutcomeIds({
  missing: ["g0", "g1", "g2", "g3"], omitted: ["g0", "g0"],
  empty: ["g0", "g1"], wrongLanguage: ["g1", "g2"], preserved: ["g3"],
}), {
  missingIds: [], omittedIds: ["g0"], emptyIds: ["g1"],
  wrongLanguageIds: ["g2"], preservedIds: ["g3"],
});
assert.deepEqual(classifyDirectLocalMissingIds({
  missingIds: ["P0", "P1", "P2"], emptyIds: ["P1"], malformedMarkerIds: ["P2"],
}, [{ id: "P0" }, { id: "P1" }, { id: "P2" }],
[{ id: "g0" }, { id: "g1" }, { id: "g2" }]), {
  omittedIds: ["g0"], declinedIds: ["g1"], malformedIds: ["g2"],
});

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
const pageTranslation = await readFile(
  new URL("../src/background/pipeline/page-translation.js", import.meta.url), "utf8",
);
assert.match(pageTranslation, /const report = classifyReport\(applied\.report\);[\s\S]*?return report;/,
  "local AI must return an explicit usable/complete/missing outcome");
assert.match(jobs, /if \(!aiOutcome\.complete\)[\s\S]*?inserting a partial single response/,
  "a usable partial response must continue to insertion without another generation");
assert.match(jobs, /const finalFidelity = aiOutcome\?\.usable[\s\S]*?canRenderFaithfully/,
  "partial output must still pass the normal geometry gate");
assert.match(pageTranslation, /result\.aiPartial = \{[\s\S]*?missing:\s*missingIds/,
  "inserted partials must carry explicit missing IDs");
assert.match(pageTranslation, /missingUnits = missingIds\.map[\s\S]*?paragraphIds/,
  "partial metadata must retain the stable unit-to-paragraph ownership map");
assert.doesNotMatch(`${jobs}\n${pageTranslation}`, /AI text was incomplete; no automatic retry was made/,
  "missing units alone must no longer be a terminal reason");
console.log("AI partial outcome test passed: usable partials insert with metadata and fidelity gating.");
