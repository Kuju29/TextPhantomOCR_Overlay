/**
 * Decode Google Lens OCR data into the structured "tree" the renderer uses.
 *
 *
 * Port of `api/backend/lens/tree.py`. `README.md#architecture-and-ownership` puts this
 * decode into the service worker: the extension already holds the Lens
 * response, and shipping it to Python and back buys nothing but a round trip.
 * Python keeps its copy for `/v1/lens/fallback`, where the server did the Lens
 * call itself, so both readers stay alive and both are pinned to the same
 * fixture (`scripts/test-lens-tree.mjs`, `api/tests/test_lens_tree.py`).
 *
 * Tree shape:
 *
 *     {
 *       side: "original" | "translated" | "Ai",
 *       paragraphs: [
 *         {
 *           side, para_index, start_raw, end_raw, text, valid_text,
 *           bounds_px,
 *           items: [
 *             {
 *               side, para_index, item_index, start_raw, end_raw,
 *               text, valid_text, height_raw,
 *               baseline_p1: {x, y}, baseline_p2: {x, y},
 *               box: {...}, bounds_px,
 *               spans: [ { ...span fields..., box: {...} }, ... ]
 *             }, ...
 *           ]
 *         }, ...
 *       ],
 *       diagnostics: { ... }
 *     }
 *
 * Each paragraph's geometry is a *polyline*: items carry their own straight
 * baseline, so a curved line of text is approximated by several items at
 * slightly different angles.
 *
 * WHY `diagnostics` EXISTS
 * Lens sends malformed items. Both implementations skip them — they have to,
 * there is nothing to draw — but skipping is where this decode can lie. A page
 * that quietly loses four of its eleven paragraphs still renders, still looks
 * like a translated page, and reads as "the AI dropped some bubbles" or "the
 * renderer is clipping" — two wrong files to go looking in. Every skip is
 * counted, by reason, and the counts ride out with the tree.
 */

import {
  base64ToBytes,
  extractItemGeomSpans,
  extractItemsFromParagraph,
  extractSpan,
  getPointsFromGeom,
} from "./lens-proto.js";

/** Thrown when a tree cannot be built at all. Never returns a partial tree. */
export class LensTreeError extends Error {}

/**
 * Fold an angle into (-90, 90].
 *
 * Text rotated 200° is visually the same as 20°; the renderer only cares about
 * that folded value. Mirrors `render.geometry.normalize_angle_deg`.
 */
export function normalizeAngleDeg(angleDeg) {
  let a = angleDeg;
  while (a <= -180) a += 360;
  while (a > 180) a -= 360;
  if (a < -90) a += 180;
  if (a > 90) a -= 180;
  return a;
}

/**
 * Rotated quad built from a node's *box* (left/top/width/height + angle).
 *
 * Mirrors `render.geometry.token_box_quad_px`. Returns null for a degenerate
 * box rather than a zero-area quad at the origin, which would drag every
 * paragraph's bounds to the top-left corner of the page.
 */
export function boxQuadPx(node, W, H, padPx = 0) {
  const b = node && node.box;
  if (!b || typeof b !== "object") {
    throw new LensTreeError("boxQuadPx needs a node with a box");
  }

  const w = Number(b.width) * W;
  const h = Number(b.height) * H;
  // A non-positive or non-finite size is a degenerate box, which is a real
  // answer: there is nothing to cover. Returning null keeps it out of the
  // bounds union instead of dragging it to the origin.
  if (!(w > 0) || !(h > 0)) return null;

  // `left` and `top` are NOT defaulted. Zero is a real position — the left
  // edge of the page — so substituting it for a missing one would put a
  // paragraph's bounds at the top-left corner and read as a layout bug.
  if (!Number.isFinite(Number(b.left)) || !Number.isFinite(Number(b.top))) {
    throw new LensTreeError("box has a non-finite left/top");
  }
  const left = Number(b.left) * W;
  const top = Number(b.top) * H;
  const cx = left + w / 2;
  const cy = top + h / 2;

  const hw = w / 2 + padPx;
  const hh = h / 2 + padPx;

  // Rotation is the one genuine default here: most boxes omit it, and "unset"
  // and "0°" are the same intent. Mirrors `token_box_quad_px`.
  const rotation = b.rotation_deg === undefined ? 0 : Number(b.rotation_deg);
  if (!Number.isFinite(rotation)) throw new LensTreeError("box has a non-finite rotation_deg");
  const rad = (rotation * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);

  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => [cx + (x * c - y * s), cy + (x * s + y * c)]);
}

