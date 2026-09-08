/** Client implementation of `tp.lens-document/1`; coordinates are normalized 0..1. */

import { normalizeAiUnitText } from "./ai-markers.js";

export const LENS_DOCUMENT_SCHEMA = "tp.lens-document/1";
export const CANONICAL_ORIGINAL_TREE_SCHEMA = "tp.canonical-original-tree/1";

// Reject crafted documents before they can expand into excessive DOM nodes.
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

/** Require the structured Lens hand-off used by local AI. */
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
  return (
    Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber)
  );
}

function assertUniqueParagraphIds(paragraphs) {
  const seen = new Set();
  for (let index = 0; index < paragraphs.length; index++) {
    const id = String(paragraphs[index]?.id || "");
    if (!id) continue; // the existing structural validator reports missing IDs
    if (seen.has(id)) {
      throw new LensDocumentError(
        `duplicate paragraph id ${JSON.stringify(id)} at paragraph ${index}`,
      );
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
        return (
          `${key} in paragraph ${para?.id || "?"} has ${items.length} items ` +
          `(max ${LENS_DOCUMENT_LIMITS.itemsPerParagraphLayer})`
        );
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
          return (
            `item ${item?.id || "?"} has ${spans.length} spans ` +
            `(max ${LENS_DOCUMENT_LIMITS.spansPerItem})`
          );
        }
        totalSpans += spans.length;
        if (totalSpans > LENS_DOCUMENT_LIMITS.totalSpans) {
          return `${totalSpans} total spans exceeds ${LENS_DOCUMENT_LIMITS.totalSpans}`;
        }
        estimatedDomNodes += Math.max(1, spans.length);
        if (estimatedDomNodes > LENS_DOCUMENT_LIMITS.estimatedDomNodes) {
          return (
            `estimated ${estimatedDomNodes} DOM nodes exceeds ` +
            `${LENS_DOCUMENT_LIMITS.estimatedDomNodes}`
          );
        }
      }
    }
    if (
      para?.aiGroupParagraphIds !== undefined &&
      !Array.isArray(para.aiGroupParagraphIds)
    ) {
      return `aiGroupParagraphIds in paragraph ${para?.id || "?"} is not an array`;
    }
    const aiMembers = para?.aiGroupParagraphIds || [];
    if (aiMembers.length > LENS_DOCUMENT_LIMITS.membersPerGroup) {
      return (
        `AI group in paragraph ${para?.id || "?"} has ${aiMembers.length} members ` +
        `(max ${LENS_DOCUMENT_LIMITS.membersPerGroup})`
      );
    }
    aiGroupMemberships += aiMembers.length;
    if (aiGroupMemberships > LENS_DOCUMENT_LIMITS.totalGroupMemberships) {
      return (
        `${aiGroupMemberships} total AI group memberships exceeds ` +
        `${LENS_DOCUMENT_LIMITS.totalGroupMemberships}`
      );
    }
  }

  let memberships = 0;
  for (const group of groups) {
    if (
      group?.paragraphIds !== undefined &&
      !Array.isArray(group.paragraphIds)
    ) {
      return `paragraphIds in group ${group?.id || "?"} is not an array`;
    }
    const members = group?.paragraphIds || [];
    if (members.length > LENS_DOCUMENT_LIMITS.membersPerGroup) {
      return (
        `group ${group?.id || "?"} has ${members.length} members ` +
        `(max ${LENS_DOCUMENT_LIMITS.membersPerGroup})`
      );
    }
    memberships += members.length;
    if (memberships > LENS_DOCUMENT_LIMITS.totalGroupMemberships) {
      return (
        `${memberships} total group memberships exceeds ` +
        `${LENS_DOCUMENT_LIMITS.totalGroupMemberships}`
      );
    }
  }
  return "";
}

