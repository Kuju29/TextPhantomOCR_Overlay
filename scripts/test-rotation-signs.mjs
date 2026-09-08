import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { translatedRotationSigns } from "../src/processors/render/renderer.js";
import { classifyItemAxis, pageNeedsGroups, paragraphReadingAxis } from "../src/shared/lens-axis.js";
import { aiLayoutDecision } from "../src/shared/lens-axis.js";
import { attachCanonicalOriginalTree } from "../src/shared/lens-document.js";

const item = (rotation, x = .1, text = "訳") => ({
  rotation, text, baseline: [[x, 0.1], [x, 0.3]], height: 0.02,
});
const para = (id, rotations, x) => ({
  id, lensText: "訳", lensItems: rotations.map((r,i) => item(r,x-i*.04)), items: [],
});
// Target geometry groups are independent of old source groups. OFF always
// turns near-vertical translated lines left, even a uniformly positive group.
{
  const doc = {image:{width:1000,height:1000},
    paragraphs: [para("a", [89, 89], .8), para("b", [-89, -89], .2)],
    groups: [{direction:"v",paragraphIds:["a","b"]}],
  };
  const before=structuredClone(doc),result=translatedRotationSigns(doc);
  assert.equal(result.mixedGroups,0);assert.equal(result.signs.get("a"),-1);
  assert.equal(result.signs.get("b"),-1);assert.deepEqual(doc,before);
}
{
  const doc={image:{width:1000,height:1000},
    paragraphs:[para("a",[89,-89,88],.8),para("free",[-88,89,-87],.2)],
    groups:[]};
  const result=translatedRotationSigns(doc);
  assert.equal(result.mixedGroups,2);
  assert.equal(result.signs.get("a"),-1);assert.equal(result.signs.get("free"),-1);
}
for(const direction of ["h","v"]) {
  const result=translatedRotationSigns({image:{width:1000,height:1000},
    paragraphs:[para("tilt",[60,-60],.5)],groups:[{direction,paragraphIds:["tilt"]}]});
  assert.equal(result.signs.size,0,"decorative +/-60 angles do not become vertical because of Original groups");
}

const source = await readFile(new URL("../src/processors/render/renderer.js", import.meta.url), "utf8");
assert.match(source, /relayoutTranslated === false[\s\S]*translatedRotationSigns/,
  "Rotate Translated OFF must use local sign normalization");
assert.match(source, /relayoutTranslated === true[\s\S]*relayoutBlocks/,
  "Rotate Translated ON must keep the upright relayout path");

const lensItem = (text, left, top, width, height, rotation = 0) => ({
  text,
  box: { left, top, width, height, rotation_deg: rotation },
});

// Lens can report an upright Japanese column with rotation=0. Portrait CJK
// geometry must open the grouping gate, including a realistic 22-column page.
{
  const paragraphs = Array.from({ length: 22 }, (_, index) => ({
    items: [lensItem("彼女は今日も冒険する。", 0.92 - index * 0.035, 0.12, 0.022, 0.22)],
  }));
  const verdict = pageNeedsGroups({ paragraphs });
  assert.equal(verdict.needed, true);
  assert.deepEqual(verdict.votes, { h: 0, v: 22 });
}

// A paragraph split into short pieces still votes vertical when their finite
// union is a portrait CJK column.
{
  const items = [
    lensItem("今日", 0.5, 0.1, 0.03, 0.04),
    lensItem("冒険", 0.5, 0.16, 0.03, 0.04),
    lensItem("する", 0.5, 0.22, 0.03, 0.04),
  ];
  assert.equal(paragraphReadingAxis(items), "v");
}

// Geometry must not turn narrow Latin labels, ordinary horizontal Japanese,
// or explicit decorative angles into vertical grouping evidence.
assert.equal(classifyItemAxis(lensItem("CHAPTER", 0.9, 0.1, 0.02, 0.2)), "h");
assert.equal(classifyItemAxis(lensItem("境界", 0.1, 0.1, 0.1, 0.22)), "v",
  "an exact 100x220 portrait boundary must survive floating-point representation");
