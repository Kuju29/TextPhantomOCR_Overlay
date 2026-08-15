// Two very different things used to share one warning:
//
//   "overlay: paragraphs have no text for this layer"
//
// (a) the model answered some units and not others - the page is fine, the
//     source text is still on screen because this build refuses to erase what
//     it cannot replace; and
// (b) the grouping names a paragraph the document does not have - a real
//     structural mismatch.
//
// Reading (a) as (b) is what sent the last few debugging rounds after the wrong
// bug, so the report separates them and the two log lines say what happened.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const renderer = await readFile(new URL("../src/processors/render-overlay.js", import.meta.url), "utf8");
const overlay = await readFile(new URL("../src/content/overlay.js", import.meta.url), "utf8");

// --- the report distinguishes them ------------------------------------------
{
  assert.match(renderer, /aiUnanswered:\s*\[\]/, "the render report must carry aiUnanswered");
  // The ai-missing branch pushes to BOTH lists: `missingLayer` stays the
  // superset so nothing that used to be reported silently stops being reported.
  const aiBranch = renderer.slice(
    renderer.indexOf('if (layer === "ai-missing")'),
    renderer.indexOf('if (!text.trim())'),
  );
  assert.ok(aiBranch.includes("report.missingLayer.push(para.id)"), "still counted as missing");
  assert.ok(aiBranch.includes("report.aiUnanswered.push(para.id)"), "and named as unanswered");

  // The structural branch must NOT be counted as an unanswered unit.
  const structural = renderer.slice(
    renderer.indexOf("if (missingMember) {"),
    renderer.indexOf("if (merged.length) {"),
  );
  assert.ok(structural.includes("report.missingLayer.push(para.id)"));
  assert.ok(
    !structural.includes("report.aiUnanswered.push"),
    "a document/grouping mismatch is not the model's fault and must not be logged as one",
  );
}

// --- the two messages exist and say the right thing --------------------------
{
  assert.doesNotMatch(
    overlay,
    /paragraphs have no text for this layer/,
    "the old message claimed there was no text when the text is still on screen",
  );
  assert.match(
    overlay,
    /AI partial — kept the original text where the model did not answer/,
    "the partial case must say what actually happened",
  );
  // Units and paragraphs are different numbers: one unanswered two-column
  // bubble is 1 unit and 2 paragraphs. Reporting only paragraphs made a
  // 5-unit shortfall read as "10".
  assert.match(overlay, /const partial = result\?\.aiPartial \|\| null;/,
    "the unit-level truth comes from result.aiPartial");
  assert.match(overlay, /paragraphs: unanswered\.length/,
    "the paragraph count keeps its own field");
  assert.match(overlay, /unitIds: Array\.isArray\(partial\?\.missing\)/,
    "the unit ids must be logged so they can be matched against the server's missingIds");
  assert.match(
    overlay,
    /grouping and document disagree/,
    "the structural case keeps its own message",
  );
  // The structural log must exclude the unanswered ids, or one partial page
  // would raise both warnings and look like two problems.
  assert.match(
    overlay,
    /const structural = report\.missingLayer\.filter\(\(id\) => !unanswered\.includes\(id\)\)/,
    "the two lists must not overlap in the log",
  );
}

console.log("Partial warning test passed: an unanswered unit and a broken grouping no longer share a message.");