/** Validate a wire document. Invalid geometry is rejected, never repaired. */
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
    throw new LensDocumentError(
      `lens document has no usable image size (${w}x${h})`,
    );
  }
  if (!Array.isArray(doc.paragraphs)) {
    throw new LensDocumentError("lens document has no paragraphs array");
  }
  const cardinalityReason = documentCardinalityReason(doc);
  if (cardinalityReason) {
    throw new LensDocumentError(
      `lens document exceeds local render budget: ${cardinalityReason}`,
    );
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
        throw new LensDocumentError(
          `paragraph ${para.id} has a non-array ${key}`,
        );
      }
      for (const item of list) {
        if (!isPoint(item?.baseline?.[0]) || !isPoint(item?.baseline?.[1])) {
          throw new LensDocumentError(
            `item ${item?.id || "?"} in ${key} has a malformed baseline`,
          );
        }
        if (!isFiniteNumber(item.height) || item.height <= 0) {
          throw new LensDocumentError(
            `item ${item?.id || "?"} in ${key} has a non-positive height`,
          );
        }
        if (item.spans !== undefined) {
          if (!Array.isArray(item.spans)) {
            throw new LensDocumentError(
              `item ${item?.id || "?"} in ${key} has non-array spans`,
            );
          }
          for (const span of item.spans) {
            if (
              !isFiniteNumber(span?.t0) ||
              !isFiniteNumber(span?.t1) ||
              span.t0 < 0 ||
              span.t1 > 1 ||
              !(span.t1 > span.t0)
            ) {
              throw new LensDocumentError(
                `item ${item?.id || "?"} in ${key} has a malformed span`,
              );
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
        !Array.isArray(bounds) ||
        bounds.length !== 4 ||
        !bounds.every(isFiniteNumber) ||
        bounds[0] < 0 ||
        bounds[1] < 0 ||
        bounds[2] > w ||
        bounds[3] > h ||
        !(bounds[2] > bounds[0]) ||
        !(bounds[3] > bounds[1])
      ) {
        throw new LensDocumentError(
          `group ${group?.id || "?"} has malformed boundsPx`,
        );
      }
    }
  }

  return doc;
}

/** Warnings the producer attached — surfaced, never dropped. */
export function documentWarnings(doc) {
  return Array.isArray(doc?.warnings) ? doc.warnings : [];
}

// Client-side document construction; parity is pinned by the shared fixture.

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

/** One baseline segment, or null for unusable geometry. */
function buildItem(paraId, index, raw) {
  const p1 = point(raw?.baseline_p1);
  const p2 = point(raw?.baseline_p2);
  if (p1 === null || p2 === null) return null;

  const height = round5(raw?.height_raw);
  if (height === null || height <= 0) return null;

  const box = raw?.box && typeof raw.box === "object" ? raw.box : {};
  // Rotation genuinely defaults: an upright box omits it, and "unset" and "0°"
  // are the same intent.
  const rotation =
    box.rotation_deg === undefined ? 0 : round5(box.rotation_deg);
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

/** Build a document, matching translated paragraphs to originals by position. */
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
  const targetParas = translatedTree?.paragraphs || [];
  const sourceMap = originalTree?.furigana_filter?.rawToFiltered;
  let translatedParas = targetParas;
  if (Array.isArray(sourceMap) && sourceMap.some(i => i === null)) {
    // Retain the old positional pairing only when its original counts matched.
    // Target-only display uses buildTranslatedLensDocument and is unchanged.
    translatedParas = originalParas.map(() => null);
    if (targetParas.length === sourceMap.length) sourceMap.forEach((to, from) => {
      if (Number.isInteger(to) && to >= 0 && to < originalParas.length)
        translatedParas[to] = targetParas[from];
    });
  }

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
  if (droppedItems)
    warnings.push(`dropped ${droppedItems} item(s) with unusable geometry`);
  if (
    translatedParas.length &&
    translatedParas.length !== originalParas.length
  ) {
    warnings.push(
      `paragraph count mismatch: original=${originalParas.length} ` +
        `translated=${translatedParas.length} — lensText may be misaligned`,
    );
  }
  if (warnings.length) document.warnings = warnings;

  return document;
}

/** A Translated display document has no positional dependency on Original.
 * Empty source placeholders preserve the existing wire schema without duplicating
 * a second full tree. These documents are never submitted as AI source units.
 */
export function buildTranslatedLensDocument(translatedTree, options) {
  const placeholders = (translatedTree?.paragraphs || []).map(p => ({
    text: "", items: [], text_light: Boolean(p?.text_light),
  }));
  return buildLensDocument({paragraphs: placeholders}, translatedTree, options);
}

