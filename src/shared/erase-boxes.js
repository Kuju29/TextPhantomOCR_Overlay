/**
 * Serialise Lens text boxes so the canvas can erase them — client side.
 *
 *
 * Port of `api/backend/render/erase_boxes.py`, pinned to the same fixture
 * (`api/tests/fixtures/lens_tree.json`, asserted by `scripts/test-lens-tree.mjs`
 * and `api/tests/test_lens_tree.py`).
 *
 * The service worker decodes Lens itself now (`README.md#architecture-and-ownership`),
 * so it has to produce these boxes rather than receive them. Python keeps its
 * copy for `/v1/lens/fallback`, where the server did the Lens call.
 *
 * Schema `tp.erase-boxes/1`:
 *
 *     { "schema": "tp.erase-boxes/1", "boxes": [ {l, t, w, h, r?}, ... ] }
 *
 * `l/t/w/h` are normalised to the image size (0..1) and `r` is the box's
 * rotation in degrees about its own centre — the same numbers
 * `erase-canvas.js` consumes, so the client reconstructs exactly the quad the
 * server would have erased.
 */

export const ERASE_BOXES_SCHEMA = "tp.erase-boxes/1";

// Normalised coordinates only ever need this much precision: at 5 decimals one
// unit is 0.01 px on a 1000 px page. Rounding here is what keeps the payload
// small — full float repr roughly triples it.
const PRECISION = 5;

// Boxes thinner than this in normalised units are Lens noise (stray marks,
// single-pixel artefacts). Painting them costs a canvas op and achieves
// nothing visible.
const MIN_SIDE = 1e-4;

function round5(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** PRECISION;
  return Math.round(n * scale) / scale;
}

/**
 * One token's box, or null when it carries no usable geometry.
 *
 * Nothing here substitutes a default for a missing number. A box at 0,0 with
 * the right size is not "close enough" — it paints a rectangle over the corner
 * of the page and leaves the real text showing.
 */
export function boxPayload(token) {
  const box = token?.box;
  if (!box || typeof box !== "object") return null;

  const w = round5(box.width);
  const h = round5(box.height);
  if (w === null || h === null) return null;
  if (w <= MIN_SIDE || h <= MIN_SIDE) return null;

  const l = round5(box.left);
  const t = round5(box.top);
  if (l === null || t === null) return null;

  const out = { l, t, w, h };

  // Rotation genuinely defaults: an upright box omits it, and "unset" and "0°"
  // are the same intent. A present-but-unreadable rotation is not the same
  // thing, and drops the box.
  if (box.rotation_deg !== undefined) {
    const r = round5(box.rotation_deg);
    if (r === null) return null;
    // Omit the common case rather than repeat "r": 0 on every box.
    if (r) out.r = r;
  }
  return out;
}

/**
 * Build the `tp.erase-boxes/1` payload for `tokens`.
 *
 * Tokens without geometry are dropped, and the count of dropped tokens is
 * reported: a page where most tokens were unusable is a page whose background
 * will look wrong, and that must be visible rather than inferred from a
 * suspiciously short box list.
 */
export function buildEraseBoxes(tokens, { ownerForToken = null } = {}) {
  const boxes = [];
  let skipped = 0;
  for (const token of Array.isArray(tokens) ? tokens : []) {
    const payload = token && typeof token === "object" ? boxPayload(token) : null;
    if (payload === null) {
      skipped += 1;
      continue;
    }
    if (typeof ownerForToken === "function") {
      const owner = ownerForToken(token);
      if (typeof owner === "string" && owner) payload.p = owner;
    }
    boxes.push(payload);
  }

  const out = { schema: ERASE_BOXES_SCHEMA, boxes };
  if (skipped) out.skipped = skipped;
  return out;
}

export function eraseBoxesForAiPartial(doc, eraseBoxes) {
  const boxes = Array.isArray(eraseBoxes?.boxes) ? eraseBoxes.boxes : null;
  if (!boxes || eraseBoxes?.schema !== ERASE_BOXES_SCHEMA) {
    return { ok: false, reason: "partial AI erase geometry has no supported box list" };
  }
  const paragraphs = Array.isArray(doc?.paragraphs) ? doc.paragraphs : [];
  const known = new Set(paragraphs.map((p) => String(p?.id || "")).filter(Boolean));
  const replaced = new Set();
  for (const para of paragraphs) {
    if (!String(para?.aiText || "").trim()) continue;
    const ids = Array.isArray(para?.aiGroupParagraphIds) && para.aiGroupParagraphIds.length
      ? para.aiGroupParagraphIds.map(String)
      : [String(para?.id || "")];
    for (const id of ids) {
      if (!known.has(id)) {
        return { ok: false, reason: `partial AI group names unknown paragraph ${JSON.stringify(id)}` };
      }
      replaced.add(id);
    }
  }
  if (!replaced.size) return { ok: false, reason: "partial AI has no replacement paragraph" };
  for (const box of boxes) {
    if (typeof box?.p !== "string" || !known.has(box.p)) {
      return { ok: false, reason: "partial AI erase ownership is missing or ambiguous" };
    }
  }
  return {
    ok: true,
    eraseBoxes: { ...eraseBoxes, boxes: boxes.filter((box) => replaced.has(box.p)) },
    replacedParagraphIds: [...replaced],
  };
}
