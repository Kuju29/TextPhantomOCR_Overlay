import assert from "node:assert/strict";
import {
  buildEraseBoxes,
  eraseBoxesForAiPartial,
} from "../src/shared/erase-boxes.js";

const token = (para_index, left) => ({
  para_index,
  box: { left, top: 0.1, width: 0.1, height: 0.05 },
});
const owned = buildEraseBoxes([token(0, 0.1), token(1, 0.3), token(2, 0.5)], {
  ownerForToken: (t) => `p${t.para_index}`,
});

// Horizontal partial: translated p0 is erased, missing p1/p2 stay as source pixels.
let doc = { paragraphs: [
  { id: "p0", aiText: "แปลแล้ว" },
  { id: "p1" },
  { id: "p2" },
] };
let selected = eraseBoxesForAiPartial(doc, owned);
assert.equal(selected.ok, true);
assert.deepEqual(selected.eraseBoxes.boxes.map((b) => b.p), ["p0"]);

// A vertical group has one rendered leader but owns/erases every member.
doc = { paragraphs: [
  { id: "p0", aiText: "ทั้งบอลลูน", aiGroupParagraphIds: ["p0", "p1"] },
  { id: "p1", aiCoveredBy: "p0" },
  { id: "p2" },
] };
selected = eraseBoxesForAiPartial(doc, owned);
assert.equal(selected.ok, true);
assert.deepEqual(selected.eraseBoxes.boxes.map((b) => b.p), ["p0", "p1"]);

// Old payloads and broken group membership are ambiguous: partial insertion stops.
assert.equal(eraseBoxesForAiPartial(doc, buildEraseBoxes([token(0, 0.1)])).ok, false);
assert.equal(eraseBoxesForAiPartial({ paragraphs: [
  { id: "p0", aiText: "x", aiGroupParagraphIds: ["p0", "missing"] },
] }, owned).ok, false);

// Complete pages do not call the partial selector; adding ownership itself is non-destructive.
assert.equal(owned.boxes.length, 3);
assert.deepEqual(owned.boxes.map(({ p, ...geometry }) => geometry), [
  { l: 0.1, t: 0.1, w: 0.1, h: 0.05 },
  { l: 0.3, t: 0.1, w: 0.1, h: 0.05 },
  { l: 0.5, t: 0.1, w: 0.1, h: 0.05 },
]);

console.log("AI partial erase test passed: unanswered source pixels are preserved.");
