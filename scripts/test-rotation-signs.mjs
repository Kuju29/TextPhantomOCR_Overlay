import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { translatedRotationSigns } from "../src/processors/render-overlay.js";

const item = (rotation, text = "字") => ({
  rotation, text, baseline: [[0.1, 0.1], [0.1, 0.3]], height: 0.02,
});
const para = (id, rotations) => ({
  id, lensText: "訳", lensItems: rotations.map((r) => item(r)), items: rotations.map((r) => item(r)),
});

// Separate explicit bubbles are independent: a page-wide vote must never
// turn a consistently -89 degree bubble because another bubble is +89.
{
  const doc = {
    paragraphs: [para("a", [89, 89]), para("b", [-89, -89])],
    groups: [
      { direction: "v", paragraphIds: ["a"] },
      { direction: "v", paragraphIds: ["b"] },
    ],
  };
  const before = structuredClone(doc);
  const result = translatedRotationSigns(doc);
  assert.equal(result.mixedGroups, 0);
  assert.equal(result.signs.size, 0);
  assert.deepEqual(doc, before, "presentation normalization must not mutate LensDocument");
}

// Mixed columns in one bubble use that bubble's majority; an ungrouped
// paragraph gets its own local vote rather than joining the page vote.
{
  const doc = {
    paragraphs: [para("a", [89, -89, 88]), para("free", [-88, 89, -87])],
    groups: [{ direction: "v", paragraphIds: ["a"] }],
  };
  const result = translatedRotationSigns(doc);
  assert.equal(result.mixedGroups, 2);
  assert.equal(result.signs.get("a"), 1);
  assert.equal(result.signs.get("free"), -1);
}

// Horizontal/decorative groups and sub-78-degree art angles retain their
// direction even when embedded in a group classified vertical.
{
  let result = translatedRotationSigns({
    paragraphs: [para("tilt", [60, -60])],
    groups: [{ direction: "h", paragraphIds: ["tilt"] }],
  });
  assert.equal(result.signs.size, 0);
  result = translatedRotationSigns({
    paragraphs: [para("tilt", [60, -60])],
    groups: [{ direction: "v", paragraphIds: ["tilt"] }],
  });
  assert.equal(result.signs.size, 0, "free-angle +/-60 must not vote as near-vertical");
}

const source = await readFile(new URL("../src/processors/render-overlay.js", import.meta.url), "utf8");
assert.match(source, /relayoutTranslated === false[\s\S]*translatedRotationSigns/,
  "Rotate Translated OFF must use local sign normalization");
assert.match(source, /relayoutTranslated === true[\s\S]*relayoutBlocks/,
  "Rotate Translated ON must keep the upright relayout path");

console.log("Rotation-sign tests passed: explicit groups stay independent; mixed and ungrouped votes are local.");
