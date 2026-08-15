/**
 *
 * The `tp.lens-document/1` schema, client side.
 *
 * This is the same structure `api/backend/lens/document.py` produces, and the
 * two are pinned to a shared fixture (`scripts/test-lens-document.mjs` and
 * `api/tests/test_lens_document.py`) because a schema that both sides
 * implement from a written spec drifts within a release or two.
 *
 * Its job is to be the ONLY thing that knows what Google's Lens response looks
 * like. Everything downstream — the renderer, the AI patcher, the erase step —
 * reads this instead, so a change on Google's side lands in one adapter rather
 * than in five consumers at once.
 *
 * Coordinates are normalised 0..1 against the image, so a document stays valid
 * when the browser displays the picture at CSS size rather than natural size.
 */

import { normalizeAiUnitText } from "./ai-markers.js";

export const LENS_DOCUMENT_SCHEMA = "tp.lens-document/1";

// Hard local-consumption budgets. Normal manga pages are two orders of
// magnitude smaller; these limits exist to keep a malformed/crafted wire
// document from turning one response into tens of thousands of DOM nodes.
export const LENS_DOCUMENT_LIMITS = Object.freeze({
  paragraphs: 2000,
  groups: 2000,
  itemsPerParagraphLayer: 256,
  totalItems: 8000,
  spansPerItem: 256,
  totalSpans: 16000,
  membersPerGroup: 256,
  totalGroupMemberships: 8000,
  estimatedDomNodes: 20000,
});

/** Thrown when a document cannot be trusted. Never returns a partial doc. */
export class LensDocumentError extends Error {}

/**
 * Validate the hand-off from a Lens-only server request to local AI.
 *
 * An older API may answer the rewritten `source=original` request with only
 * Original HTML.  Treating that as an empty document makes the AI stage look
 * successfully skipped and silently delivers the wrong layer.
 */
export function requireAiLensDocument(result) {
  const doc = result?.lensDocument;
  if (!doc || !Array.isArray(doc.paragraphs)) {
    throw new LensDocumentError(
      "AI text-only route received no LensDocument; refusing to accept an Original/Translated result as AI",
    );
  }
  return doc;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value) {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
}

function assertUniqueParagraphIds(paragraphs) {
  const seen = new Set();
  for (let index = 0; index < paragraphs.length; index++) {
    const id = String(paragraphs[index]?.id || "");
    if (!id) continue; // the existing structural validator reports missing IDs
    if (seen.has(id)) {
      throw new LensDocumentError(`duplicate paragraph id ${JSON.stringify(id)} at paragraph ${index}`);
    }
    seen.add(id);
  }
}

function assertDisjointGroupMemberships(groups, memberKey) {
  const owner = new Map();
  groups.forEach((group, groupIndex) => {
    const local = new Set();
    const members = Array.isArray(group?.[memberKey]) ? group[memberKey] : [];
    for (const rawMember of members) {
      const member = String(rawMember);
      if (local.has(member)) {
        throw new LensDocumentError(
          `group ${groupIndex} contains duplicate paragraph membership ${JSON.stringify(member)}`,
        );
      }
      local.add(member);
      if (owner.has(member)) {
        throw new LensDocumentError(
          `paragraph ${JSON.stringify(member)} belongs to both group ${owner.get(member)} and group ${groupIndex}`,
        );
      }
      owner.set(member, groupIndex);
    }
  });
}

