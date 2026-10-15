/**
 * Script detection and font fitting: a port of the pure-math half of
 * `api/backend/render/tp_html.py` (`_classify_text`, `_is_cjk_dominant`,
 * `fit_item_font_size`, …) and `render/text_utils.py` (`contains_rtl`), pinned to
 * `api/tests/fixtures/text_metrics.json` so server- and extension-rendered pages
 * of one chapter pick the same font sizes.
 */

// Average glyph width as a fraction of font size, per script.
const GLYPH_W_RATIO_CJK = 0.95;
const GLYPH_W_RATIO_THAI = 0.55;
const GLYPH_W_RATIO_LATIN = 0.55;

/** Below this, text is unreadable; a smaller "fit" is not a fit. */
export const MIN_FONT_PX = 9;

const CJK_RANGES = [
  [0x2e80, 0x2eff],
  [0x2f00, 0x2fdf],
  [0x3000, 0x303f],
  [0x3040, 0x309f],
  [0x30a0, 0x30ff],
  [0x3100, 0x312f],
  [0x3130, 0x318f],
  [0x3190, 0x319f],
  [0x31a0, 0x31bf],
  [0x31c0, 0x31ef],
  [0x31f0, 0x31ff],
  [0x3200, 0x32ff],
  [0x3300, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa48f],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xffef],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f],
  [0x2b820, 0x2ceaf],
];

const RTL_RANGES = [
  [0x0590, 0x05ff],
  [0x0600, 0x06ff],
  [0x0700, 0x074f],
  [0x0750, 0x077f],
  [0x0780, 0x07bf],
  [0x08a0, 0x08ff],
  [0xfb1d, 0xfdff],
  [0xfe70, 0xfeff],
];

function inRanges(codePoint, ranges) {
  for (const [lo, hi] of ranges)
    if (codePoint >= lo && codePoint <= hi) return true;
  return false;
}

/**
 * Iterate CODE POINTS, not UTF-16 units.
 *
 * CJK Extension B lives above U+FFFF. Iterating `text[i]` would see two
 * surrogate halves, neither of which is in any range, and a page of rare kanji
 * would be classified as Latin and typeset at the wrong width.
 */
function* codePoints(text) {
  for (const ch of String(text || "")) yield ch.codePointAt(0);
}

function isCjkChar(ch) {
  if (!ch) return false;
  return inRanges(ch.codePointAt(0), CJK_RANGES);
}

export function containsRtl(text) {
  for (const cp of codePoints(text)) if (inRanges(cp, RTL_RANGES)) return true;
  return false;
}

/** Cheap script bucket used to pick a glyph-width ratio. */
function classifyText(text) {
  if (!text) return "latin";
  let cjk = 0;
  let thai = 0;
  let other = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (inRanges(cp, CJK_RANGES)) cjk++;
    else if (cp >= 0x0e00 && cp <= 0x0e7f) thai++;
    else if (/[\p{L}\p{N}]/u.test(ch)) other++;
  }
  if (cjk && cjk >= Math.max(thai, other)) return "cjk";
  if (thai && thai >= other) return "thai";
  return "latin";
}

/** True when enough of the visible text is CJK to typeset it vertically. */
export function isCjkDominant(text, threshold = 0.45) {
  if (!text) return false;
  let visible = 0;
  let cjk = 0;
  for (const ch of String(text)) {
    if (/\s/u.test(ch)) continue;
    visible++;
    if (isCjkChar(ch)) cjk++;
  }
  return visible > 0 && cjk / visible >= threshold;
}

export function glyphWidthRatio(text) {
  const kind = classifyText(text);
  if (kind === "cjk") return GLYPH_W_RATIO_CJK;
  if (kind === "thai") return GLYPH_W_RATIO_THAI;
  return GLYPH_W_RATIO_LATIN;
}

/** Length excluding whitespace — what a width fit actually pays for. */
export function visibleCharCount(text) {
  if (!text) return 0;
  let n = 0;
  for (const ch of String(text)) if (!/\s/u.test(ch)) n++;
  return n;
}

