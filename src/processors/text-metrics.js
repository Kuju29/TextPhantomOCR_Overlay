/**
 *
 * Script detection and font fitting.
 *
 * A direct port of the pure-math half of `api/backend/render/tp_html.py`
 * (`_classify_text`, `_is_cjk_dominant`, `fit_item_font_size`, …) and
 * `render/text_utils.py` (`contains_rtl`).
 *
 * Pinned to `api/tests/fixtures/text_metrics.json`, which the Python side
 * generates and both sides assert. The failure this prevents is specific: the
 * server renders page 1 of a chapter and the extension renders page 2, and the
 * two pick different font sizes for identical bubbles. Nothing errors. The
 * chapter simply looks inconsistent, and the cause is invisible.
 */

// Average glyph width as a fraction of font size, per script.
const GLYPH_W_RATIO_CJK = 0.95;
const GLYPH_W_RATIO_THAI = 0.55;
const GLYPH_W_RATIO_LATIN = 0.55;

/** Below this, text is unreadable; a smaller "fit" is not a fit. */
export const MIN_FONT_PX = 9;

const CJK_RANGES = [
  [0x2e80, 0x2eff], [0x2f00, 0x2fdf], [0x3000, 0x303f], [0x3040, 0x309f],
  [0x30a0, 0x30ff], [0x3100, 0x312f], [0x3130, 0x318f], [0x3190, 0x319f],
  [0x31a0, 0x31bf], [0x31c0, 0x31ef], [0x31f0, 0x31ff], [0x3200, 0x32ff],
  [0x3300, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa48f],
  [0xac00, 0xd7af], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xffef],
  [0x20000, 0x2a6df], [0x2a700, 0x2b73f], [0x2b740, 0x2b81f], [0x2b820, 0x2ceaf],
];

const RTL_RANGES = [
  [0x0590, 0x05ff], [0x0600, 0x06ff], [0x0700, 0x074f], [0x0750, 0x077f],
  [0x0780, 0x07bf], [0x08a0, 0x08ff], [0xfb1d, 0xfdff], [0xfe70, 0xfeff],
];

