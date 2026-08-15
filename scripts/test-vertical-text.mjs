// The vertical-column font fitter, run for real.
//
// The bug this guards: a vertical CJK column was measured with the HORIZONTAL
// fitter, which divides the box's narrow side by the glyph count. Every column
// collapsed to the 9 px floor. The numbers below are the shared contract with
// `fit_item_font_size_vertical` in api/backend/render/tp_html.py - the same
// table is asserted in api/tests/test_font_parity.py, so if either side drifts
// one of the two fails.
import assert from "node:assert/strict";
import {
  MIN_FONT_PX,
  fitColumnFontSize,
  fitColumnFontSizePx,
  fitItemFontSize,
  visibleCharCount,
} from "../src/processors/text-metrics.js";

// [boxWidthPx, boxHeightPx, text, expectedFontPx]
const TABLE = [
  [30, 300, "あいうえおかきくけ", 28],
  [24, 120, "テスト", 23],
  [40, 40, "あ", 36],
  [0, 100, "あ", MIN_FONT_PX], // a box with no width cannot be fitted
  [60, 600, "あ".repeat(30), 31],
  [18, 90, "日本語", 17],
];

for (const [w, h, text, expected] of TABLE) {
  assert.equal(
    fitColumnFontSizePx(w, h, text),
    expected,
    `fitColumnFontSizePx(${w}, ${h}, ${JSON.stringify(text)}) must match the Python renderer`,
  );
}

// --- the regression itself ---------------------------------------------------
{
  const [w, h, text] = [30, 300, "あいうえおかきくけ"];
  const column = fitColumnFontSizePx(w, h, text);
  const horizontal = fitItemFontSize(100, 100, text, w, h); // the fitter used before
  assert.equal(horizontal, MIN_FONT_PX, "the horizontal fitter still collapses a column");
  assert.ok(
    column > horizontal * 2,
    `a column must be readable: got ${column}px from the column fitter vs ${horizontal}px ` +
    "from the horizontal one",
  );
}

// --- the percentage wrapper agrees with the pixel one ------------------------
{
  const imgW = 1200;
  const imgH = 1800;
  const wPct = (30 / imgW) * 100;
  const hPct = (300 / imgH) * 100;
  assert.equal(
    fitColumnFontSize(wPct, hPct, "あいうえおかきくけ", imgW, imgH),
    fitColumnFontSizePx(30, 300, "あいうえおかきくけ"),
    "the percentage wrapper must resolve to the same pixels",
  );
}

// --- properties that must hold for any box -----------------------------------
{
  assert.equal(visibleCharCount("  あ い  "), 2, "spaces are not glyphs");
  for (const text of ["あ", "あいう", "日本語のテキスト"]) {
    let previous = 0;
    for (const scale of [1, 2, 4, 8]) {
      const size = fitColumnFontSizePx(20 * scale, 200 * scale, text);
      assert.ok(size >= previous, "a bigger box must never produce a smaller font");
      assert.ok(size >= MIN_FONT_PX, "the floor always holds");
      previous = size;
    }
  }
}

// --- the renderer must actually reach for this fitter ------------------------
// A source check, not a behaviour check: makeLine needs a DOM. Named as such so
// nobody reads this line as proof that the overlay draws correctly.
{
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const overlay = await readFile(path.join(root, "src/processors/render-overlay.js"), "utf8");
  assert.match(
    overlay,
    /upright:\s*true/,
    "verticalOriginalGeometries must stamp `upright` on the geometry",
  );
  assert.match(
    overlay,
    /geometry\.upright === true \? fitColumnFontSize : fitItemFontSize/,
    "the per-item fit must switch on `upright`",
  );
  assert.match(
    overlay,
    /geometry\.upright === true \|\|/,
    "makeLine must treat an upright geometry as a vertical line",
  );
}

console.log(
  `Vertical text test passed: ${TABLE.length} sizes match the Python renderer, ` +
  "the column fitter beats the horizontal one, the renderer is wired to it.",
);