/** Grow `bounds` ([l, t, r, b] or null) to cover `next`. */
function unionBounds(bounds, next) {
  if (bounds === null) return next;
  return [
    Math.min(bounds[0], next[0]),
    Math.min(bounds[1], next[1]),
    Math.max(bounds[2], next[2]),
    Math.max(bounds[3], next[3]),
  ];
}

/** `[min start, max end]` over a list of `[start, end]` ranges. */
function rangeMinMax(ranges) {
  if (!ranges.length) return [null, null];
  return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))];
}

/**
 * Every reason this decode can drop something, so a count is never anonymous.
 *
 * Kept as an explicit list rather than accumulated on demand: a reason that
 * only appears in the output when it fires is a reason nobody knows to look
 * for.
 *
 * Every one of these is REACHABLE — the shared fixture fires all five. A
 * counter that can never move is worse than no counter: it reads as "this
 * never happens" when it means "this cannot be seen". Three earlier candidates
 * (`item_no_geometry`, `item_text_out_of_range`, `paragraph_text_out_of_range`)
 * turned out to be unreachable given what `isItemMessage` already guarantees,
 * so they are assertions now — see `impossible` below.
 */
export const DROP_REASONS = [
  "item_unusable_geometry",
  "item_degenerate_baseline",
  "span_no_end",
  "span_no_position",
  "span_text_out_of_range",
];

/**
 * Thrown when the decode reaches a state its own guards rule out.
 *
 * Not a bad-input error — bad input has a counter. This means two functions in
 * this module disagree about what a well-formed item is, which is a code bug,
 * and a code bug that silently produced an empty string here would land as "a
 * bubble came out blank" three layers downstream.
 */
export class LensTreeInvariantError extends Error {}

function impossible(what) {
  throw new LensTreeInvariantError(what);
}

function emptyDiagnostics() {
  const drops = {};
  for (const reason of DROP_REASONS) drops[reason] = 0;
  return { drops, deepWalkParagraphs: 0, exhaustedParagraphs: 0 };
}

/**
 * Slice `chars[start:end]`, or null when the range is not usable.
 *
 * Python's `_slice_text` returns "" here. Returning "" is what makes a bad
 * offset indistinguishable from a genuinely empty paragraph, so this returns
 * null and the caller counts it. The rendered result is the same empty string;
 * the difference is that somebody can now see it happened.
 */
function sliceText(chars, start, end) {
  if (start === null || end === null) return null;
  if (start < 0 || end < 0 || start > end || end > chars.length) return null;
  return chars.slice(start, end).join("");
}

/**
 * Build a render tree from Lens `paragraphs` (base64 protobuf) + text.
 *
 * `fullText` is the concatenated text the span ranges index into. `side`
 * labels the layer (`original` / `translated`).
 *
 * `imgW` / `imgH` must be the image's NATURAL pixel size. Lens normalises its
 * geometry against the image it was given, so there is no default that could
 * be right here — a guess produces a tree that renders, at the wrong scale, on
 * every page, with nothing to indicate why.
 */
