/**
 * Which way does this text read — across, or down?
 *
 *
 * Port of `classify_item_axis` / `paragraph_reading_axis` in
 * `api/backend/render/region.py`, pinned to the same fixture
 * (`api/tests/fixtures/lens_tree.json`).
 *
 * The service worker decides whether a page needs `/v1/groups`; the criterion
 * is the same in every mode —
 * **is the text vertical**. Not source-axis versus target-axis; `groups.py:398`
 * cuts on `_para_axis(para) != "v"` and nothing else. A horizontal page skips
 * ONNX entirely and goes straight to layout, which is ~450 ms per page not
 * spent.
 *
 * This reads TREE items (`box.rotation_deg`), the same shape Python reads, not
 * `tp.lens-document/1` items. Same numbers, same rule, one fixture.
 */

/** Thrown when an item carries no rotation this can trust. */
export class LensAxisError extends Error {}

/** Off the 0/90 grid by more than this and the text is decorative, not typeset. */
export const DEFAULT_TILT_TOL = 12.0;

/**
 * The rotation of one box, in degrees.
 *
 * Reads `rotation_deg`. `rotation_deg_css` is used ONLY when `rotation_deg` is
 * absent — not when it is zero.
 *
 * Python spelled this `box.get("rotation_deg") or box.get("rotation_deg_css")
 * or 0.0`, which falls through on a rotation of exactly 0 and silently answers
 * with the OTHER key. The two are written together everywhere today, so
 * nothing is currently wrong; the failure it sets up is that the day they
 * diverge, an upright box reports the css value and a whole page picks the
 * wrong reading axis — which surfaces as "ONNX ran on a horizontal page", four
 * files away from the lookup that caused it.
 *
 * Absent from BOTH is 0°: an upright box legitimately omits the field, and
 * "unset" and "0°" are the same intent. A present-but-unreadable value is not,
 * and throws.
 */
export function boxRotationDeg(box) {
  const source = box && typeof box === "object" ? box : {};
  const key = "rotation_deg" in source ? "rotation_deg" : "rotation_deg_css";
  if (!(key in source)) return 0;
  const value = Number(source[key]);
  if (!Number.isFinite(value)) {
    throw new LensAxisError(`box.${key} is not a number: ${JSON.stringify(source[key])}`);
  }
  return value;
}

/**
 * Classify one item's reading axis from its baseline rotation.
 *
 * Returns "h" (baseline ~0°), "v" (baseline ~±90°), or "tilted" (off the 0/90
 * grid by more than `tiltTol` — a decorative / perspective label that must keep
 * its angle and must never be auto-rotated).
 *
 * Sign-insensitive for the vertical case, so the unstable ±90 sign never
 * matters.
 */
export function classifyItemAxis(item, tiltTol = DEFAULT_TILT_TOL) {
  const rot = boxRotationDeg(item?.box);
  // JS `%` keeps the sign of the dividend; Python's does not. `mod` below is
  // Python's, which is what the residual and the fold below both assume.
  const residual = mod(rot + 45, 90) - 45;
  if (Math.abs(residual) > tiltTol) return "tilted";
  let r = mod(rot, 180);
  if (r > 90) r -= 180;
  return Math.abs(r) > 45 ? "v" : "h";
}

/** Python's `%`: the result takes the sign of the divisor. */
function mod(a, n) {
  return ((a % n) + n) % n;
}

/**
 * Majority reading axis of a paragraph's text items.
 *
 * Tilted items are excluded from the vote. Returns "h", "v", or "tilted" — the
 * last only when every text item is tilted.
 *
 * A paragraph with no text at all answers "h", which is the Python behaviour
 * and is a real answer rather than a cover-up: there is nothing to lay out
 * vertically, and "h" is the branch that does no extra work.
 */
export function paragraphReadingAxis(items, tiltTol = DEFAULT_TILT_TOL) {
  let nH = 0;
  let nV = 0;
  let nT = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (!String(item?.text || "").trim()) continue;
    const axis = classifyItemAxis(item, tiltTol);
    if (axis === "v") nV += 1;
    else if (axis === "h") nH += 1;
    else nT += 1;
  }
  if (nH === 0 && nV === 0) return nT ? "tilted" : "h";
  return nV >= nH ? "v" : "h";
}

/** The reading axis of every paragraph in a tree, in order. */
export function paragraphAxes(tree, tiltTol = DEFAULT_TILT_TOL) {
  return (tree?.paragraphs || []).map((para) => paragraphReadingAxis(para?.items, tiltTol));
}

/**
 * Does this page need `/v1/groups` — the ONNX + paragraph-merge pass?
 *
 * Only vertical pages do. Lens splits ONE vertical Japanese sentence into a
 * paragraph per column; without the merge the AI is handed those columns
 * separately and translates sentence fragments, which comes out unreadable.
 * Horizontal text is never split that way, so the pass would cost ~450 ms and
 * change nothing.
 *
 * Returns the verdict WITH its evidence. A bare boolean would make "this page
 * is horizontal" and "this page had no text to classify" the same answer, and
 * the second one is worth noticing — it means the decode came back empty.
 */
