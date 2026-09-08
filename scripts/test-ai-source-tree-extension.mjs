import assert from "node:assert/strict";
import {
  attachCanonicalOriginalTree,
  translationUnits,
} from "../src/shared/lens-document.js";

const doc = {
  schema: "tp.lens-document/1",
  image: { width: 100, height: 100 },
  paragraphs: [
    { id: "p0", sourceText: "右", items: [] },
    { id: "p1", sourceText: "左", items: [] },
  ],
};
const canonicalOriginalTree = {
  schema: "tp.canonical-original-tree/1",
  coverage: { complete: true },
  paragraphs: [{
    id: "as_pair",
    text: "右左",
    items: [],
    source: {
      contract: "tp.ai-source-members/1",
      rawParagraphIndices: [0, 1],
      documentParagraphIds: ["p0", "p1"],
    },
  }],
};

const attached = attachCanonicalOriginalTree(doc, canonicalOriginalTree);
assert.deepEqual(translationUnits(attached), [{
  id: "g0",
  sourceId: "as_pair",
  text: "右左",
  paragraphIds: ["p0", "p1"],
  translatable: true,
}]);
assert.throws(
  () => attachCanonicalOriginalTree(doc, { ...canonicalOriginalTree, coverage: { complete: false } }),
  /complete tp\.canonical-original-tree\/1/,
);
console.log("AI source tree Extension contract passed: one canonical paragraph, original geometry ownership preserved.");