/** Empty string when safe; otherwise a stable reason suitable for fallback logs. */
export function documentCardinalityReason(doc) {
  if (doc?.paragraphs !== undefined && !Array.isArray(doc.paragraphs)) {
    return "paragraphs is not an array";
  }
  if (doc?.groups !== undefined && !Array.isArray(doc.groups)) {
    return "groups is not an array";
  }
  const paragraphs = doc?.paragraphs || [];
  const groups = doc?.groups || [];
  if (paragraphs.length > LENS_DOCUMENT_LIMITS.paragraphs) {
    return `${paragraphs.length} paragraphs exceeds ${LENS_DOCUMENT_LIMITS.paragraphs}`;
  }
  if (groups.length > LENS_DOCUMENT_LIMITS.groups) {
    return `${groups.length} groups exceeds ${LENS_DOCUMENT_LIMITS.groups}`;
  }

  let totalItems = 0;
  let totalSpans = 0;
  let aiGroupMemberships = 0;
  // root + scope + one source wrapper and at most one hidden translation
  // target per paragraph/group. Layer lines are counted below.
  let estimatedDomNodes = 2 + paragraphs.length * 2 + groups.length;
  for (const para of paragraphs) {
    for (const key of ["items", "lensItems", "aiItems"]) {
      if (para?.[key] !== undefined && !Array.isArray(para[key])) {
        return `${key} in paragraph ${para?.id || "?"} is not an array`;
      }
      const items = para?.[key] || [];
      if (items.length > LENS_DOCUMENT_LIMITS.itemsPerParagraphLayer) {
        return `${key} in paragraph ${para?.id || "?"} has ${items.length} items ` +
          `(max ${LENS_DOCUMENT_LIMITS.itemsPerParagraphLayer})`;
      }
      totalItems += items.length;
      if (totalItems > LENS_DOCUMENT_LIMITS.totalItems) {
        return `${totalItems} total items exceeds ${LENS_DOCUMENT_LIMITS.totalItems}`;
      }
      for (const item of items) {
        if (item?.spans !== undefined && !Array.isArray(item.spans)) {
          return `spans in item ${item?.id || "?"} is not an array`;
        }
        const spans = item?.spans || [];
        if (spans.length > LENS_DOCUMENT_LIMITS.spansPerItem) {
          return `item ${item?.id || "?"} has ${spans.length} spans ` +
            `(max ${LENS_DOCUMENT_LIMITS.spansPerItem})`;
        }
        totalSpans += spans.length;
        if (totalSpans > LENS_DOCUMENT_LIMITS.totalSpans) {
          return `${totalSpans} total spans exceeds ${LENS_DOCUMENT_LIMITS.totalSpans}`;
        }
        estimatedDomNodes += Math.max(1, spans.length);
        if (estimatedDomNodes > LENS_DOCUMENT_LIMITS.estimatedDomNodes) {
          return `estimated ${estimatedDomNodes} DOM nodes exceeds ` +
            `${LENS_DOCUMENT_LIMITS.estimatedDomNodes}`;
        }
      }
    }
    if (para?.aiGroupParagraphIds !== undefined && !Array.isArray(para.aiGroupParagraphIds)) {
      return `aiGroupParagraphIds in paragraph ${para?.id || "?"} is not an array`;
    }
    const aiMembers = para?.aiGroupParagraphIds || [];
    if (aiMembers.length > LENS_DOCUMENT_LIMITS.membersPerGroup) {
      return `AI group in paragraph ${para?.id || "?"} has ${aiMembers.length} members ` +
        `(max ${LENS_DOCUMENT_LIMITS.membersPerGroup})`;
    }
    aiGroupMemberships += aiMembers.length;
    if (aiGroupMemberships > LENS_DOCUMENT_LIMITS.totalGroupMemberships) {
      return `${aiGroupMemberships} total AI group memberships exceeds ` +
        `${LENS_DOCUMENT_LIMITS.totalGroupMemberships}`;
    }
  }

  let memberships = 0;
  for (const group of groups) {
    if (group?.paragraphIds !== undefined && !Array.isArray(group.paragraphIds)) {
      return `paragraphIds in group ${group?.id || "?"} is not an array`;
    }
    const members = group?.paragraphIds || [];
    if (members.length > LENS_DOCUMENT_LIMITS.membersPerGroup) {
      return `group ${group?.id || "?"} has ${members.length} members ` +
        `(max ${LENS_DOCUMENT_LIMITS.membersPerGroup})`;
    }
    memberships += members.length;
    if (memberships > LENS_DOCUMENT_LIMITS.totalGroupMemberships) {
      return `${memberships} total group memberships exceeds ` +
        `${LENS_DOCUMENT_LIMITS.totalGroupMemberships}`;
    }
  }
  return "";
}

/**
 * Validate a document received over the wire.
 *
 * Throws rather than repairing. A document with, say, half its baselines
 * missing still renders — as a page with half its text in the wrong place,
 * which reads as a rendering bug for as long as anyone cares to look. Refusing
 * it puts the failure where it happened.
 */