export function pageNeedsGroups(tree, tiltTol = DEFAULT_TILT_TOL) {
  const axes = paragraphAxes(tree, tiltTol);
  const counts = { h: 0, v: 0, tilted: 0 };
  for (const axis of axes) counts[axis] += 1;

  // Decide at PAGE level. A horizontal page may legitimately contain one
  // vertical title, side label or decorative caption; that isolated paragraph
  // is not evidence that Lens split the page into vertical reading columns.
  // Only non-empty paragraphs with at least one non-tilted text item vote.
  // This deliberately uses paragraph votes (rather than raw item count or
  // character length): Lens item fragmentation and title length are provider
  // details and must not be allowed to overturn the page's dominant layout.
  const votes = { h: 0, v: 0 };
  const itemCounts = { h: 0, v: 0, tilted: 0 };
  const textChars = { h: 0, v: 0, tilted: 0 };
  for (const [index, para] of (tree?.paragraphs || []).entries()) {
    let classifiableItems = 0;
    for (const item of Array.isArray(para?.items) ? para.items : []) {
      const text = String(item?.text || "").trim();
      if (!text) continue;
      const itemAxis = classifyItemAxis(item, tiltTol);
      itemCounts[itemAxis] += 1;
      textChars[itemAxis] += Array.from(text).length;
      if (itemAxis !== "tilted") classifiableItems += 1;
    }
    if (classifiableItems > 0) votes[axes[index]] += 1;
  }

  const classifiableParagraphs = votes.h + votes.v;
  const horizontalRatio = classifiableParagraphs > 0 ? votes.h / classifiableParagraphs : 0;
  const verticalRatio = classifiableParagraphs > 0 ? votes.v / classifiableParagraphs : 0;
  // A tie is intentionally horizontal/conservative: ONNX grouping changes
  // paragraph membership, so mixed evidence must not trigger it without a
  // page-wide vertical majority.
  const needed = votes.v > votes.h;
  return {
    needed,
    axes,
    counts,
    votes,
    classifiableParagraphs,
    ratios: { h: horizontalRatio, v: verticalRatio },
    itemCounts,
    textChars,
    reason: classifiableParagraphs === 0
      ? axes.length === 0
        ? "the page has no paragraphs"
        : "the page has no classifiable text paragraphs (tilted/empty only)"
      : needed
        ? `page is vertical-majority: ${votes.v}/${classifiableParagraphs} ` +
          `classifiable paragraph(s) (${(verticalRatio * 100).toFixed(1)}%)`
        : votes.v === votes.h
          ? `page axis is tied ${votes.v}:${votes.h}; conservatively skipping ONNX grouping`
          : `page is horizontal-majority: ${votes.h}/${classifiableParagraphs} ` +
            `classifiable paragraph(s) (${(horizontalRatio * 100).toFixed(1)}%); ` +
            `${votes.v} vertical paragraph(s) treated as local title/label evidence`,
  };
}

/**
 * Describe the target-axis relayout the extension must perform for AI text.
 *
 * API ownership stops after Lens upload, vertical ONNX grouping and AI text
 * translation. Target rows/columns are built by the extension renderer from
 * the source item AABBs plus explicit semantic membership, so an axis change
 * is no longer a reason to re-run the entire image through `/v1/translate`.
 *
 * Returns the decision with its evidence so orchestration can put the exact
 * fallback reason in the trace.  An empty/unclassifiable document does not
 * claim a direction change; the normal fidelity guard handles that case.
 */
export function aiLayoutDecision(document, targetLang, tiltTol = DEFAULT_TILT_TOL) {
  let horizontal = 0;
  let vertical = 0;
  for (const para of document?.paragraphs || []) {
    for (const item of para?.items || []) {
      if (!String(item?.text || "").trim()) continue;
      const rotation = Number(item?.rotation ?? 0);
      if (!Number.isFinite(rotation)) continue;
      const residual = mod(rotation + 45, 90) - 45;
      if (Math.abs(residual) > tiltTol) continue;
      let folded = mod(rotation, 180);
      if (folded > 90) folded -= 180;
      if (Math.abs(folded) > 45) vertical += 1;
      else horizontal += 1;
    }
  }

  const axisItems = horizontal + vertical;
  const sourceOrientation = axisItems > 0 && vertical * 2 >= axisItems ? "v" : "h";
  const lang = String(targetLang || "").trim().toLowerCase().replaceAll("_", "-");
  const primary = lang.split("-", 1)[0];
  // Matches backend.render.relayout.target_orientation_for_lang: Japanese and
  // Chinese manga targets are vertical; every other target is horizontal.
  const targetOrientation = primary === "ja" || primary === "zh" ? "v" : "h";
  const requiresRelayout = axisItems > 0 && sourceOrientation !== targetOrientation;
  return {
    // Retained for callers/log readers during the schema transition. Full
    // server rendering is forbidden for AI; only the text-only API is used.
    needsServer: false,
    requiresRelayout,
    sourceOrientation,
    targetOrientation,
    axisItems,
    horizontalItems: horizontal,
    verticalItems: vertical,
    reason: axisItems <= 0
      ? "no classifiable text geometry"
      : requiresRelayout
        ? `extension relayouts AI ${sourceOrientation}->${targetOrientation}`
        : `extension preserves AI ${targetOrientation} axis`,
  };
}
