/**
 *
 * Local overlay renderer: LensDocument → DOM.
 *
 * This is the box the whole plan waits on. While the server owns rendering,
 * "translate in the browser" still has to send everything back to the server
 * to be drawn — so Lens Direct and BYOK-direct save nothing. With this, the
 * text path can run end to end in the page.
 *
 * It builds DOM NODES, not an HTML string. The server path returns markup that
 * `overlay.js` must parse and sanitise before inserting; here no HTML string
 * ever exists, so there is nothing to sanitise and nothing that could be
 * mis-sanitised. Text goes in through `textContent`.
 *
 * Geometry
 * --------
 * A LensDocument item is a baseline plus a height. Lens measures the baseline
 * midpoint as the box CENTRE (not the type baseline), which is what
 * `lens/tree.py` assumes when it derives `item_box`, so:
 *
 *     width  = |p2 - p1|
 *     height = item.height
 *     centre = midpoint(p1, p2)
 *     rotate = item.rotation, about that centre
 *
 * Deriving it here rather than shipping a second copy of the box is the point
 * of the document being small: one description of where the text is.
 */

import {
  MIN_FONT_PX,
  containsRtl,
  fitColumnFontSize,
  fitItemFontSize,
  fitParagraphFontSizeHorizontal,
  isCjkDominant,
  roundHalfEven,
  sharedParagraphFontSize,
} from "./text-metrics.js";
// `canRenderFaithfully` lives in the schema module, not here: the service
// worker asks it too (before committing to the Lens-Direct route, which has no
// server markup to fall back on) and the service worker has no DOM.
import { canRenderFaithfully, itemsForSource, textForSource } from "../shared/lens-document.js";
import { collapseThaiWordGaps, normalizeAiUnitText } from "../shared/ai-markers.js";

export { canRenderFaithfully };

/** Above this tilt a run is a real vertical column, not a slanted label. */
const VERTICAL_TILT_DEG = 78;

/**
 * Class names this renderer can emit.
 *
 * Exported so a test can assert every one of them is actually styled: a class
 * the stylesheet does not know about produces unstyled text at position 0,0,
 * which reads as "the overlay is broken" rather than "a rule is missing".
 */
export const OVERLAY_CLASSES = [
  "tp-line", "vert", "bubble", "rtl", "tp-on-dark", "tp-src", "notranslate", "tp-gtext",
];

/**
 * The stylesheet. Mirrors `overlay_css()` in `api/backend/render/tp_html.py`.
 *
 * Kept as one string rather than assembled from parts so it can be diffed
 * against the server's copy by eye when either changes.
 */
export const OVERLAY_CSS = [
  ".tp-draw-root{position:absolute;inset:0;pointer-events:none;}",
  ".tp-draw-scope{position:absolute;inset:0;width:100%;height:100%;transform-origin:0 0;}",
  ".tp-src{display:contents;}",
  ".tp-src.notranslate{display:contents;}",
  ".tp-gtext{opacity:0;}",
  "html.translated-ltr .tp-src,html.translated-rtl .tp-src{visibility:hidden;}",
  "html.translated-ltr .tp-gtext,html.translated-rtl .tp-gtext{opacity:1;}",
  ".tp-line{",
  "position:absolute;display:flex;align-items:center;justify-content:center;",
  "white-space:nowrap;overflow:visible;box-sizing:border-box;",
  "transform-origin:center center;pointer-events:none;user-select:none;padding:0 .15em;",
  'font-family:"Noto Sans CJK JP","Noto Sans CJK SC","Noto Sans CJK TC","Noto Sans CJK KR",',
  '"Noto Sans JP","Noto Sans SC","Noto Sans TC","Noto Sans KR",',
  '"Noto Sans Thai","Noto Sans Thai UI","Noto Sans Arabic","Noto Sans Hebrew",',
  '"Noto Sans Devanagari","Noto Sans Bengali","Noto Sans Tamil","Noto Sans Telugu",',
  '"Noto Sans Khmer","Noto Sans Lao","Noto Sans Myanmar","Noto Sans Georgian",',
  '"Noto Sans Armenian","Noto Sans Ethiopic","Noto Sans",',
  '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Microsoft YaHei",',
  '"Microsoft JhengHei","Malgun Gothic","Apple SD Gothic Neo","PingFang SC","PingFang TC",',
  'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;',
  "font-weight:600;font-style:normal;letter-spacing:0;",
  "color:var(--tp-ink,rgba(15,15,15,.98));",
  "text-shadow:var(--tp-halo,0 0 2px rgba(255,255,255,.95),0 0 2px rgba(255,255,255,.95),",
  "0 0 3px rgba(255,255,255,.85),0 1px 1px rgba(0,0,0,.35));",
  "text-rendering:geometricPrecision;}",
  ".tp-on-dark{--tp-ink:rgba(248,248,248,.98);",
  "--tp-halo:0 0 2px rgba(0,0,0,.95),0 0 2px rgba(0,0,0,.95),",
  "0 0 3px rgba(0,0,0,.85),0 1px 1px rgba(255,255,255,.25);}",
  ".tp-line.vert{writing-mode:vertical-rl;text-orientation:upright;",
  "white-space:normal;padding:.15em 0;letter-spacing:0;}",
  ".tp-line.bubble{white-space:normal;word-break:break-word;overflow-wrap:anywhere;",
  "text-align:center;padding:.2em .1em;}",
  ".tp-line.rtl{direction:rtl;unicode-bidi:isolate;}",
].join("");

/**
 * Item box in image-pixel space, which is where lengths are comparable.
 *
 * The baseline is stored normalised against width for x and height for y. On a
 * non-square page those are different units, so a diagonal baseline's length
 * cannot be measured in normalised space — it has to go through pixels first.
 * Getting this wrong stretches every rotated box by the page's aspect ratio,
 * which looks like a font-size bug and is not one.
 */
export function itemGeometry(item, imgW, imgH) {
  const [[x1n, y1n], [x2n, y2n]] = item.baseline;
  const x1 = x1n * imgW;
  const y1 = y1n * imgH;
  const x2 = x2n * imgW;
  const y2 = y2n * imgH;

  const lengthPx = Math.hypot(x2 - x1, y2 - y1);
  const heightPx = item.height * imgH;
  if (!(lengthPx > 0) || !(heightPx > 0)) return null;

  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  return {
    widthPct: (lengthPx / imgW) * 100,
    heightPct: (heightPx / imgH) * 100,
    leftPct: ((cx - lengthPx / 2) / imgW) * 100,
    topPct: ((cy - heightPx / 2) / imgH) * 100,
    rotation: Number(item.rotation) || 0,
    text: String(item.text || ""),
  };
}