export function validateLensDocument(doc) {
  if (!doc || typeof doc !== "object") {
    throw new LensDocumentError("lens document is not an object");
  }
  if (doc.schema !== LENS_DOCUMENT_SCHEMA) {
    throw new LensDocumentError(
      `unsupported schema ${JSON.stringify(doc.schema)}; this build speaks ${LENS_DOCUMENT_SCHEMA}`,
    );
  }
  const w = Number(doc.image?.width);
  const h = Number(doc.image?.height);
  if (!(w > 0) || !(h > 0)) {
    throw new LensDocumentError(`lens document has no usable image size (${w}x${h})`);
  }
  if (!Array.isArray(doc.paragraphs)) {
    throw new LensDocumentError("lens document has no paragraphs array");
  }
  const cardinalityReason = documentCardinalityReason(doc);
  if (cardinalityReason) {
    throw new LensDocumentError(`lens document exceeds local render budget: ${cardinalityReason}`);
  }

  assertUniqueParagraphIds(doc.paragraphs);

  doc.paragraphs.forEach((para, index) => {
    if (!para || typeof para !== "object") {
      throw new LensDocumentError(`paragraph ${index} is not an object`);
    }
    if (!para.id) throw new LensDocumentError(`paragraph ${index} has no id`);
    if (!Array.isArray(para.items)) {
      throw new LensDocumentError(`paragraph ${para.id} has no items array`);
    }
    // `lensItems` / `aiItems` are the translated and AI layers' OWN lines.
    // Optional — a document built before the AI finished has no `aiItems`, and
    // a page Lens could not machine-translate has no `lensItems` — but when
    // present they are held to exactly the same standard as `items`, because
    // they are drawn by the same code.
    for (const key of ["items", "lensItems", "aiItems"]) {
      const list = para[key];
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        throw new LensDocumentError(`paragraph ${para.id} has a non-array ${key}`);
      }
      for (const item of list) {
        if (!isPoint(item?.baseline?.[0]) || !isPoint(item?.baseline?.[1])) {
          throw new LensDocumentError(
            `item ${item?.id || "?"} in ${key} has a malformed baseline`,
          );
        }
        if (!isFiniteNumber(item.height) || item.height <= 0) {
          throw new LensDocumentError(`item ${item?.id || "?"} in ${key} has a non-positive height`);
        }
        if (item.spans !== undefined) {
          if (!Array.isArray(item.spans)) {
            throw new LensDocumentError(`item ${item?.id || "?"} in ${key} has non-array spans`);
          }
          for (const span of item.spans) {
            if (
              !isFiniteNumber(span?.t0) || !isFiniteNumber(span?.t1) ||
              span.t0 < 0 || span.t1 > 1 || !(span.t1 > span.t0)
            ) {
              throw new LensDocumentError(`item ${item?.id || "?"} in ${key} has a malformed span`);
            }
          }
        }
      }
    }
  });

  if (doc.groups !== undefined) {
    if (!Array.isArray(doc.groups)) {
      throw new LensDocumentError("lens document has non-array groups");
    }
    assertDisjointGroupMemberships(doc.groups, "paragraphIds");
    for (const group of doc.groups) {
      if (group?.boundsPx === undefined) continue;
      const bounds = group.boundsPx;
      if (
        !Array.isArray(bounds) || bounds.length !== 4 ||
        !bounds.every(isFiniteNumber) ||
        bounds[0] < 0 || bounds[1] < 0 || bounds[2] > w || bounds[3] > h ||
        !(bounds[2] > bounds[0]) || !(bounds[3] > bounds[1])
      ) {
        throw new LensDocumentError(`group ${group?.id || "?"} has malformed boundsPx`);
      }
    }
  }

  return doc;
}

/** Warnings the producer attached — surfaced, never dropped. */
export function documentWarnings(doc) {
  return Array.isArray(doc?.warnings) ? doc.warnings : [];
}

// --- Building one, client side ----------------------------------------------
//
// Port of `build` in `api/backend/lens/document.py`, pinned to the same fixture
// (`api/tests/fixtures/lens_tree.json`). The service worker decodes Lens itself
// now (`README.md#architecture-and-ownership`), so it has to produce this
// structure, not only read it.

// 5 decimals ≈ 0.01 px on a 1000 px page: below what any renderer can act on,
// and roughly a third of the payload of full float repr.
const PRECISION = 5;

function round5(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** PRECISION;
  // `Math.round` on the scaled value matches Python's `round()` for every
  // magnitude Lens produces (all well inside 0..1 after normalisation).
  return Math.round(n * scale) / scale;
}

function point(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!("x" in raw) || !("y" in raw)) return null;
  const x = round5(raw.x);
  const y = round5(raw.y);
  // A non-finite coordinate is not a point at 0,0. Saying so here keeps the
  // item out of the document instead of pinning it to the page corner.
  if (x === null || y === null) return null;
  return [x, y];
}