export function decodeTree(paragraphsB64, fullText, side, imgW, imgH) {
  if (!Array.isArray(paragraphsB64)) {
    throw new LensTreeError("paragraphs must be an array of base64 strings");
  }
  if (!(Number(imgW) > 0) || !(Number(imgH) > 0)) {
    throw new LensTreeError(
      `image size is required and must be positive (got ${imgW}x${imgH}); ` +
        "Lens geometry is normalised against it, so it cannot be inferred here",
    );
  }
  const W = Number(imgW);
  const H = Number(imgH);

  // Not defaulted to "". Every span offset indexes this string, so a missing
  // one makes every slice fall out of range and every paragraph come back
  // blank — a page of empty bubbles, which reads as an OCR failure rather than
  // as a caller that forgot an argument.
  if (typeof fullText !== "string") {
    throw new LensTreeError(`fullText must be a string, got ${typeof fullText}`);
  }
  // Code POINTS, not UTF-16 units: Lens offsets index the string the way
  // Python does. On a page with an emoji or any astral character the two
  // conventions diverge and every span after it slices the wrong substring.
  const chars = Array.from(fullText);

  const diagnostics = emptyDiagnostics();
  const bump = (reason) => {
    diagnostics.drops[reason] += 1;
  };

  const paragraphs = [];
  let cursor = 0;

  paragraphsB64.forEach((b64, paraIndex) => {
    const parBytes = base64ToBytes(b64);
    const { items: itemMsgs, deep, exhausted } = extractItemsFromParagraph(parBytes);
    if (deep) diagnostics.deepWalkParagraphs += 1;
    if (exhausted) diagnostics.exhaustedParagraphs += 1;

    const items = [];
    const paraRanges = [];
    let paraBounds = null;

    itemMsgs.forEach((itemBytes, itemIndex) => {
      const { geom, spans: spansBytes } = extractItemGeomSpans(itemBytes);
      if (geom === null) {
        // `isItemMessage` only calls something an item when it has a field-1
        // sub-message, and that is the same field this reads.
        impossible("an item message reached decodeTree with no geometry field");
      }

      const { p1, p2, height: heightNorm } = getPointsFromGeom(geom);
      if (p1 === null || p2 === null || heightNorm === null) {
        bump("item_unusable_geometry");
        return;
      }

      let [x1n, y1n] = p1;
      let [x2n, y2n] = p2;
      let x1 = x1n * W;
      let y1 = y1n * H;
      let x2 = x2n * W;
      let y2 = y2n * H;

      let dx = x2 - x1;
      let dy = y2 - y1;
      // Normalise baseline direction (left -> right, or top -> bottom).
      if (dx < 0 || (Math.abs(dx) < 1e-12 && dy < 0)) {
        [x1, y1, x2, y2] = [x2, y2, x1, y1];
        [x1n, y1n, x2n, y2n] = [x2n, y2n, x1n, y1n];
        dx = x2 - x1;
        dy = y2 - y1;
      }

      const length = Math.hypot(dx, dy);
      if (length <= 1e-12) {
        bump("item_degenerate_baseline");
        return;
      }

      const ux = dx / length;
      const uy = dy / length;
      const angleDeg = normalizeAngleDeg((Math.atan2(dy, dx) * 180) / Math.PI);
      const heightPx = heightNorm * H;

      const itemSpans = [];
      const itemRanges = [];
      let itemBounds = null;

      spansBytes.forEach((spanBytes, spanIndex) => {
        let { start, end, t0, t1 } = extractSpan(spanBytes);

        if (start === null) start = cursor;
        else cursor = Math.max(cursor, start);
        if (end === null) {
          bump("span_no_end");
          return;
        }
        cursor = Math.max(cursor, end);

        if (t0 === null && t1 === null) {
          bump("span_no_position");
          return;
        }
        if (t0 === null) t0 = 0;
        if (t1 === null) t1 = 1;

        const sliced = sliceText(chars, start, end);
        if (sliced === null) bump("span_text_out_of_range");
        const spanText = sliced === null ? "" : sliced;
        const validText = spanText.trim() !== "";
        if (validText) itemRanges.push([start, end]);

        // Span endpoints along the baseline.
        const e1x = x1 + ux * (t0 * length);
        const e1y = y1 + uy * (t0 * length);
        const e2x = x1 + ux * (t1 * length);
        const e2y = y1 + uy * (t1 * length);
        const scx = (e1x + e2x) / 2;
        const scy = (e1y + e2y) / 2;

        const widthPx = Math.abs(t1 - t0) * length;
        const leftPx = scx - widthPx / 2;
        const topPx = scy - heightPx / 2;
        const left = leftPx / W;
        const top = topPx / H;
        const width = widthPx / W;
        const height = heightPx / H;

        const spanNode = {
          side,
          para_index: paraIndex,
          item_index: itemIndex,
          span_index: spanIndex,
          start_raw: start,
          end_raw: end,
          t0_raw: t0,
          t1_raw: t1,
          height_raw: heightNorm,
          baseline_p1: { x: x1n, y: y1n },
          baseline_p2: { x: x2n, y: y2n },
          box: {
            left,
            top,
            width,
            height,
            rotation_deg: angleDeg,
            rotation_deg_css: angleDeg,
            center: { x: scx / W, y: scy / H },
            left_pct: left * 100,
            top_pct: top * 100,
            width_pct: width * 100,
            height_pct: height * 100,
          },
          text: spanText,
          valid_text: validText,
        };

        const quad = boxQuadPx(spanNode, W, H, 0);
        if (quad) {
          const xs = quad.map((p) => p[0]);
          const ys = quad.map((p) => p[1]);
          itemBounds = unionBounds(itemBounds, [
            Math.min(...xs),
            Math.min(...ys),
            Math.max(...xs),
            Math.max(...ys),
          ]);
        }
        itemSpans.push(spanNode);
      });

      const [s0, s1] = rangeMinMax(itemRanges);
      let itemText = "";
      if (s0 !== null) {
        // `itemRanges` only ever holds ranges that already sliced cleanly, and
        // [min start, max end] over those is still inside the text — so a null
        // here is a broken invariant, not bad input.
        const sliced = sliceText(chars, s0, s1);
        if (sliced === null) {
          impossible(`item range ${s0}..${s1} escaped a set of validated ranges`);
        }
        itemText = sliced.trim();
        paraRanges.push([s0, s1]);
      }

      const icx = (x1 + x2) / 2;
      const icy = (y1 + y2) / 2;
      const itemBox = {
        left: (icx - length / 2) / W,
        top: (icy - heightPx / 2) / H,
        width: length / W,
        height: heightPx / H,
        rotation_deg: angleDeg,
        rotation_deg_css: angleDeg,
        center: { x: icx / W, y: icy / H },
      };

      if (itemBounds !== null) paraBounds = unionBounds(paraBounds, itemBounds);

      items.push({
        side,
        para_index: paraIndex,
        item_index: itemIndex,
        start_raw: s0,
        end_raw: s1,
        text: itemText,
        valid_text: itemText.trim() !== "",
        height_raw: heightNorm,
        baseline_p1: { x: x1n, y: y1n },
        baseline_p2: { x: x2n, y: y2n },
        box: itemBox,
        bounds_px: itemBounds,
        spans: itemSpans,
      });
    });

    const [p0, p1r] = rangeMinMax(paraRanges);
    let paraText = "";
    if (p0 !== null) {
      const sliced = sliceText(chars, p0, p1r);
      if (sliced === null) {
        impossible(`paragraph range ${p0}..${p1r} escaped a set of validated ranges`);
      }
      paraText = sliced.trim();
    }

    paragraphs.push({
      side,
      para_index: paraIndex,
      start_raw: p0,
      end_raw: p1r,
      text: paraText,
      valid_text: paraText.trim() !== "",
      bounds_px: paraBounds,
      items,
    });
  });

  return { side, paragraphs, diagnostics };
}

