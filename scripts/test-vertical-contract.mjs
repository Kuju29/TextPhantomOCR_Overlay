import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decideVerticalMerge, resolveVerticalMergeContract } from "../src/shared/vertical-verdict.js";
import { authoritativeLensImageSize, remapRawBubbleGroups } from "../src/shared/lens-decode.js";

const groups = [{ para_indices: [0], text: "x" }];
assert.deepEqual(authoritativeLensImageSize({ width: 1200, height: 1800 }), { width: 1200, height: 1800 });
assert.throws(() => authoritativeLensImageSize({ width: 0, height: 1800 }), /invalid authoritative/);
assert.throws(() => authoritativeLensImageSize({ width: 1200.5, height: 1800 }), /invalid authoritative/);
assert.deepEqual(
  remapRawBubbleGroups(
    [{ para_indices: [0, 1, 2], text: "base" }, { para_indices: [1], text: "ruby" }],
    [0, null, 1],
  ),
  [{ para_indices: [0, 1], text: "base" }],
  "raw grouping keeps detector geometry while dropped ruby cannot shift document membership",
);
const mappedVerdicts = [
  { usable: true, outcome: "complete", authority: "model" },
  { usable: true, outcome: "partial", authority: "partial" },
  { usable: true, outcome: "identity", authority: "identity_geometry" },
];
for (const merge of mappedVerdicts) {
  const payload = {
    merge,
    tree: { bubble_groups: remapRawBubbleGroups([{ para_indices: [0, 1, 2] }], [0, null, 1]) },
  };
  assert.deepEqual(payload.tree.bubble_groups[0].para_indices, [0, 1]);
  assert.equal(decideVerticalMerge(payload, "ai").decision, "attach", merge.outcome);
}
const rubyOnlyAccepted = {
  merge: { usable: true, outcome: "complete", authority: "model" },
  tree: { bubble_groups: remapRawBubbleGroups([{ para_indices: [1] }], [0, null, 1]) },
};
assert.equal(resolveVerticalMergeContract(rubyOnlyAccepted).malformed, true);
assert.equal(decideVerticalMerge(rubyOnlyAccepted, "ai").decision, "stop");
assert.equal(decideVerticalMerge(rubyOnlyAccepted, "original").decision, "continue-ungrouped");
assert.equal(decideVerticalMerge(rubyOnlyAccepted, "translated").decision, "continue-ungrouped");
const emptyGroupShapes = [[], [{}], [{ para_indices: [] }]];
const matrix = [
  [{ merge: { usable: true }, tree: { bubble_groups: groups } }, true, "explicit"],
  [{ merge: { usable: false }, tree: { bubble_groups: groups } }, false, "explicit"],
  [{ merge: { usable: true }, tree: {} }, false, "explicit"],
  [{ merge: { applied: true }, tree: { bubble_groups: groups } }, true, "legacy"],
  [{ merge: { authority: "partial" }, coverage: { modelStampedVertical: 2 }, tree: { bubble_groups: groups } }, true, "legacy"],
  [{ merge: { authority: "partial" }, coverage: { modelStampedVertical: 0 }, tree: { bubble_groups: groups } }, false, "legacy"],
  [{ merge: { applied: true }, tree: {} }, false, "legacy"],
];
for (const bubble_groups of emptyGroupShapes) {
  matrix.push([{ merge: { usable: true }, tree: { bubble_groups } }, false, "explicit"]);
  matrix.push([{ merge: { applied: true }, tree: { bubble_groups } }, false, "legacy"]);
}
for (const [payload, usable, contract] of matrix) {
  const answer = resolveVerticalMergeContract(payload);
  assert.equal(answer.usable, usable, JSON.stringify(payload));
  assert.equal(answer.contract, contract, JSON.stringify(payload));
}

for (const bubble_groups of emptyGroupShapes) {
  const malformed = { merge: { usable: true }, tree: { bubble_groups } };
  const resolved = resolveVerticalMergeContract(malformed);
  assert.equal(resolved.malformed, true, JSON.stringify(malformed));
  assert.equal(decideVerticalMerge(malformed, "ai").decision, "stop");
  assert.equal(decideVerticalMerge(malformed, "original").decision, "continue-ungrouped");
  assert.equal(decideVerticalMerge(malformed, "translated").decision, "continue-ungrouped");
}

const unusable = { merge: { usable: false }, tree: { bubble_groups: groups } };
assert.equal(decideVerticalMerge(unusable, "ai").decision, "stop");
assert.equal(decideVerticalMerge(unusable, "original").decision, "continue-ungrouped");
assert.equal(decideVerticalMerge(unusable, "translated").decision, "continue-ungrouped");
assert.equal(decideVerticalMerge(matrix[0][0], "ai").decision, "attach");

const jobs = await readFile(new URL("../src/background/jobs.js", import.meta.url), "utf8");
assert.match(jobs, /remapRawBubbleGroups[\s\S]*const coverage[\s\S]*decideVerticalMerge/,
  "raw memberships must be remapped before the usability verdict");
assert.match(jobs, /if \(!mergeUsable && isAiSource\)/, "AI unusable must stop");
assert.match(jobs, /if \(mergeUsable\) document = attachBubbleGroups\(/,
  "only a structurally usable verdict may reach the attach path");
assert.doesNotMatch(jobs, /if \([^\n]*isAiSource[^\n]*\) document = attachBubbleGroups\(/,
  "AI source must not bypass the shared usability verdict");
assert.match(jobs, /decision: mergeContract\.decision/,
  "Original and Translated must continue ungrouped");
assert.match(jobs, /units: translationUnits\(document\)\.length/,
  "ungrouped logging must not dereference a missing groups array");

console.log("Vertical contract test passed: explicit/legacy matrix and per-source behavior hold.");