/**
 * One baseline segment, or null when its geometry is unusable.
 *
 * A paragraph is a polyline: each item carries its own straight baseline, so
 * curved text is approximated by several items at slightly different angles.
 * Dropping an item silently would shorten a line of text without any error, so
 * callers are told how many were dropped (see `buildLensDocument`).
 */
function buildItem(paraId, index, raw) {
  const p1 = point(raw?.baseline_p1);
  const p2 = point(raw?.baseline_p2);
  if (p1 === null || p2 === null) return null;

  const height = round5(raw?.height_raw);
  if (height === null || height <= 0) return null;

  const box = raw?.box && typeof raw.box === "object" ? raw.box : {};
  // Rotation genuinely defaults: an upright box omits it, and "unset" and "0°"
  // are the same intent.
  const rotation = box.rotation_deg === undefined ? 0 : round5(box.rotation_deg);
  if (rotation === null) return null;

  const spans = [];
  for (const rawSpan of Array.isArray(raw?.spans) ? raw.spans : []) {
    const rawT0 = round5(rawSpan?.t0_raw);
    const rawT1 = round5(rawSpan?.t1_raw);
    if (rawT0 === null || rawT1 === null) continue;
    const t0 = Math.max(0, Math.min(1, rawT0));
    const t1 = Math.max(0, Math.min(1, rawT1));
    if (!(t1 > t0)) continue;
    spans.push({ text: String(rawSpan?.text || ""), t0, t1 });
  }

  const item = {
    id: `${paraId}-i${index}`,
    baseline: [p1, p2],
    height,
    rotation,
    text: String(raw?.text || ""),
  };
  if (spans.length) item.spans = spans;
  return item;
}

/** Every usable item of one paragraph, and how many were unusable. */
function buildItems(paraId, rawItems, layer = "") {
  const out = [];
  let dropped = 0;
  const prefix = `${paraId}${layer}`;
  (Array.isArray(rawItems) ? rawItems : []).forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      dropped += 1;
      return;
    }
    const item = buildItem(prefix, index, raw);
    if (item === null) {
      dropped += 1;
      return;
    }
    out.push(item);
  });
  return { items: out, dropped };
}

/**
 * Build a `tp.lens-document/1` from the decoded Lens trees.
 *
 * `translatedTree` supplies Lens's own machine translation per paragraph. It is
 * matched by POSITION, which is what Lens itself guarantees: paragraph *n* of
 * the translated tree is paragraph *n* of the original. When the two trees
 * disagree in length that assumption has broken, and the mismatch is reported
 * rather than papered over — a document whose `lensText` is silently offset by
 * one would mistranslate the whole page.
 */
export function buildLensDocument(
  originalTree,
  translatedTree,
  { width, height, sourceLang = "", targetLang = "" } = {},
) {
  if (!(Number(width) > 0) || !(Number(height) > 0)) {
    throw new LensDocumentError(
      `a lens document needs the image size (got ${width}x${height}); ` +
        "Lens geometry is normalised against it, so it cannot be inferred here",
    );
  }

  const paragraphs = [];
  let droppedItems = 0;

  const originalParas = originalTree?.paragraphs || [];
  const translatedParas = translatedTree?.paragraphs || [];

  originalParas.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const paraId = `p${index}`;

    const own = buildItems(paraId, raw.items);
    droppedItems += own.dropped;

    // The TRANSLATED layer's own lines, not just its concatenated string.
    // A translation does not break where the source did, so the original
    // layer's items cannot stand in for it.
    let lensText = "";
    let lensItems = [];
    const translatedRaw = translatedParas[index];
    if (translatedRaw && typeof translatedRaw === "object") {
      lensText = String(translatedRaw.text || "");
      const built = buildItems(paraId, translatedRaw.items, "t");
      lensItems = built.items;
      droppedItems += built.dropped;
    }

    paragraphs.push({
      id: paraId,
      sourceText: String(raw.text || ""),
      lensText,
      items: own.items,
      lensItems,
      // Does this paragraph sit on a DARK background? Set upstream, on the
      // server path only — this route has no erased image to sample, so the
      // honest answer here is false rather than a guess.
      textLight: Boolean(raw.text_light),
    });
  });

  const document = {
    schema: LENS_DOCUMENT_SCHEMA,
    image: { width: Number(width), height: Number(height) },
    languages: { source: sourceLang || "", target: targetLang || "" },
    paragraphs,
  };

  const warnings = [];
  if (droppedItems) warnings.push(`dropped ${droppedItems} item(s) with unusable geometry`);
  if (translatedParas.length && translatedParas.length !== originalParas.length) {
    warnings.push(
      `paragraph count mismatch: original=${originalParas.length} ` +
        `translated=${translatedParas.length} — lensText may be misaligned`,
    );
  }
  if (warnings.length) document.warnings = warnings;

  return document;
}