/**
 * The drops worth telling somebody about, as human-readable lines.
 *
 * Empty list means nothing was dropped — which is the common case and is worth
 * being able to assert.
 */
export function treeWarnings(tree) {
  const diagnostics = tree && tree.diagnostics;
  if (!diagnostics) return [];
  const out = [];
  for (const [reason, count] of Object.entries(diagnostics.drops || {})) {
    if (count > 0) out.push(`dropped ${count} × ${reason}`);
  }
  if (diagnostics.deepWalkParagraphs > 0) {
    out.push(
      `${diagnostics.deepWalkParagraphs} paragraph(s) needed the deep item walk — ` +
        "Lens nested its items deeper than the shallow pass expects",
    );
  }
  if (diagnostics.exhaustedParagraphs > 0) {
    out.push(
      `${diagnostics.exhaustedParagraphs} paragraph(s) hit the 20,000-node walk budget — ` +
        "items past that point were NOT read",
    );
  }
  return out;
}

// Tree traversal helpers

/** `[index, paragraph]` pairs for a tree. */
export function iterParagraphs(tree) {
  if (!tree || typeof tree !== "object") return [];
  const out = [];
  (Array.isArray(tree.paragraphs) ? tree.paragraphs : []).forEach((p, i) => {
    if (p && typeof p === "object") out.push([i, p]);
  });
  return out;
}

/** Every span node across all paragraphs / items. */
export function flattenSpans(tree) {
  const spans = [];
  for (const [, p] of iterParagraphs(tree)) {
    for (const item of p.items || []) spans.push(...(item.spans || []));
  }
  return spans;
}

/**
 * One text string per paragraph.
 *
 * Prefers the paragraph's own `text`; if empty, joins its items' texts.
 */
export function paragraphTexts(tree) {
  return iterParagraphs(tree).map(([, p]) => {
    const text = String(p.text || "").trim();
    if (text) return text;
    return (p.items || [])
      .filter((it) => it && typeof it === "object" && String(it.text || "").trim())
      .map((it) => String(it.text || "").trim())
      .join(" ");
  });
}

/** `{paras, items, spans}` counts — used for debug logging. */
export function treeStats(tree) {
  let paras = 0;
  let items = 0;
  let spans = 0;
  for (const [, p] of iterParagraphs(tree)) {
    paras += 1;
    for (const item of p.items || []) {
      if (!item || typeof item !== "object") continue;
      items += 1;
      spans += (item.spans || []).length;
    }
  }
  return { paras, items, spans };
}