/** Axis-aligned box occupied by a rotated baseline rectangle. */
export function rotatedItemAabbGeometry(item, imgW, imgH) {
  const geometry = itemGeometry(item, imgW, imgH);
  if (!geometry) return null;
  const widthPx = (geometry.widthPct / 100) * imgW;
  const heightPx = (geometry.heightPct / 100) * imgH;
  const cx = ((geometry.leftPct + geometry.widthPct / 2) / 100) * imgW;
  const cy = ((geometry.topPct + geometry.heightPct / 2) / 100) * imgH;
  const rad = ((Number(geometry.rotation) || 0) * Math.PI) / 180;
  const aabbW = Math.abs(widthPx * Math.cos(rad)) + Math.abs(heightPx * Math.sin(rad));
  const aabbH = Math.abs(widthPx * Math.sin(rad)) + Math.abs(heightPx * Math.cos(rad));
  return {
    leftPct: ((cx - aabbW / 2) / imgW) * 100,
    topPct: ((cy - aabbH / 2) / imgH) * 100,
    widthPct: (aabbW / imgW) * 100,
    heightPct: (aabbH / imgH) * 100,
    rotation: 0,
    text: geometry.text,
  };
}

function unionGeometry(geometries) {
  if (!geometries.length) return null;
  const left = Math.min(...geometries.map((g) => g.leftPct));
  const top = Math.min(...geometries.map((g) => g.topPct));
  const right = Math.max(...geometries.map((g) => g.leftPct + g.widthPct));
  const bottom = Math.max(...geometries.map((g) => g.topPct + g.heightPct));
  return { leftPct: left, topPct: top, widthPct: right - left, heightPct: bottom - top, rotation: 0, text: "" };
}

function geometryFromPixelBounds(bounds, imgW, imgH) {
  if (
    !Array.isArray(bounds) || bounds.length !== 4 ||
    !bounds.every((value) => Number.isFinite(Number(value))) ||
    !(imgW > 0) || !(imgH > 0)
  ) return null;
  const left = Math.max(0, Math.min(imgW, Number(bounds[0])));
  const top = Math.max(0, Math.min(imgH, Number(bounds[1])));
  const right = Math.max(0, Math.min(imgW, Number(bounds[2])));
  const bottom = Math.max(0, Math.min(imgH, Number(bounds[3])));
  if (!(right > left) || !(bottom > top)) return null;
  return {
    leftPct: (left / imgW) * 100,
    topPct: (top / imgH) * 100,
    widthPct: ((right - left) / imgW) * 100,
    heightPct: ((bottom - top) / imgH) * 100,
    rotation: 0,
    text: "",
  };
}

function targetTextDirection(language) {
  const primary = String(language || "").trim().toLowerCase().replaceAll("_", "-").split("-", 1)[0];
  return primary === "ja" || primary === "zh" ? "v" : "h";
}

function itemsReadVertically(items) {
  const textItems = (items || []).filter((item) => String(item?.text || "").trim());
  if (!textItems.length) return false;
  return textItems.filter(
    (item) => Math.abs(Number(item?.rotation) || 0) > VERTICAL_TILT_DEG,
  ).length * 2 >= textItems.length;
}

function layoutTokens(text, language, vertical) {
  // The legacy API removed provider-inserted Thai word gaps while laying text
  // out, not while parsing/storing the answer. Do the same locally. Never use
  // one global separator for every Intl.Segmenter token: a single legitimate
  // gap in `AI รุ่น 2` would then reinsert spaces between *all* Thai words.
  const value = collapseThaiWordGaps(normalizeAiUnitText(text));
  if (!value) return [];
  if (vertical) {
    return Array.from(value)
      .filter((ch) => !/\s/u.test(ch))
      .map((text) => ({ text, spaceBefore: false }));
  }
  try {
    const tokens = [];
    let pendingSpace = false;
    for (const part of new Intl.Segmenter(language || undefined, { granularity: "word" }).segment(value)) {
      const raw = String(part.segment || "");
      if (!raw) continue;
      if (/^\s+$/u.test(raw)) {
        pendingSpace = true;
        continue;
      }
      const piece = raw.trim();
      if (!piece) continue;
      // Glue punctuation to the preceding token when there was no real space;
      // this prevents punctuation from starting a newly distributed row.
      if (!part.isWordLike && !pendingSpace && tokens.length) {
        tokens[tokens.length - 1].text += piece;
      } else {
        tokens.push({ text: piece, spaceBefore: pendingSpace });
      }
      pendingSpace = false;
    }
    if (tokens.length) return tokens;
  } catch {
    // Firefox/Thunderbird builds without Intl.Segmenter use the deterministic
    // whitespace/code-point fallback below.
  }
  const tokens = [];
  let pendingSpace = false;
  for (const part of value.split(/(\s+)/u)) {
    if (!part) continue;
    if (/^\s+$/u.test(part)) {
      pendingSpace = true;
      continue;
    }
    for (const char of Array.from(part)) {
      tokens.push({ text: char, spaceBefore: pendingSpace });
      pendingSpace = false;
    }
  }
  return tokens;
}

function distributeTokens(text, language, vertical, lineCount) {
  const tokens = layoutTokens(text, language, vertical);
  if (!tokens.length) return [];
  const count = Math.max(1, Math.min(Number(lineCount) || 1, tokens.length));
  const weights = tokens.map((token) => Math.max(1, Array.from(token.text).length));
  const remainingWeight = () => weights.slice(cursor).reduce((sum, value) => sum + value, 0);
  const lines = [];
  let cursor = 0;
  for (let line = 0; line < count; line++) {
    const slotsLeft = count - line;
    const target = remainingWeight() / slotsLeft;
    const picked = [];
    let used = 0;
    while (cursor < tokens.length) {
      const tokensAfter = tokens.length - (cursor + 1);
      const mustLeave = slotsLeft - 1;
      if (picked.length && used >= target && tokensAfter >= mustLeave) break;
      picked.push(tokens[cursor]);
      used += weights[cursor];
      cursor += 1;
      if (tokens.length - cursor === mustLeave) break;
    }
    lines.push(picked.map((token, index) => `${index > 0 && token.spaceBefore ? " " : ""}${token.text}`).join(""));
  }
  if (cursor < tokens.length) {
    const tail = tokens.slice(cursor).map(
      (token, index) => `${(index > 0 || lines[lines.length - 1]) && token.spaceBefore ? " " : ""}${token.text}`,
    ).join("");
    lines[lines.length - 1] += tail;
  }
  return lines.filter(Boolean);
}