// --- Bubble groups ----------------------------------------------------------
//
// Lens splits ONE vertical Japanese sentence into a paragraph per column.
// `/v1/groups` says which columns belong together; this is where that answer
// lives on the document.
//
// It is a SEPARATE list, not a rewrite of `paragraphs`. Collapsing the
// paragraphs would make `translationUnits` free, and would also destroy the
// `original` layer: a reader who asked for the source text must still see
// eleven Japanese columns where the page has eleven Japanese columns, not one
// block of text in a made-up box. The merge is a fact about TRANSLATION UNITS,
// so it is recorded as one.

/**
 * Attach `/v1/groups`' answer to a document.
 *
 * `bubbleGroups` is the server's `bubble_groups`: each entry has
 * `para_indices` (positions in the tree, which are the document's paragraph
 * order) and the merged `text`.
 *
 * Throws on an index the document does not have. A group pointing at a
 * paragraph that is not there means the tree that was sent and the document
 * that was built have come apart, and every unit after it would be attributed
 * to the wrong bubble — a page mistranslated in a way that still reads as a
 * translation.
 */
export function attachBubbleGroups(doc, bubbleGroups) {
  if (!doc || typeof doc !== "object") {
    throw new LensDocumentError("cannot attach groups to a non-document");
  }
  const paragraphs = Array.isArray(doc.paragraphs) ? doc.paragraphs : [];
  assertUniqueParagraphIds(paragraphs);
  const existingReason = documentCardinalityReason(doc);
  if (existingReason) {
    throw new LensDocumentError(`lens document exceeds local render budget: ${existingReason}`);
  }
  if (bubbleGroups !== undefined && !Array.isArray(bubbleGroups)) {
    throw new LensDocumentError("bubble groups must be an array");
  }
  const rawGroups = bubbleGroups || [];
  if (rawGroups.length > LENS_DOCUMENT_LIMITS.groups) {
    throw new LensDocumentError(
      `bubble groups exceed local render budget: ${rawGroups.length} groups ` +
        `(max ${LENS_DOCUMENT_LIMITS.groups})`,
    );
  }
  let rawMemberships = 0;
  for (const raw of rawGroups) {
    if (raw?.para_indices !== undefined && !Array.isArray(raw.para_indices)) {
      throw new LensDocumentError("bubble group para_indices must be an array");
    }
    const count = (raw?.para_indices || []).length;
    if (count > LENS_DOCUMENT_LIMITS.membersPerGroup) {
      throw new LensDocumentError(
        `bubble group has ${count} members (max ${LENS_DOCUMENT_LIMITS.membersPerGroup})`,
      );
    }
    rawMemberships += count;
    if (rawMemberships > LENS_DOCUMENT_LIMITS.totalGroupMemberships) {
      throw new LensDocumentError(
        `bubble groups have ${rawMemberships} memberships ` +
          `(max ${LENS_DOCUMENT_LIMITS.totalGroupMemberships})`,
      );
    }
  }
  const groups = [];
  const groupOwner = new Map();

  rawGroups.forEach((raw, index) => {
    const indices = Array.isArray(raw?.para_indices) ? raw.para_indices : [];
    const paragraphIds = indices.map((i) => {
      const para = paragraphs[Number(i)];
      if (!para) {
        throw new LensDocumentError(
          `bubble group ${index} names paragraph ${i}, which this document ` +
            `does not have (it has ${paragraphs.length})`,
        );
      }
      return String(para.id);
    });
    const localMembers = new Set();
    for (const paragraphId of paragraphIds) {
      if (localMembers.has(paragraphId)) {
        throw new LensDocumentError(
          `bubble group ${index} contains duplicate paragraph membership ${JSON.stringify(paragraphId)}`,
        );
      }
      localMembers.add(paragraphId);
      if (groupOwner.has(paragraphId)) {
        throw new LensDocumentError(
          `paragraph ${JSON.stringify(paragraphId)} belongs to both bubble group ` +
            `${groupOwner.get(paragraphId)} and bubble group ${index}`,
        );
      }
      groupOwner.set(paragraphId, index);
    }
    if (!paragraphIds.length) return; // a group with no members is not a unit
    const group = {
      id: `b${groups.length}`,
      paragraphIds,
      // The server's merged string. NOT rebuilt by joining `sourceText` here:
      // `_build_group` strips ruby (furigana) while joining, and a reading
      // glued to the word it annotates is not readable Japanese — the
      // translator answers with kana noise and the page looks like it was
      // translated into its own language.
      text: String(raw?.text || ""),
    };
    const direction = String(raw?.direction || "").toLowerCase();
    if (direction === "h" || direction === "v") group.direction = direction;
    const rotation = Number(raw?.rotation_deg);
    if (Number.isFinite(rotation)) group.rotation = rotation;
    const fontPx = Number(raw?.font_size_px);
    if (fontPx > 0) group.fontPx = fontPx;
    const bounds = raw?.bubble_bounds_px;
    if (
      Array.isArray(bounds) && bounds.length === 4 &&
      bounds.every((value) => Number.isFinite(Number(value))) &&
      Number(doc?.image?.width) > 0 && Number(doc?.image?.height) > 0
    ) {
      const width = Number(doc.image.width);
      const height = Number(doc.image.height);
      const clipped = [
        Math.max(0, Math.min(width, Number(bounds[0]))),
        Math.max(0, Math.min(height, Number(bounds[1]))),
        Math.max(0, Math.min(width, Number(bounds[2]))),
        Math.max(0, Math.min(height, Number(bounds[3]))),
      ];
      if (clipped[2] > clipped[0] && clipped[3] > clipped[1]) group.boundsPx = clipped;
    }
    groups.push(group);
  });

  const covered = new Set(groups.flatMap((g) => g.paragraphIds));
  const uncovered = paragraphs
    .filter((p) => String(p?.sourceText || "").trim() && !covered.has(String(p.id)))
    .map((p) => String(p.id));

  return { ...doc, groups, uncoveredParagraphIds: uncovered };
}