/** Attach the API-owned logical source tree used by every AI transport. */
export function attachCanonicalOriginalTree(doc, canonicalOriginalTree) {
  if (!doc || typeof doc !== "object") {
    throw new LensDocumentError("cannot attach an AI source tree to a non-document");
  }
  if (
    !canonicalOriginalTree ||
    canonicalOriginalTree.schema !== CANONICAL_ORIGINAL_TREE_SCHEMA ||
    !Array.isArray(canonicalOriginalTree.paragraphs) ||
    canonicalOriginalTree?.coverage?.complete !== true
  ) {
    throw new LensDocumentError("grouping response carried no complete tp.canonical-original-tree/1");
  }
  const known = new Set((doc.paragraphs || []).map((para) => String(para?.id || "")));
  const owned = new Set();
  for (const [index, paragraph] of canonicalOriginalTree.paragraphs.entries()) {
    if (!paragraph || typeof paragraph !== "object" || !String(paragraph.id || "")) {
      throw new LensDocumentError(`AI source paragraph ${index} has no stable identity`);
    }
    const source = paragraph.source;
    if (
      source?.contract !== "tp.ai-source-members/1" ||
      !Array.isArray(source.documentParagraphIds) ||
      !Array.isArray(source.rawParagraphIndices)
    ) {
      throw new LensDocumentError(`AI source paragraph ${paragraph.id} has no source contract`);
    }
    for (const rawId of source.documentParagraphIds.map(String)) {
      if (!known.has(rawId)) {
        throw new LensDocumentError(
          `AI source paragraph ${paragraph.id} names missing document paragraph ${rawId}`,
        );
      }
      if (owned.has(rawId)) {
        throw new LensDocumentError(`document paragraph ${rawId} has more than one AI owner`);
      }
      owned.add(rawId);
    }
    if (source.documentParagraphIds.length && !String(paragraph.text || "").trim()) {
      throw new LensDocumentError(`AI source paragraph ${paragraph.id} has no text`);
    }
  }
  const expected = new Set(
    (doc.paragraphs || [])
      .filter((para) => String(para?.sourceText || "").trim())
      .map((para) => String(para.id)),
  );
  const missing = [...expected].filter((id) => !owned.has(id));
  if (missing.length) {
    throw new LensDocumentError(
      `AI source tree does not own ${missing.length} source paragraph(s): ${missing.join(",")}`,
    );
  }
  return { ...doc, canonicalOriginalTree };
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
  if (doc?.canonicalOriginalTree !== undefined) {
    const checked = attachCanonicalOriginalTree(
      doc,
      doc.canonicalOriginalTree,
    ).canonicalOriginalTree;
    return checked.paragraphs
      .filter(
        (paragraph) =>
          paragraph?.ai_eligible !== false &&
          paragraph?.source?.documentParagraphIds?.length > 0 &&
          String(paragraph?.text || "").trim(),
      )
      .map((paragraph, index) => ({
        id: `g${index}`,
        sourceId: String(paragraph.id),
        text: String(paragraph.text).trim(),
        paragraphIds: paragraph.source.documentParagraphIds.map(String),
        translatable: hasTranslatableText(paragraph.text),
      }));
  }
  for (const para of doc?.paragraphs || []) {
    const text = String(para?.sourceText || "").trim();
    if (!text) continue;
    units.push({
      id: `g${units.length}`,
      text,
      paragraphIds: [String(para.id || "")],
      translatable: hasTranslatableText(text),
    });
  }
  return units;
}

/**
 * Prove that the OCR paragraphs which contain source text survive grouping as
 * one, and only one, addressable AI unit.  This deliberately does not decide
 * *how* paragraphs should be grouped; it is the loss/duplication guard between
 * the grouping result and either AI transport.
 */