function expandDirectionChangeCanvas(block, sourceDirection, targetDirection, peers, imgW, imgH) {
  if (!block || sourceDirection === targetDirection) return block;
  let left = (block.leftPct / 100) * imgW;
  let top = (block.topPct / 100) * imgH;
  let width = (block.widthPct / 100) * imgW;
  let height = (block.heightPct / 100) * imgH;
  const area = width * height;
  // Every neighbour gets HALF the whitespace between the two blocks, and no
  // block ever shrinks below its own ink.
  //
  // The previous rule clamped only against a peer whose far edge already
  // cleared this block (`px2 <= left && px2 > nextLeft`), which is false for
  // the common case — a peer sitting a whole column of whitespace away — so
  // two neighbouring bubbles both expanded into the SAME gap and their
  // translations were drawn through each other. It then recomputed the width
  // as `max(width, nextRight - nextLeft)` while assigning `left = nextLeft`,
  // so a block squeezed from both sides kept its original width and simply
  // slid sideways, out of its own bubble.
  //
  // Splitting the gap is stable without ordering the entries: A stops at the
  // midpoint between A and B, and B stops at the same midpoint, so the two
  // canvases meet and never overlap however the list is traversed.
  if (targetDirection === "h" && height > width) {
    const ideal = Math.max(width, Math.sqrt(area * 1.5));
    const inkLeft = left;
    const inkRight = left + width;
    const centre = left + width / 2;
    let nextLeft = Math.max(0, centre - ideal / 2);
    let nextRight = Math.min(imgW, centre + ideal / 2);
    for (const peer of peers) {
      const px1 = (peer.leftPct / 100) * imgW;
      const py1 = (peer.topPct / 100) * imgH;
      const px2 = ((peer.leftPct + peer.widthPct) / 100) * imgW;
      const py2 = ((peer.topPct + peer.heightPct) / 100) * imgH;
      if (py2 <= top || py1 >= top + height) continue;
      if (px2 <= inkLeft) nextLeft = Math.max(nextLeft, (px2 + inkLeft) / 2);
      else if (px1 >= inkRight) nextRight = Math.min(nextRight, (px1 + inkRight) / 2);
      else {
        // The peer's ink already shares this block's x range: no amount of
        // expansion avoids it, so do not expand towards it at all.
        nextLeft = Math.max(nextLeft, inkLeft);
        nextRight = Math.min(nextRight, inkRight);
      }
    }
    // Expansion is a convenience; the source extent is the truth.
    left = Math.min(nextLeft, inkLeft);
    width = Math.max(nextRight, inkRight) - left;
  } else if (targetDirection === "v" && width > height) {
    const ideal = Math.max(height, Math.sqrt(area / 1.5));
    const inkTop = top;
    const inkBottom = top + height;
    const centre = top + height / 2;
    let nextTop = Math.max(0, centre - ideal / 2);
    let nextBottom = Math.min(imgH, centre + ideal / 2);
    for (const peer of peers) {
      const px1 = (peer.leftPct / 100) * imgW;
      const py1 = (peer.topPct / 100) * imgH;
      const px2 = ((peer.leftPct + peer.widthPct) / 100) * imgW;
      const py2 = ((peer.topPct + peer.heightPct) / 100) * imgH;
      if (px2 <= left || px1 >= left + width) continue;
      if (py2 <= inkTop) nextTop = Math.max(nextTop, (py2 + inkTop) / 2);
      else if (py1 >= inkBottom) nextBottom = Math.min(nextBottom, (py1 + inkBottom) / 2);
      else {
        nextTop = Math.max(nextTop, inkTop);
        nextBottom = Math.min(nextBottom, inkBottom);
      }
    }
    top = Math.min(nextTop, inkTop);
    height = Math.max(nextBottom, inkBottom) - top;
  }
  return {
    leftPct: (left / imgW) * 100,
    topPct: (top / imgH) * 100,
    widthPct: (width / imgW) * 100,
    heightPct: (height / imgH) * 100,
    rotation: 0,
    text: "",
  };
}

function buildAiLineLayout(entry, entries, imgW, imgH, language) {
  const targetDirection = targetTextDirection(language);
  const sourceDirection = entry.sourceVertical ? "v" : "h";
  const directionChange = sourceDirection !== targetDirection;
  const peers = entries.filter((candidate) => candidate !== entry).map((candidate) => candidate.block);
  const canvas = expandDirectionChangeCanvas(
    entry.block, sourceDirection, targetDirection, peers, imgW, imgH,
  );
  const canvasW = (canvas.widthPct / 100) * imgW;
  const canvasH = (canvas.heightPct / 100) * imgH;
  const chars = Math.max(1, Array.from(entry.text).filter((ch) => !/\s/u.test(ch)).length);
  const glyphRatio = isCjkDominant(entry.text) ? 1 : 0.55;
  const sourceFont = Math.max(
    MIN_FONT_PX,
    Number(entry.fontPx) || 0,
    ...entry.sourceItems.map((item) => Number(item?.height) * imgH).filter((value) => value > 0),
  );
  const areaCap = Math.sqrt((canvasW * canvasH) / Math.max(1, chars * glyphRatio * 1.2));
  const candidateFont = Math.max(MIN_FONT_PX, Math.min(sourceFont, areaCap));
  const natural = layoutTokens(entry.text, language, targetDirection === "v").length || 1;
  const gridFont = (lines) => {
    const perLine = Math.ceil(chars / Math.max(1, lines));
    return targetDirection === "v"
      ? Math.min(canvasH / perLine, canvasW / lines)
      : Math.min(canvasW / perLine / Math.max(0.1, glyphRatio), canvasH / (lines * 1.15));
  };
  let lineCount = directionChange ? 1 : Math.max(1, Math.min(20, entry.sourceItems.length || 1));
  if (directionChange) {
    const cap = Math.min(20, natural);
    let best = gridFont(lineCount);
    while (lineCount < cap) {
      const next = gridFont(lineCount + 1);
      if (next <= best) break;
      lineCount += 1;
      best = next;
    }
  } else {
    while (lineCount < 20 && gridFont(lineCount) < MIN_FONT_PX) {
      const next = gridFont(lineCount + 1);
      if (next <= gridFont(lineCount)) break;
      lineCount += 1;
    }
  }
  const texts = distributeTokens(entry.text, language, targetDirection === "v", lineCount);
  lineCount = Math.max(1, texts.length);
  const fontPx = Math.max(MIN_FONT_PX, Math.min(candidateFont, gridFont(lineCount)));
  if (targetDirection === "h") {
    // A vertical source canvas is usually much taller than the horizontal
    // translation needs. Splitting it into one flex element per row makes the
    // browser centre each row in an equal-height slice, visually stretching
    // five Thai lines across the entire Japanese column. Keep the estimated
    // row count only for FONT fitting, then give CSS one compact block to wrap
    // naturally at the explicit 1.05 line height.
    const text = collapseThaiWordGaps(normalizeAiUnitText(entry.text));
    if (!text) return [];
    return [{
      geometry: { ...canvas, rotation: 0, text },
      text,
      fontPx,
    }];
  }
  return texts.map((text, index) => {
    const geometry = {
      leftPct: canvas.leftPct + canvas.widthPct - ((index + 1) * canvas.widthPct) / lineCount,
      topPct: canvas.topPct,
      widthPct: canvas.widthPct / lineCount,
      heightPct: canvas.heightPct,
      rotation: 90,
      text,
    };
    return { geometry, text, fontPx };
  });
}