const LETTER_RE = /\p{L}/u;

// Returns whether a string holds prose a translator can act on, i.e. at least one letter.
export function hasTranslatableText(text) {
  return LETTER_RE.test(String(text || ""));
}

// Returns the document's text as addressable translation units, one per bubble group or paragraph.
// `translatable` is false for units Lens read as digits, punctuation or symbols only.
export function translationUnits(doc) {
  const units = [];
  const paragraphs = Array.isArray(doc?.paragraphs) ? doc.paragraphs : [];
  assertUniqueParagraphIds(paragraphs);
  const groups = Array.isArray(doc?.groups) ? doc.groups : null;
  if (groups) {
    assertDisjointGroupMemberships(groups, "paragraphIds");
    const position = new Map(paragraphs.map((p, index) => [String(p?.id), index]));
    const covered = new Set();
    const groupAt = new Map();

    // A group is anchored at its earliest paragraph on the page, but keeps
    // the server's member order. The latter is the reading order inside a
    // vertical utterance; sorting those ids would put its columns backwards.
    // Anchoring fixes a different ordering bug: the previous implementation
    // emitted EVERY group first and appended uncovered paragraphs afterwards,
    // so a caption between two bubbles moved to the end of the AI prompt.
    for (const group of groups) {
      const ids = (group?.paragraphIds || []).map(String);
      for (const id of ids) covered.add(id);
      const text = String(group?.text || "").trim();
      if (!text) continue;
      const anchors = ids.map((id) => position.get(id)).filter(Number.isInteger);
      if (!anchors.length) continue; // attachBubbleGroups normally makes this impossible
      groupAt.set(Math.min(...anchors), { text, paragraphIds: ids });
    }

    const uncovered = new Set((doc?.uncoveredParagraphIds || []).map(String));
    for (let index = 0; index < paragraphs.length; index++) {
      const grouped = groupAt.get(index);
      if (grouped) {
        units.push({ id: `g${units.length}`, ...grouped, translatable: hasTranslatableText(grouped.text) });
      }
      const para = paragraphs[index];
      const id = String(para?.id || "");
      if (covered.has(id) || !uncovered.has(id)) continue;
      const text = String(para?.sourceText || "").trim();
      if (!text) continue;
      units.push({ id: `g${units.length}`, text, paragraphIds: [String(id)], translatable: hasTranslatableText(text) });
    }
    return units;
  }
  for (const para of doc?.paragraphs || []) {
    const text = String(para?.sourceText || "").trim();
    if (!text) continue;
    units.push({ id: `g${units.length}`, text, paragraphIds: [String(para.id || "")], translatable: hasTranslatableText(text) });
  }
  return units;
}