function inRanges(codePoint, ranges) {
  for (const [lo, hi] of ranges) if (codePoint >= lo && codePoint <= hi) return true;
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

export function isCjkChar(ch) {
  if (!ch) return false;
  return inRanges(ch.codePointAt(0), CJK_RANGES);
}

export function containsRtl(text) {
  for (const cp of codePoints(text)) if (inRanges(cp, RTL_RANGES)) return true;
  return false;
}

/** Cheap script bucket used to pick a glyph-width ratio. */
export function classifyText(text) {
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

/**
 * Font size for one horizontal item, from its box and its text.
 *
 * Height is the hard ceiling — text taller than its line looks cramped. Width
 * is the soft one — the line shrinks to fit. Sizes are in whole pixels and
 * rounded the same way as Python's `round()`, which is banker's rounding: see
 * `roundHalfEven`. Using JS's `Math.round` here would disagree with the server
 * on every exact .5, and those land often because box sizes are quantised.
 */
// Closed-form size for an UPRIGHT CJK column in an axis-aligned box.
// Port of `fit_item_font_size_vertical` in api/backend/render/tp_html.py.
// A CJK glyph is about fs x fs, so n glyphs fit when n * fs^2 <= w * h.
// The horizontal fitter cannot be reused: it divides the box's WIDTH by the
// glyph count, and for a column the glyphs run down its HEIGHT.
export function fitColumnFontSizePx(boxWidthPx, boxHeightPx, text) {
  if (!(boxWidthPx > 0) || !(boxHeightPx > 0)) return MIN_FONT_PX;
  const n = visibleCharCount(text);
  if (n <= 0) {
    return Math.max(MIN_FONT_PX, roundHalfEven(Math.min(boxWidthPx, boxHeightPx) * 0.85));
  }
  const fsArea = Math.sqrt((boxWidthPx * boxHeightPx) / n) * 0.9;
  const fsColumnWidth = boxWidthPx * 0.95;
  const fsSingle = boxHeightPx * 0.95;
  return Math.max(MIN_FONT_PX, roundHalfEven(Math.min(fsArea, fsColumnWidth, fsSingle)));
}

// The same fit from a percentage box.
export function fitColumnFontSize(boxWidthPct, boxHeightPct, text, imgW, imgH) {
  const wPx = (Math.max(0, boxWidthPct) / 100) * Math.max(1, Math.trunc(imgW));
  const hPx = (Math.max(0, boxHeightPct) / 100) * Math.max(1, Math.trunc(imgH));
  return fitColumnFontSizePx(wPx, hPx, text);
}

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
export function fitParagraphFontSizeHorizontal(boxWidthPct, boxHeightPct, text, imgW, imgH) {
  const wPx = (Math.max(0, boxWidthPct) / 100) * Math.max(1, Math.trunc(imgW));
  const hPx = (Math.max(0, boxHeightPct) / 100) * Math.max(1, Math.trunc(imgH));
  if (!(wPx > 0) || !(hPx > 0)) return MIN_FONT_PX;
  const n = visibleCharCount(text);
  if (n <= 0) return Math.max(MIN_FONT_PX, roundHalfEven(Math.min(wPx, hPx) * 0.85));
  const ratio = glyphWidthRatio(text);
  const areaFit = Math.sqrt((wPx * hPx) / Math.max(1, n * ratio)) * 0.85;
  const oneLineCeiling = hPx * 0.8;
  return Math.max(MIN_FONT_PX, roundHalfEven(Math.min(areaFit, oneLineCeiling)));
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
 * One font size shared by every item in a paragraph.
 *
 * Each Lens item in a bubble has its own box, and per-item fitting picks a
 * different size for each — so one speech bubble ends up with a line at 18px
 * and the next at 32px purely because Lens measured the heights slightly
 * differently. Averaging keeps the bubble visually consistent; `overflow:
 * visible` lets glyphs spill a few px rather than reflow.
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

/**
 * Make neighbouring vertical translated boxes use the largest font in their
 * local text set.
 *
 * Records may carry an explicit group id (strong evidence).  Without one we
 * require close parallel columns, substantial vertical overlap and compatible
 * scale.  The component-wide scale guard prevents a 12→17→23px chain from
 * pulling a nearby title/sign into dialogue merely through transitivity.
 *
 * @param {Array<{id:string,fontPx:number,glyphPx:number,left:number,top:number,
 *   right:number,bottom:number,groupId?:string}>} records
 * @returns {Map<string, number>}
 */
export function harmonizeVerticalFontRecords(records) {
  const rows = (Array.isArray(records) ? records : []).filter((row) => (
    row && row.id && Number(row.fontPx) > 0 && Number(row.glyphPx) > 0 &&
    Number(row.right) > Number(row.left) && Number(row.bottom) > Number(row.top)
  ));
  const parent = rows.map((_row, index) => index);
  const minFont = rows.map((row) => Number(row.fontPx));
  const maxFont = [...minFont];
  const minGlyph = rows.map((row) => Number(row.glyphPx));
  const maxGlyph = [...minGlyph];
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const edges = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      const aGroup = String(a.groupId || "");
      const bGroup = String(b.groupId || "");
      if ((aGroup || bGroup) && aGroup !== bGroup) continue;

      const overlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const shorter = Math.max(1, Math.min(a.bottom - a.top, b.bottom - b.top));
      const horizontalGap = Math.max(a.left - b.right, b.left - a.right, 0);
      const glyph = Math.max(Number(a.glyphPx), Number(b.glyphPx), 1);
      const explicitGroup = Boolean(aGroup && aGroup === bGroup);
      if (overlap / shorter < (explicitGroup ? 0.25 : 0.4)) continue;
      if (horizontalGap > (explicitGroup ? 3.2 : 1.8) * glyph) continue;
      if (Math.max(a.fontPx, b.fontPx) / Math.min(a.fontPx, b.fontPx) > 1.55) continue;
      // Fitted translated text can make a huge title and normal dialogue both
      // land near 20px.  Source glyph scale is the independent evidence that
      // they are different typographic sets.
      if (Math.max(a.glyphPx, b.glyphPx) / Math.min(a.glyphPx, b.glyphPx) > 1.55) continue;
      edges.push([horizontalGap / glyph, i, j]);
    }
  }
  edges.sort((a, b) => a[0] - b[0]);
  for (const [, i, j] of edges) {
    const ri = find(i);
    const rj = find(j);
    if (ri === rj) continue;
    const nextMin = Math.min(minFont[ri], minFont[rj]);
    const nextMax = Math.max(maxFont[ri], maxFont[rj]);
    const nextMinGlyph = Math.min(minGlyph[ri], minGlyph[rj]);
    const nextMaxGlyph = Math.max(maxGlyph[ri], maxGlyph[rj]);
    if (nextMax / nextMin > 1.55) continue;
    if (nextMaxGlyph / nextMinGlyph > 1.55) continue;
    parent[rj] = ri;
    minFont[ri] = nextMin;
    maxFont[ri] = nextMax;
    minGlyph[ri] = nextMinGlyph;
    maxGlyph[ri] = nextMaxGlyph;
  }
  const out = new Map();
  rows.forEach((row, index) => out.set(String(row.id), maxFont[find(index)]));
  return out;
}