/**
 * Count AI bubbles whose drawn canvases land on top of one another.
 *
 * Two translations stacked in the same spot is the loudest way this layer can
 * fail, and it is invisible in every other signal: the report says two
 * paragraphs and two lines, exactly as it would for a good page. It is not a
 * renderer fault and the renderer must not "fix" it by moving a bubble
 * somewhere the source text is not — when two groups' SOURCE columns overlap,
 * grouping spliced a region and there is no honest second place to draw. So
 * this names the pairs and leaves the drawing alone.
 */
function reportAiBlockCollisions(aiLayouts, report) {
  const boxes = [];
  for (const [leaderId, layout] of aiLayouts) {
    for (const line of layout.lines || []) {
      const g = line.geometry;
      if (!g) continue;
      boxes.push({
        leaderId,
        left: g.leftPct,
        top: g.topPct,
        right: g.leftPct + g.widthPct,
        bottom: g.topPct + g.heightPct,
      });
    }
  }
  const seen = new Set();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.leaderId === b.leaderId) continue;
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (!(ix > 0) || !(iy > 0)) continue;
      const smaller = Math.min(
        (a.right - a.left) * (a.bottom - a.top),
        (b.right - b.left) * (b.bottom - b.top),
      );
      // A hairline touch between neighbouring bubbles is normal. Correctly
      // grouped bubbles score exactly 0 here — their source columns are
      // disjoint and the expansion splits the gap between them — so the bar
      // only has to clear rounding noise, not judge how bad the collision
      // looks. A spliced pair scores 15-100%. (Everything here is in percent
      // of the page, so this is a ratio and not an area in pixels.)
      if (!(smaller > 0) || (ix * iy) / smaller < 0.05) continue;
      const key = [a.leaderId, b.leaderId].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      report.aiBlocksOverlappingIds.push(key);
    }
  }
  report.aiBlocksOverlapping = report.aiBlocksOverlappingIds.length;
}

function verticalOriginalGeometries(item, imgW, imgH) {
  const raw = itemGeometry(item, imgW, imgH);
  if (!raw) return [];
  if (!(Math.abs(raw.rotation) > VERTICAL_TILT_DEG && isCjkDominant(raw.text))) return [raw];
  const aabb = rotatedItemAabbGeometry(item, imgW, imgH);
  if (!aabb) return [];
  // One Lens item is one OCR column and is already the smallest piece with
  // independent placement geometry. Its spans are word/token intervals inside
  // that column, not independent lines. Turning every span into a DOM box makes
  // punctuation-sized spans constrain the paragraph's shared font and exposes
  // the tiny gaps between Lens token intervals as large visual word spacing.
  // Keep the raw item as one vertical-rl element: its AABB, text order and
  // baseline extent then reproduce the source column without ONNX relayout.
  // `upright` travels with the geometry so the font fitter and makeLine agree
  // on the axis the glyphs run down. Without it the horizontal fitter divides
  // the column's narrow side by the glyph count and the text comes out tiny.
  return [{ ...aabb, rotation: raw.rotation, text: raw.text, upright: true }];
}

/**
 * One box covering a whole paragraph, for text that has no per-item split.
 *
 * A single item keeps its own rotation. Several items are a polyline whose
 * segments differ slightly in angle, so the union is taken axis-aligned and
 * drawn upright: rotating the union by an averaged angle would tilt a block
 * that no longer follows any one baseline.
 */
export function paragraphBlock(geometries) {
  if (geometries.length === 1) return geometries[0];

  const left = Math.min(...geometries.map((g) => g.leftPct));
  const top = Math.min(...geometries.map((g) => g.topPct));
  const right = Math.max(...geometries.map((g) => g.leftPct + g.widthPct));
  const bottom = Math.max(...geometries.map((g) => g.topPct + g.heightPct));
  return {
    leftPct: left,
    topPct: top,
    widthPct: right - left,
    heightPct: bottom - top,
    rotation: 0,
    text: "",
  };
}

function makeLine(geometry, text, fontPx, onDark = false, extraClasses = []) {
  const div = document.createElement("div");
  const classes = ["tp-line"];
  // White ink with a dark halo, on a paragraph the server measured as sitting
  // on a dark background. The CSS for this has been here all along; what was
  // missing was the flag, so this renderer drew its default near-black ink on
  // black panels and the text could not be read. The server's own markup has
  // never had that problem, which is why it only appeared once this renderer
  // started running.
  if (onDark) classes.push("tp-on-dark");
  // A vertical CJK column must be typeset upright, not laid out horizontally
  // and rotated 90° — that leaves every glyph lying on its side. But a steeply
  // tilted horizontal label is NOT a column, hence the 78° cut-off rather than
  // something loose like 60°.
  const vertical = geometry.upright === true ||
    (Math.abs(geometry.rotation) > VERTICAL_TILT_DEG && isCjkDominant(text));
  if (vertical) classes.push("vert");
  if (containsRtl(text)) classes.push("rtl");
  classes.push(...extraClasses);
  div.className = classes.join(" ");

  const lineHeight = roundHalfEven(fontPx * 1.05);
  div.style.cssText =
    `left:${geometry.leftPct.toFixed(4)}%;` +
    `top:${geometry.topPct.toFixed(4)}%;` +
    `width:${geometry.widthPct.toFixed(4)}%;` +
    `height:${geometry.heightPct.toFixed(4)}%;` +
    // Upright columns are already vertical through writing-mode; rotating them
    // as well would tip the column over.
    (vertical ? "" : `transform:rotate(${geometry.rotation.toFixed(4)}deg);`) +
    `font-size:calc(var(--tp-font-scale,1) * ${fontPx}px);` +
    `line-height:calc(var(--tp-font-scale,1) * ${lineHeight}px);`;

  div.textContent = text;
  return div;
}