/**
 * Write translations back onto the document.
 *
 * Returns a NEW document plus a report. The report is the point: a provider
 * that answered 18 of 20 units has half-translated the page, and the caller
 * must be able to tell that from a page that had 18 units to begin with.
 */
export function applyTranslations(doc, translations) {
  const byUnit = new Map();
  for (const t of translations || []) {
    const id = String(t?.id || "");
    if (id) byUnit.set(id, normalizeAiUnitText(t?.text));
  }

  const units = translationUnits(doc);
  const byParagraph = new Map();
  // A multi-paragraph unit is ONE sentence that Lens broke across columns. Its
  // translation belongs to the bubble, not to each column — writing it onto
  // every member would draw the whole sentence once per column, stacked on top
  // of itself. So one member carries the text and names the others, and the
  // renderer draws it once across their combined extent.
  const leaderOf = new Map();
  const membersOf = new Map();
  const missing = [];
  for (const unit of units) {
    if (!byUnit.has(unit.id)) {
      missing.push(unit.id);
      continue;
    }
    const ids = unit.paragraphIds.map(String);
    const [leader, ...rest] = ids;
    if (!leader) continue;
    byParagraph.set(leader, byUnit.get(unit.id));
    if (rest.length) {
      membersOf.set(leader, ids);
      for (const id of rest) leaderOf.set(id, leader);
    }
  }

  const next = {
    ...doc,
    paragraphs: (doc?.paragraphs || []).map((para) => {
      const id = String(para.id);
      if (byParagraph.has(id)) {
        const copy = { ...para, aiText: byParagraph.get(id) };
        // Only when there is more than one member. A lone paragraph must not
        // grow a group field, or "grouped" stops meaning anything.
        if (membersOf.has(id)) copy.aiGroupParagraphIds = membersOf.get(id);
        return copy;
      }
      if (leaderOf.has(id)) {
        // Covered by another paragraph's text. NOT "missing" — an explicit
        // pointer, so a renderer that skips it can say why, and a page short a
        // bubble is distinguishable from a bubble drawn somewhere else.
        return { ...para, aiCoveredBy: leaderOf.get(id) };
      }
      return { ...para };
    }),
  };

  return {
    document: next,
    report: {
      units: units.length,
      translated: units.length - missing.length,
      missing,
      // An unknown id means the provider invented a unit — worth knowing,
      // because it usually means the marker protocol lost sync.
      unknown: [...byUnit.keys()].filter((id) => !units.some((u) => u.id === id)),
    },
  };
}

/** Convert an applied AI report into the explicit caller-facing completion contract. */
export function classifyAiTranslationReport(report) {
  const translated = Math.max(0, Number(report?.translated) || 0);
  const missing = Array.isArray(report?.missing) ? report.missing.map(String) : [];
  return {
    usable: translated > 0,
    complete: translated > 0 && missing.length === 0,
    translated,
    missing,
    reason: translated > 0 ? "" : "AI returned no usable translations",
  };
}

/**
 * Whether this document can represent `source` FAITHFULLY.
 *
 * Lives here, not in the renderer, because the SERVICE WORKER needs to ask it
 * too — and the service worker has no DOM. That matters for the Lens-Direct
 * route: its result contains geometry and no server markup, so there is
 * nothing to fall back to once the page has it. The only safe moment to
 * discover the document is unrenderable is BEFORE committing to that route.
 *
 * Each layer draws from its OWN items, because a translation does not break
 * where the source did:
 *
 * - `original`   — `items`, Lens's source lines.
 * - `translated` — `lensItems`, Lens's own machine-translated lines.
 * - `ai`         — `aiItems`, the lines `build_ai_tree` laid the AI text into.
 *
 * A layer is renderable when every multi-line paragraph has that layer's
 * items. Single-line paragraphs need nothing extra: one line of text in one
 * box is the same answer either way.
 *
 * Until 2026-08-07 the document carried only `items` plus one string per
 * paragraph, so this returned false for every page with a multi-line bubble —
 * which is every page. Measured on a 37-page run: "1 to 12 paragraph(s) span
 * several lines" on every image, so the local renderer never once ran.
 */
const ITEMS_FOR_SOURCE = {
  original: "items",
  translated: "lensItems",
  ai: "aiItems",
};