// Closed-form size for an UPRIGHT CJK column in an axis-aligned box.
// Port of `fit_item_font_size_vertical` in api/backend/render/tp_html.py.
// A CJK glyph is about fs x fs, so n glyphs fit when n * fs^2 <= w * h.
// The horizontal fitter cannot be reused: it divides the box's WIDTH by the
// glyph count, and for a column the glyphs run down its HEIGHT.
export function fitColumnFontSizePx(boxWidthPx, boxHeightPx, text) {
  if (!(boxWidthPx > 0) || !(boxHeightPx > 0)) return MIN_FONT_PX;
  const n = visibleCharCount(text);
  if (n <= 0) {
    return Math.max(
      MIN_FONT_PX,
      roundHalfEven(Math.min(boxWidthPx, boxHeightPx) * 0.85),
    );
  }
  const fsArea = Math.sqrt((boxWidthPx * boxHeightPx) / n) * 0.9;
  const fsColumnWidth = boxWidthPx * 0.95;
  const fsSingle = boxHeightPx * 0.95;
  return Math.max(
    MIN_FONT_PX,
    roundHalfEven(Math.min(fsArea, fsColumnWidth, fsSingle)),
  );
}

// The same fit from a percentage box.
export function fitColumnFontSize(boxWidthPct, boxHeightPct, text, imgW, imgH) {
  const wPx = (Math.max(0, boxWidthPct) / 100) * Math.max(1, Math.trunc(imgW));
  const hPx = (Math.max(0, boxHeightPct) / 100) * Math.max(1, Math.trunc(imgH));
  return fitColumnFontSizePx(wPx, hPx, text);
}

/**
 * Font size for one horizontal item. Height is the hard ceiling, width the soft
 * one. Whole pixels rounded half-to-even like Python's `round()`
 * (`roundHalfEven`): `Math.round` would disagree with the server on every
 * exact .5, which box quantisation makes common.
 */
export function fitItemFontSize(boxWidthPct, boxHeightPct, text, imgW, imgH) {
  const wPx = (Math.max(0, boxWidthPct) / 100) * Math.max(1, Math.trunc(imgW));
  const hPx = (Math.max(0, boxHeightPct) / 100) * Math.max(1, Math.trunc(imgH));
  if (hPx <= 0) return MIN_FONT_PX;

  const fsHeight = hPx * 0.85;
  const n = visibleCharCount(text);
  if (n <= 0) return Math.max(MIN_FONT_PX, roundHalfEven(fsHeight));

  const ratio = glyphWidthRatio(text);
  const fsWidth = wPx / Math.max(1, (n + 0.5) * ratio);
  return Math.max(MIN_FONT_PX, roundHalfEven(Math.min(fsHeight, fsWidth)));
}

/** Font size for text that is allowed to wrap across a paragraph box. */
export function fitParagraphFontSizeHorizontal(
  boxWidthPct,
  boxHeightPct,
  text,
  imgW,
  imgH,
) {
  const wPx = (Math.max(0, boxWidthPct) / 100) * Math.max(1, Math.trunc(imgW));
  const hPx = (Math.max(0, boxHeightPct) / 100) * Math.max(1, Math.trunc(imgH));
  if (!(wPx > 0) || !(hPx > 0)) return MIN_FONT_PX;
  const n = visibleCharCount(text);
  if (n <= 0)
    return Math.max(MIN_FONT_PX, roundHalfEven(Math.min(wPx, hPx) * 0.85));
  const ratio = glyphWidthRatio(text);
  const areaFit = Math.sqrt((wPx * hPx) / Math.max(1, n * ratio)) * 0.85;
  const oneLineCeiling = hPx * 0.8;
  return Math.max(
    MIN_FONT_PX,
    roundHalfEven(Math.min(areaFit, oneLineCeiling)),
  );
}

/**
 * Python's `round()` — half to even.
 *
 * `Math.round(0.5)` is 1 and `Math.round(-0.5)` is 0; Python gives 0 and -0.
 * The difference is one pixel, on the values that occur most often.
 */
export function roundHalfEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * One font size shared by every item in a paragraph: per-item fitting gives
 * lines of one bubble different sizes purely from Lens height noise.
 * `overflow: visible` lets glyphs spill a few px rather than reflow.
 */
export function sharedParagraphFontSize(items, imgW, imgH) {
  const sizes = [];
  for (const item of items || []) {
    const text = String(item?.text || "").trim();
    if (!text) continue;
    sizes.push(
      item?.upright === true
        ? fitColumnFontSize(item.widthPct, item.heightPct, text, imgW, imgH)
        : fitItemFontSize(item.widthPct, item.heightPct, text, imgW, imgH),
    );
  }
  if (!sizes.length) return null;
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  return Math.max(MIN_FONT_PX, roundHalfEven(avg));
}