/**
 * Render a LensDocument layer into a detached element.
 *
 * @returns {{root: HTMLElement, report: object}} The report says what was
 *   drawn and what was not. A paragraph skipped for want of text and a
 *   paragraph skipped for want of geometry look identical on screen — both are
 *   simply absent — so the caller is told which happened.
 */
export function translatedRotationSigns(doc, { allowApproximate = false } = {}) {
  const byId = new Map((doc?.paragraphs || []).map((p) => [String(p?.id), p]));
  const signs = new Map();
  const assigned = new Set();
  let mixedGroups = 0;
  const recordSign = (ids) => {
    const rotations = ids.flatMap((id) => {
      const para = byId.get(String(id));
      if (!para) return [];
      return (itemsForSource(para, "translated", { allowApproximate }).items || [])
        .map((item) => Number(item?.rotation) || 0)
        .filter((rotation) => Math.abs(rotation) > VERTICAL_TILT_DEG);
    });
    const pos = rotations.filter((rotation) => rotation > 0);
    const neg = rotations.filter((rotation) => rotation < 0);
    if (!pos.length || !neg.length) return;
    const strongest = rotations.reduce((best, rotation) => (
      Math.abs(rotation) > Math.abs(best) ? rotation : best
    ), rotations[0]);
    const sign = pos.length !== neg.length
      ? (pos.length > neg.length ? 1 : -1)
      : (strongest > 0 ? 1 : -1);
    ids.forEach((id) => signs.set(String(id), sign));
    mixedGroups++;
  };
  for (const group of doc?.groups || []) {
    const ids = (group?.paragraphIds || []).map(String);
    ids.forEach((id) => assigned.add(id));
    if (group?.direction === "v") recordSign(ids);
  }
  for (const para of doc?.paragraphs || []) {
    const id = String(para?.id);
    if (!assigned.has(id)) recordSign([id]);
  }
  return { signs, mixedGroups };
}