assert.equal(classifyItemAxis(lensItem("境界", 0.1, 0.1, 0.1, 0.219)), "h",
  "geometry below the 2.2 portrait boundary must remain horizontal");
assert.equal(classifyItemAxis(lensItem("章", 0.9, 0.1, 0.02, 0.2)), "h",
  "one tall CJK glyph is a local label, not enough evidence to request grouping");
assert.equal(pageNeedsGroups({ paragraphs: [{ items: [lensItem("章", 0.9, 0.1, 0.02, 0.2)] }] }).needed, false,
  "a one-glyph page must not request grouping");
assert.equal(classifyItemAxis(lensItem("横書きです", 0.1, 0.1, 0.3, 0.04)), "h");
assert.equal(classifyItemAxis(lensItem("装飾", 0.1, 0.1, 0.02, 0.2, 30)), "tilted");

// JS and Python share the same inclusive CJK range union. Probe every added
// range (including its upper boundary) and the supplementary plane. Samples
// must contain Unicode letters because punctuation alone is not column text.
for (const [name, codePoints] of [
  ["kana", [0x3041, 0x30fa]],
  ["bopomofo", [0x3105, 0x312f]],
  ["katakana extensions", [0x31f0, 0x31ff]],
  ["CJK extension/han", [0x3400, 0x9fff]],
  ["hangul", [0xac00, 0xd7a3]],
  ["compatibility ideographs", [0xf900, 0xfa2d]],
  ["halfwidth katakana", [0xff66, 0xff9d]],
  ["supplementary ideographs", [0x20000, 0x2a6df]],
]) {
  const text = codePoints.map((cp) => String.fromCodePoint(cp)).join("");
  assert.equal(classifyItemAxis(lensItem(text, 0.1, 0.1, 0.02, 0.2)), "v", `${name} must match the CJK gate`);
}
assert.equal(classifyItemAxis(lensItem("。、", 0.1, 0.1, 0.02, 0.2)), "h",
  "CJK punctuation alone is not meaningful column evidence");
assert.equal(classifyItemAxis(lensItem("日本。。。。", 0.1, 0.1, 0.02, 0.2)), "v",
  "CJK punctuation supports dominance once two meaningful CJK letters exist");

// End-to-end decision boundary: portrait CJK requests Lens graph grouping,
// then the explicit vertical group remains authoritative after conversion
// to LensDocument (whose member rotation may still be the ambiguous zero).
{
  const rawParagraphs = Array.from({ length: 3 }, (_, index) => ({
    items: [lensItem("縦書き", 0.8 - index * 0.04, 0.1, 0.02, 0.2)],
  }));
  assert.equal(pageNeedsGroups({ paragraphs: rawParagraphs }).needed, true);
  const document = {
    schema: "tp.lens-document/1",
    image: { width: 1000, height: 1400 },
    paragraphs: rawParagraphs.map((para, index) => ({
      id: `p${index}`,
      sourceText: para.items[0].text,
      items: [{ id: `p${index}-i0`, text: para.items[0].text, rotation: 0,
        baseline: [[0.8 - index * 0.04, 0.1], [0.8 - index * 0.04, 0.3]], height: 0.02 }],
    })),
  };
  const grouped = attachCanonicalOriginalTree(document, {
    schema: "tp.canonical-original-tree/1",
    coverage: { complete: true },
    paragraphs: [{
      id: "as_vertical",
      text: "縦書き縦書き縦書き",
      direction: "v",
      source: {
        contract: "tp.ai-source-members/1",
        rawParagraphIndices: [0, 1, 2],
        documentParagraphIds: ["p0", "p1", "p2"],
      },
    }],
  });
  const decision = aiLayoutDecision(grouped, "th");
  assert.equal(decision.sourceOrientation, "v");
  assert.equal(decision.targetOrientation, "h");
  assert.equal(decision.requiresRelayout, true);
  assert.deepEqual({ h: decision.horizontalItems, v: decision.verticalItems }, { h: 0, v: 3 });
}

console.log("Rotation/axis tests passed: explicit groups stay independent and portrait CJK requests grouping safely.");
