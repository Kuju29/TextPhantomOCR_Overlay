import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { authoritativeLensImageSize } from "../src/shared/lens-decode.js";

assert.deepEqual(
  authoritativeLensImageSize({ width: 1200, height: 1800 }),
  { width: 1200, height: 1800 },
);
assert.throws(
  () => authoritativeLensImageSize({ width: 0, height: 1800 }),
  /invalid authoritative/,
);

const lensDirect = await readFile(
  new URL("../src/background/pipeline/lens-direct.js", import.meta.url),
  "utf8",
);
assert.match(lensDirect, /rawToDocument:\s*decoded\.groupingRawToDocument/);
assert.match(lensDirect, /attachCanonicalOriginalTree\(document, grouped\?\.tree\)/);
assert.match(lensDirect, /sourceTreeFingerprint/);
assert.match(lensDirect, /trace\(\s*["']groupingStage["']/);
assert.match(lensDirect, /trace\(\s*["']groupingAttached["']/);
assert.doesNotMatch(
  lensDirect,
  /remapRawBubbleGroups|decideVerticalMerge|verticalVerdict|onnxGrouping/,
);

const imageFlow = await readFile(
  new URL("../api/backend/jobs/stages/image_flow.py", import.meta.url),
  "utf8",
);
assert.match(imageFlow, /group_vertical_lens\(original_tree/);
assert.match(imageFlow, /project_grouping_result/);
assert.match(imageFlow, /raw partition parity mismatch/);
assert.doesNotMatch(
  imageFlow,
  /group_stage|textblocks|group_paragraphs_into_bubbles|_tb_block/,
);

console.log(
  "Vertical contract test passed: both engines use the canonical Lens graph partition.",
);