export function renderOverlay(
  doc,
  {
    source = "translated",
    ownerDocument = document,
    allowApproximate = false,
    relayoutTranslated = undefined,
  } = {},
) {
  const imgW = Number(doc?.image?.width) || 0;
  const imgH = Number(doc?.image?.height) || 0;

  const root = ownerDocument.createElement("div");
  root.className = "tp-draw-root";
  const sourceLanguage = String(doc?.languages?.source || "").trim();
  const targetLanguage = String(doc?.languages?.target || "").trim();
  const layerLanguage = source === "original" ? sourceLanguage : targetLanguage;
  if (layerLanguage) root.setAttribute?.("lang", layerLanguage);
  const scope = ownerDocument.createElement("div");
  scope.className = "tp-draw-scope";
  root.appendChild(scope);

  const report = {
    source,
    paragraphs: 0,
    lines: 0,
    skippedNoText: 0,
    skippedNoGeometry: 0,
    missingLayer: [],
    // Paragraphs the MODEL did not answer, kept apart from a structural
    // mismatch: the page is fine, the answer was short, and the source pixels
    // under those bubbles are deliberately left alone.
    aiUnanswered: [],
    // Columns whose sentence another column of the same bubble draws. A count,
    // not silence: a page short a bubble must not look like a finished one.
    coveredByGroup: 0,
    // Bubbles drawn as one string across several columns.
    groupsDrawn: 0,
    // Pairs of AI bubbles whose canvases still land on top of each other.
    // The renderer cannot fix this — two groups whose SOURCE columns overlap
    // have no two places to go — but two translations stacked in one spot is
    // the most visible failure this layer has, so it is counted rather than
    // drawn in silence. A non-zero count means grouping spliced a region.
    aiBlocksOverlapping: 0,
    aiBlocksOverlappingIds: [],
  };

  if (!(imgW > 0) || !(imgH > 0)) {
    report.error = `document has no usable image size (${imgW}x${imgH})`;
    return { root, report };
  }

  const fidelity = canRenderFaithfully(doc, source);
  report.approximate = !fidelity.ok;
  if (!fidelity.ok && (fidelity.refuseLocal || !allowApproximate)) {
    // Refused, not degraded. The caller uses the server's markup and logs that
    // it did — which is a visible decision, unlike a page that quietly renders
    // its translation in the wrong places. Resource-budget failures are hard
    // refusals: `allowApproximate` may relax geometry fidelity, never resource
    // safety.
    report.error = fidelity.reason;
    return { root, report };
  }

  // Paragraphs by id, so a bubble-group leader can reach its members' boxes.
  // Built once: a group of 4 in a page of 40 would otherwise scan the list
  // once per member.
  const byId = new Map((doc.paragraphs || []).map((p) => [String(p?.id), p]));

  // AI text always comes back as one semantic string per translation unit.
  // Build its target-language rows/columns HERE in the extension. The API is
  // responsible for Lens upload, vertical ONNX membership and text
  // translation only; it must not be called again to build aiItems/HTML.
  const aiLayouts = new Map();
  if (source === "ai") {
    const groupsByLeader = new Map();
    for (const group of doc?.groups || []) {
      const leader = String(group?.paragraphIds?.[0] || "");
      if (leader) groupsByLeader.set(leader, group);
    }
    const entries = [];
    for (const para of doc?.paragraphs || []) {
      const text = String(para?.aiText || "").trim();
      if (!text) continue;
      const leaderId = String(para?.id || "");
      const ids = Array.isArray(para?.aiGroupParagraphIds) && para.aiGroupParagraphIds.length
        ? para.aiGroupParagraphIds.map(String)
        : [leaderId];
      const members = ids.map((id) => byId.get(id)).filter(Boolean);
      if (members.length !== ids.length) continue;
      const sourceItems = members.flatMap((member) => member?.items || []);
      // A server-produced/fixture AI layer already owns exact per-line
      // geometry; never replace it. The local builder exists for text-only
      // replies, which deliberately carry aiText but no aiItems.
      if (members.some((member) => (member?.aiItems || []).length)) continue;
      const block = unionGeometry(
        sourceItems.map((item) => rotatedItemAabbGeometry(item, imgW, imgH)).filter(Boolean),
      );
      if (!block || !sourceItems.length) continue;
      const group = groupsByLeader.get(leaderId);
      const sourceVertical = group?.direction === "v" || itemsReadVertically(sourceItems);
      if (!sourceVertical && targetTextDirection(targetLanguage) === "h") continue;
      entries.push({
        leaderId,
        ids,
        members,
        sourceItems,
        sourceVertical,
        fontPx: group?.fontPx,
        block,
        text,
        onDark: members.some((member) => Boolean(
          member?.aiTextLight !== undefined ? member.aiTextLight : member?.textLight,
        )),
      });
    }
    for (const entry of entries) {
      const lines = buildAiLineLayout(entry, entries, imgW, imgH, targetLanguage);
      if (lines.length) aiLayouts.set(entry.leaderId, { ...entry, lines });
    }
    reportAiBlockCollisions(aiLayouts, report);
  }

  // OFF keeps Lens boxes, but presentation rotation is normalised on a local
  // geometry copy. The document itself remains untouched so switching back to
  // Original can always reproduce the decoded baselines verbatim.
  const verticalSigns = new Map();
  let mixedRotationGroups = 0;
  if (source === "translated" && relayoutTranslated === false) {
    const local = translatedRotationSigns(doc, { allowApproximate });
    local.signs.forEach((sign, id) => verticalSigns.set(id, sign));
    mixedRotationGroups = local.mixedGroups;
  }
  report.rotationMixedGroups = mixedRotationGroups;
  report.rotationFlips = 0;

  // ON rebuilds vertical-source groups as upright horizontal target blocks.
  // This is presentation-only and uses explicit grouping solely to choose the
  // target block; it never changes Original's visible item DOM.
  const relayoutBlocks = new Map();
  const relayoutCovered = new Set();
  if (source === "translated" && relayoutTranslated === true) {
    const grouped = new Set();
    for (const group of doc?.groups || []) {
      const ids = (group?.paragraphIds || []).map(String);
      const members = ids.map((id) => byId.get(id)).filter(Boolean);
      const sourceItems = members.flatMap((para) => para.items || []);
      const vertical = group?.direction === "v" || sourceItems.filter(
        (item) => Math.abs(Number(item?.rotation) || 0) > VERTICAL_TILT_DEG,
      ).length * 2 >= Math.max(1, sourceItems.length);
      if (!vertical || !members.length) continue;
      let block = geometryFromPixelBounds(group?.boundsPx, imgW, imgH);
      if (!block) block = unionGeometry(sourceItems.map((item) => rotatedItemAabbGeometry(item, imgW, imgH)).filter(Boolean));
      const text = members.map((para) => {
        const own = (para.lensItems || []).map((item) => String(item?.text || "").trim()).filter(Boolean).join(" ");
        return own || String(para.lensText || "").trim();
      }).filter(Boolean).join(" ");
      if (!block || !text) continue;
      relayoutBlocks.set(ids[0], { block, text, members });
      ids.slice(1).forEach((id) => relayoutCovered.add(id));
      ids.forEach((id) => grouped.add(id));
    }
    for (const para of doc.paragraphs || []) {
      const id = String(para?.id);
      if (grouped.has(id)) continue;
      const sourceItems = para?.items || [];
      const vertical = sourceItems.filter(
        (item) => Math.abs(Number(item?.rotation) || 0) > VERTICAL_TILT_DEG,
      ).length * 2 >= Math.max(1, sourceItems.length);
      if (!vertical) continue;
      const block = unionGeometry(sourceItems.map((item) => rotatedItemAabbGeometry(item, imgW, imgH)).filter(Boolean));
      const text = (para?.lensItems || []).map((item) => String(item?.text || "").trim()).filter(Boolean).join(" ") ||
        String(para?.lensText || "").trim();
      if (block && text) relayoutBlocks.set(id, { block, text, members: [para] });
    }
  }

  // When orientation relayout is OFF, Lens keeps neighbouring vertical
  // translated columns as separate boxes.  Compute one font per local text set
  // before drawing so short lines do not become huge while long neighbours
  // become tiny.  Explicit ONNX groups win; otherwise geometry supplies the
  // evidence.  The helper's scale guard keeps nearby titles/signs separate.
  const translatedFonts = new Map();
  if (source === "translated" && relayoutTranslated === false) {
    const groupByParagraph = new Map();
    for (const group of doc?.groups || []) {
      for (const id of group?.paragraphIds || []) groupByParagraph.set(String(id), String(group.id));
    }
    const records = [];
    for (const para of doc.paragraphs || []) {
      const resolved = itemsForSource(para, "translated", { allowApproximate });
      if (!resolved.own) continue;
      const geometries = resolved.items.map((item) => itemGeometry(item, imgW, imgH)).filter(Boolean);
      const visible = geometries.filter((geometry) => geometry.text.trim());
      if (!visible.length) continue;
      const verticalVotes = visible.filter(
        (geometry) => Math.abs(Number(geometry.rotation) || 0) > VERTICAL_TILT_DEG,
      ).length;
      if (verticalVotes * 2 < visible.length) continue;
      const fontPx = sharedParagraphFontSize(visible, imgW, imgH);
      if (!(fontPx > 0)) continue;
      const rects = visible.map((g) => {
        const vertical = Math.abs(Number(g.rotation) || 0) > VERTICAL_TILT_DEG;
        const cx = ((g.leftPct + g.widthPct / 2) / 100) * imgW;
        const cy = ((g.topPct + g.heightPct / 2) / 100) * imgH;
        // itemGeometry describes the unrotated baseline rectangle.  A steep
        // column's visible AABB swaps those axes; comparing the unrotated box
        // would measure overlap between two tiny horizontal strips instead of
        // the parallel columns actually on the page.
        const halfW = vertical ? ((g.heightPct / 100) * imgH) / 2 : ((g.widthPct / 100) * imgW) / 2;
        const halfH = vertical ? ((g.widthPct / 100) * imgW) / 2 : ((g.heightPct / 100) * imgH) / 2;
        return { left: cx - halfW, top: cy - halfH, right: cx + halfW, bottom: cy + halfH };
      });
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      // Scale evidence comes from the ORIGINAL artwork, not the translated
      // layer. Lens may shrink a long Thai title into a 25px target box even
      // though the source title glyphs are 70px; using target geometry would
      // make it look scale-compatible with 24px dialogue and merge the two.
      const sourceGeometries = (para?.items || [])
        .map((item) => itemGeometry(item, imgW, imgH))
        .filter(Boolean);
      const sourceVertical = sourceGeometries.filter(
        (geometry) => Math.abs(Number(geometry.rotation) || 0) > VERTICAL_TILT_DEG,
      );
      const scaleGeometries = sourceVertical.length ? sourceVertical : sourceGeometries;
      const sourceGlyphs = scaleGeometries
        .map((g) => (g.heightPct / 100) * imgH)
        .filter((value) => value > 0)
        .sort((a, b) => a - b);
      const targetGlyphs = visible
        .map((g) => (g.heightPct / 100) * imgH)
        .filter((value) => value > 0)
        .sort((a, b) => a - b);
      const glyphs = sourceGlyphs.length ? sourceGlyphs : targetGlyphs;
      records.push({
        id: String(para.id),
        fontPx,
        glyphPx: glyphs[Math.floor(glyphs.length / 2)],
        left,
        top,
        right,
        bottom,
        groupId: groupByParagraph.get(String(para.id)) || "",
      });
    }
    // The OFF presentation is one page/set, not a collection of independent
    // paragraphs. Use source glyph scale to keep conspicuously large title /
    // sign text in its own tier, and give every regular column one shared size.
    const glyphs = records.map((record) => record.glyphPx).filter((value) => value > 0).sort((a, b) => a - b);
    const medianGlyph = glyphs[Math.floor(glyphs.length / 2)] || 0;
    const regular = records.filter(
      (record) => !medianGlyph || (record.glyphPx >= 0.67 * medianGlyph && record.glyphPx <= 1.5 * medianGlyph),
    );
    const regularFont = regular.length ? Math.max(...regular.map((record) => record.fontPx)) : 0;
    for (const record of records) {
      translatedFonts.set(record.id, regular.includes(record) ? regularFont : record.fontPx);
    }
  }

  for (const para of doc.paragraphs || []) {
    // Checked before the layer: a paragraph with nothing to translate is not
    // a paragraph whose translation is missing. Counting it as missing would
    // pad the "ask again for these" list with ids that can never be answered.
    if (!String(para?.sourceText || "").trim()) {
      report.skippedNoText++;
      continue;
    }

    const paraId = String(para?.id);
    if (source === "ai") {
      if (para.aiCoveredBy) {
        report.coveredByGroup++;
        continue;
      }
      const rebuilt = aiLayouts.get(paraId);
      if (rebuilt) {
        for (const row of rebuilt.lines) {
          const line = makeLine(
            row.geometry, row.text, Math.max(MIN_FONT_PX, row.fontPx), rebuilt.onDark, ["bubble"],
          );
          scope.appendChild(line);
          report.lines++;
        }
        report.paragraphs++;
        if (rebuilt.ids.length > 1) report.groupsDrawn++;
        continue;
      }
    }
    if (source === "translated" && relayoutTranslated === true) {
      if (relayoutCovered.has(paraId)) {
        report.coveredByGroup++;
        continue;
      }
      const rebuilt = relayoutBlocks.get(paraId);
      if (rebuilt) {
        // The target block represents the WHOLE ONNX group, not only its
        // leader paragraph.  A dark panel can be sampled differently by two
        // narrow source columns (one catches a white edge / glyph, the other
        // the black fill), so one dark member must flip the combined target to
        // white ink.  The Original browser-translate group follows the same
        // rule below.
        const onDark = rebuilt.members.some((member) => Boolean(member?.textLight));
        const fontPx = fitParagraphFontSizeHorizontal(
          rebuilt.block.widthPct, rebuilt.block.heightPct, rebuilt.text, imgW, imgH,
        );
        const line = makeLine(rebuilt.block, rebuilt.text, Math.max(MIN_FONT_PX, fontPx), onDark);
        line.classList.add("bubble");
        scope.appendChild(line);
        report.paragraphs++;
        report.lines++;
        if (rebuilt.members.length > 1) report.groupsDrawn++;
        continue;
      }
    }

    // This column's sentence is drawn by another column of the same bubble.
    // Lens split ONE vertical sentence into several paragraphs; the
    // translation belongs to the bubble, and drawing it here as well would
    // stack the whole sentence on top of itself once per column.
    //
    // Counted, not silently skipped: a page that is short a bubble because the
    // grouping was wrong must not look the same as one where every bubble was
    // drawn.
    if (source === "ai" && para.aiCoveredBy) {
      report.coveredByGroup++;
      continue;
    }

    // Each layer draws from its OWN lines. `items` is Lens's source layout,
    // `lensItems` its machine translation, `aiItems` the layout the AI text
    // was fitted into — a translation does not break where the source did, so
    // one layer's boxes are not usable for another's text.
    //
    // Resolved BEFORE the missing-text check, and that order is the whole
    // point. It was the other way round on 2026-08-07 and every AI page came
    // out blank: the server delivers its AI text inside `aiItems[].text`, so
    // asking `para.aiText` first declared all four paragraphs missing and
    // skipped them — while `canRenderFaithfully` had just said the layer was
    // fine, because the items it needed were right there.
    let { items: layerItems, own: ownItems } = itemsForSource(para, source, {
      allowApproximate,
    });

    // A bubble-group leader draws for the whole bubble, so it needs the whole
    // bubble's boxes — its own column only covers part of the speech balloon,
    // and one sentence squeezed into one column is unreadable.
    //
    // The SOURCE items are used deliberately: those are the columns Lens
    // actually found on the page, which is where the bubble is. `aiItems`
    // (per-line AI geometry) is a server-side product and does not exist on
    // this path.
    const groupIds = source === "ai" ? para.aiGroupParagraphIds : null;
    if (Array.isArray(groupIds) && groupIds.length > 1) {
      const merged = [];
      let missingMember = false;
      for (const id of groupIds) {
        const member = byId.get(String(id));
        if (!member) {
          missingMember = true;
          continue;
        }
        merged.push(...(member.items || []));
      }
      if (missingMember) {
        // A group naming a paragraph this document does not have means the
        // grouping and the document have come apart. Drawing the sentence over
        // whatever boxes did resolve would put it in the wrong place and still
        // look deliberate.
        report.missingLayer.push(para.id);
        continue;
      }
      if (merged.length) {
        layerItems = merged;
        // Borrowed from the source layer on purpose, so the branch below draws
        // ONE string over the combined extent rather than per-line source text.
        ownItems = false;
      }
      report.groupsDrawn++;
    }
    const layerItemText = ownItems && layerItems.some((i) => String(i?.text || "").trim());
    // The AI layer is re-laid out and can land on different background than
    // the source paragraph, so it carries its own reading. A grouped AI block
    // spans every named column, therefore one dark member flips the whole
    // combined block just like Original gtext and Translated relayout do.
    const paragraphOnDark = (member) => Boolean(
      source === "ai" && member?.aiTextLight !== undefined
        ? member.aiTextLight
        : member?.textLight,
    );
    const onDark = Array.isArray(groupIds) && groupIds.length > 1
      ? groupIds.map((id) => byId.get(String(id))).filter(Boolean).some(paragraphOnDark)
      : paragraphOnDark(para);

    const { text, layer } = textForSource(para, source);
    if (!layerItemText) {
      if (layer === "ai-missing") {
        // The user asked for AI and this paragraph has none — no per-line text
        // and no whole-paragraph string. Recorded by id so the caller can
        // re-ask for exactly these, and so a half-translated page is never
        // mistaken for a fully translated one.
        report.missingLayer.push(para.id);
        report.aiUnanswered.push(para.id);
        continue;
      }
      if (!text.trim()) {
        report.skippedNoText++;
        continue;
      }
    }

    const geometries = [];
    for (const item of layerItems) {
      const itemGeometries = source === "original"
        ? verticalOriginalGeometries(item, imgW, imgH)
        : [itemGeometry(item, imgW, imgH)].filter(Boolean);
      if (!itemGeometries.length) {
        report.skippedNoGeometry++;
        continue;
      }
      for (const geometry of itemGeometries) {
        if (
          source === "translated" && relayoutTranslated === false &&
          Math.abs(Number(geometry.rotation) || 0) > VERTICAL_TILT_DEG &&
          verticalSigns.has(String(para?.id)) &&
          Math.sign(geometry.rotation) !== verticalSigns.get(String(para?.id))
        ) {
          geometry.rotation += verticalSigns.get(String(para?.id)) * 180;
          report.rotationFlips++;
        }
        geometries.push(geometry);
      }
    }
    if (!geometries.length) continue;

    report.paragraphs++;

    let visibleParent = scope;
    if (source === "original") {
      visibleParent = ownerDocument.createElement("div");
      visibleParent.className = "tp-src notranslate";
      visibleParent.setAttribute?.("translate", "no");
      visibleParent.translate = false;
      scope.appendChild(visibleParent);
    }

    // Per-line text is only usable when the boxes belong to THIS layer.
    // Borrowed boxes carry the source text, and drawing that would put the
    // untranslated line on screen inside a box that looks deliberate.
    if (layerItemText && geometries.some((g) => g.text.trim())) {
      // One shared size across the bubble, because per-item fitting makes
      // neighbouring lines disagree by 10px for no reason a reader can see.
      const shared = translatedFonts.get(String(para.id)) ??
        sharedParagraphFontSize(geometries, imgW, imgH);
      for (const geometry of geometries) {
        if (!geometry.text.trim()) continue;
        const fitOne = geometry.upright === true ? fitColumnFontSize : fitItemFontSize;
        const fontPx =
          shared ?? fitOne(geometry.widthPct, geometry.heightPct, geometry.text, imgW, imgH);
        visibleParent.appendChild(
          makeLine(geometry, geometry.text, Math.max(MIN_FONT_PX, fontPx), onDark),
        );
        report.lines++;
      }
      continue;
    }

    // No per-line text for this layer: one string over the paragraph's extent.
    // Only reachable for a single-line paragraph (`itemsForSource` returns
    // nothing for a multi-line one without its own items) or when the layer's
    // text was patched in client-side, where one box is the right answer.
    let block = paragraphBlock(geometries);
    // AI target text is laid out horizontally even when Lens's sole source
    // line was vertical. Convert the rotated source rectangle to its upright
    // pixel AABB; retaining rotate(-90deg) reproduces the source direction and
    // prevents Thai from wrapping naturally.
    if (source === "ai" && Math.abs(Number(block.rotation) || 0) > 45) {
      const cx = block.leftPct + block.widthPct / 2;
      const cy = block.topPct + block.heightPct / 2;
      const widthPct = (block.heightPct * imgH) / imgW;
      const heightPct = (block.widthPct * imgW) / imgH;
      block = {
        ...block,
        leftPct: cx - widthPct / 2,
        topPct: cy - heightPct / 2,
        widthPct,
        heightPct,
        rotation: 0,
      };
    }
    // Horizontal AI paragraphs can deliberately skip buildAiLineLayout above:
    // their source box already has the right direction and one DOM block is
    // the faithful layout. They still need the same Thai spacing policy as a
    // rebuilt vertical bubble. Without this final boundary, cached/direct AI
    // text bypasses the normaliser and visibly keeps provider word gaps.
    const displayText = source === "ai"
      ? collapseThaiWordGaps(normalizeAiUnitText(text))
      : text;
    const shouldWrap = source === "ai" || geometries.length > 1;
    const fontPx = shouldWrap
      ? fitParagraphFontSizeHorizontal(block.widthPct, block.heightPct, displayText, imgW, imgH)
      : block.upright === true
        ? fitColumnFontSize(block.widthPct, block.heightPct, displayText, imgW, imgH)
        : fitItemFontSize(block.widthPct, block.heightPct, displayText, imgW, imgH);
    const line = makeLine(block, displayText, Math.max(MIN_FONT_PX, fontPx), onDark);
    if (shouldWrap) line.classList.add("bubble");
    visibleParent.appendChild(line);
    report.lines++;
  }

  if (source === "original") {
    const covered = new Set();
    const targets = [];
    for (const group of doc?.groups || []) {
      const ids = (group?.paragraphIds || []).map(String);
      const members = ids.map((id) => byId.get(id)).filter(Boolean);
      ids.forEach((id) => covered.add(id));
      const block = unionGeometry(
        members.flatMap((para) => para.items || [])
          .map((item) => rotatedItemAabbGeometry(item, imgW, imgH)).filter(Boolean),
      );
      const text = String(group?.text || "").trim();
      if (block && text) targets.push({
        block,
        text,
        onDark: members.some((para) => Boolean(para?.textLight)),
      });
    }
    for (const para of doc.paragraphs || []) {
      if (covered.has(String(para?.id))) continue;
      const text = String(para?.sourceText || "").trim();
      const block = unionGeometry(
        (para?.items || []).map((item) => rotatedItemAabbGeometry(item, imgW, imgH)).filter(Boolean),
      );
      if (block && text) targets.push({ block, text, onDark: Boolean(para.textLight) });
    }
    for (const target of targets) {
      const fontPx = fitParagraphFontSizeHorizontal(
        target.block.widthPct, target.block.heightPct, target.text, imgW, imgH,
      );
      const line = makeLine(
        target.block, target.text, Math.max(MIN_FONT_PX, fontPx), target.onDark, ["tp-gtext", "bubble"],
      );
      // Rawkuma and similar reader pages commonly declare themselves English
      // even when the inserted OCR is Japanese. Chrome otherwise translates
      // this Japanese as if it were English and produces mostly Japanese/�
      // output. Give the browser's own translator the OCR source language on
      // the exact semantic group it is allowed to replace.
      if (sourceLanguage) line.setAttribute?.("lang", sourceLanguage);
      line.setAttribute?.("translate", "yes");
      line.translate = true;
      scope.appendChild(line);
    }
  }

  return { root, report };
}