export function translationConservation(doc, units = translationUnits(doc)) {
  const paragraphs = Array.isArray(doc?.paragraphs) ? doc.paragraphs : [];
  assertUniqueParagraphIds(paragraphs);
  const eligibleIds = paragraphs
    .filter((para) => String(para?.sourceText || "").trim())
    .map((para) => String(para.id));
  const eligible = new Set(eligibleIds);
  const known = new Set(paragraphs.map((para) => String(para?.id || "")));
  const owners = new Map();
  const duplicateUnitIds = [];
  const seenUnitIds = new Set();
  const emptyUnits = [];
  const unknownParagraphIds = [];
  const contentProofErrors = [];

  for (const unit of Array.isArray(units) ? units : []) {
    const unitId = String(unit?.id || "");
    if (!unitId || seenUnitIds.has(unitId)) duplicateUnitIds.push(unitId);
    seenUnitIds.add(unitId);
    const members = Array.isArray(unit?.paragraphIds)
      ? unit.paragraphIds.map(String)
      : [];
    if (!String(unit?.text || "").trim() || !members.length)
      emptyUnits.push(unitId);
    for (const paragraphId of members) {
      if (!known.has(paragraphId)) {
        unknownParagraphIds.push(paragraphId);
        continue;
      }
      // Blank OCR paragraphs are an explicit non-AI exclusion. They may still
      // contribute geometry to a group, but do not participate in text
      // conservation.
      if (!eligible.has(paragraphId)) continue;
      const current = owners.get(paragraphId) || [];
      current.push(unitId);
      owners.set(paragraphId, current);
    }
  }

  const missingParagraphIds = eligibleIds.filter(
    (paragraphId) => !owners.has(paragraphId),
  );
  const duplicateParagraphIds = eligibleIds.filter(
    (paragraphId) => (owners.get(paragraphId) || []).length > 1,
  );
  const translatableUnitIds = (Array.isArray(units) ? units : [])
    .filter((unit) => unit?.translatable === true)
    .map((unit) => String(unit.id));
  const ok =
    !missingParagraphIds.length &&
    !duplicateParagraphIds.length &&
    !unknownParagraphIds.length &&
    !duplicateUnitIds.length &&
    !emptyUnits.length &&
    !contentProofErrors.length;
  return {
    ok,
    paragraphCount: paragraphs.length,
    eligibleParagraphCount: eligibleIds.length,
    excludedBlankParagraphCount: paragraphs.length - eligibleIds.length,
    unitCount: Array.isArray(units) ? units.length : 0,
    translatableUnitCount: translatableUnitIds.length,
    expectedRequestIds: translatableUnitIds,
    missingParagraphIds,
    duplicateParagraphIds,
    unknownParagraphIds: [...new Set(unknownParagraphIds)],
    duplicateUnitIds: [...new Set(duplicateUnitIds)],
    emptyUnitIds: [...new Set(emptyUnits)],
    contentProofErrors,
  };
}

export function requireTranslationConservation(doc, units = translationUnits(doc)) {
  const report = translationConservation(doc, units);
  if (!report.ok) {
    throw new LensDocumentError(
      `OCR-to-AI unit conservation failed: ${JSON.stringify({
        missingParagraphIds: report.missingParagraphIds,
        duplicateParagraphIds: report.duplicateParagraphIds,
        unknownParagraphIds: report.unknownParagraphIds,
        duplicateUnitIds: report.duplicateUnitIds,
        emptyUnitIds: report.emptyUnitIds,
        contentProofErrors: report.contentProofErrors,
      })}`,
    );
  }
  return report;
}

/** Return a new translated document plus applied/missing-unit counts. */
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
      unknown: [...byUnit.keys()].filter(
        (id) => !units.some((u) => u.id === id),
      ),
    },
  };
}

/** Convert an applied AI report into the explicit caller-facing completion contract. */
export function classifyAiTranslationReport(report) {
  const translated = Math.max(0, Number(report?.translated) || 0);
  const missing = Array.isArray(report?.missing)
    ? report.missing.map(String)
    : [];
  return {
    usable: translated > 0,
    complete: translated > 0 && missing.length === 0,
    translated,
    missing,
    reason: translated > 0 ? "" : "AI returned no usable translations",
  };
}

/** Check that the requested layer has sufficient per-line geometry. */
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
  if (!key)
    return { ok: false, reason: `unknown source ${JSON.stringify(source)}` };
  if (key === "items") return { ok: true, reason: "" };

  const paragraphs = doc?.paragraphs || [];
  const missing = paragraphs.filter((p) => {
    if ((p?.items || []).length <= 1) return false;
    if ((p?.[key] || []).length > 0) return false;
    // AI paragraph text wraps inside its combined source extent.
    if (
      key === "aiItems" &&
      String(p?.aiText || "").trim() &&
      (p?.items || []).length
    ) {
      return false;
    }
    // Group members jointly define the vertical bubble extent.
    if (
      key === "aiItems" &&
      (p?.aiCoveredBy || (p?.aiGroupParagraphIds || []).length > 1)
    ) {
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

/** Select layer items; borrowed source items contribute geometry, never text. */
export function itemsForSource(
  para,
  source,
  { allowApproximate = false } = {},
) {
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
  if (base.length <= 1 || allowApproximate)
    return { items: base, own: key === "items" };
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
  if (want === "original")
    return { text: String(para?.sourceText || ""), layer: "original" };
  if (want === "ai") {
    const ai = String(para?.aiText || "");
    return ai ? { text: ai, layer: "ai" } : { text: "", layer: "ai-missing" };
  }
  return { text: String(para?.lensText || ""), layer: "lens" };
}