export function canRenderFaithfully(doc, source) {
  const cardinalityReason = documentCardinalityReason(doc);
  if (cardinalityReason) {
    return {
      ok: false,
      reason: `lens document exceeds local render budget: ${cardinalityReason}`,
      refuseLocal: true,
    };
  }
  const key = ITEMS_FOR_SOURCE[String(source || "translated")];
  if (!key) return { ok: false, reason: `unknown source ${JSON.stringify(source)}` };
  if (key === "items") return { ok: true, reason: "" };

  const paragraphs = doc?.paragraphs || [];
  const missing = paragraphs.filter((p) => {
    if ((p?.items || []).length <= 1) return false;
    if ((p?.[key] || []).length > 0) return false;
    // Text AI intentionally returns one translation per Lens paragraph on the
    // horizontal path. It does not invent new line breaks: the renderer wraps
    // that one string inside the paragraph's combined source extent. This is
    // the planned representation, not an approximation and not missing
    // geometry. Requiring aiItems here erased the page and then refused to put
    // the translated text back.
    if (key === "aiItems" && String(p?.aiText || "").trim() && (p?.items || []).length) {
      return false;
    }
    // A bubble group is not an approximation waiting to be discovered.
    //
    // The rule above exists because a renderer cannot guess where a
    // translation breaks across lines it was never given. A grouped AI
    // paragraph is a different situation: the group's members ARE the bubble,
    // their combined extent is the balloon Lens found, and one wrapped string
    // inside a balloon is how that layer is meant to look — the same thing the
    // renderer already does for a single-line paragraph.
    //
    // Without this, every vertical page refused the local renderer and fell
    // back to the server's markup, which is the whole saving `/v1/groups` was
    // built to unlock.
    if (key === "aiItems" && (p?.aiCoveredBy || (p?.aiGroupParagraphIds || []).length > 1)) {
      return false;
    }
    // A paragraph the model did not answer is untranslated, not unfaithful; the renderer
    // leaves it blank and the caller reports the unit id. Geometry is only owed for text
    // that exists.
    if (key === "aiItems" && !String(p?.aiText || "").trim()) {
      return false;
    }
    return true;
  }).length;
  if (!missing) return { ok: true, reason: "" };
  return {
    ok: false,
    reason:
      `${missing} paragraph(s) span several lines and this document carries no ` +
      `per-line geometry ("${key}") for the "${source}" layer — it could only be ` +
      `approximated`,
  };
}

/**
 * The items to draw for one paragraph in one layer, and whether they are that
 * layer's OWN items.
 *
 * `own` is the part callers must not skip. When the boxes had to be borrowed
 * from the source layer, their `text` is the SOURCE text — drawing it would
 * put Japanese on screen for a reader who asked for Thai, in boxes that look
 * deliberate. So borrowed boxes may be used for their geometry only, and the
 * layer's own string goes over their combined extent.
 *
 * Borrowing happens for a single-line paragraph, where the two are the same
 * box anyway, and otherwise only when `allowApproximate` is set.
 */
export function itemsForSource(para, source, { allowApproximate = false } = {}) {
  const key = ITEMS_FOR_SOURCE[String(source || "translated")] || "items";
  const mine = para?.[key];
  if (Array.isArray(mine) && mine.length) return { items: mine, own: true };
  const base = para?.items || [];
  // Browser/text-only AI owns the translated STRING while Lens owns the
  // paragraph geometry. Borrow every source line box and draw the AI string
  // once over their combined extent; never draw the source item text.
  if (key === "aiItems" && String(para?.aiText || "").trim() && base.length) {
    return { items: base, own: false };
  }
  if (base.length <= 1 || allowApproximate) return { items: base, own: key === "items" };
  return { items: [], own: false };
}

/**
 * Which text to draw for a paragraph, and where it came from.
 *
 * Returns the layer explicitly instead of falling through `ai || lens ||
 * source`: a page silently showing Lens's machine translation when the user
 * asked for AI looks translated, just not the way they paid for.
 */
export function textForSource(para, source) {
  const want = String(source || "translated").toLowerCase();
  if (want === "original") return { text: String(para?.sourceText || ""), layer: "original" };
  if (want === "ai") {
    const ai = String(para?.aiText || "");
    return ai ? { text: ai, layer: "ai" } : { text: "", layer: "ai-missing" };
  }
  return { text: String(para?.lensText || ""), layer: "lens" };
}
