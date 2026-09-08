// LensDocument geometry is rendered as DOM; text is assigned through textContent.

import {
  MIN_FONT_PX,
  fitColumnFontSize,
  fitItemFontSize,
  fitParagraphFontSizeHorizontal,
  // isCjkDominant,
  sharedParagraphFontSize,
} from "../text-metrics.js";
// `canRenderFaithfully` lives in the schema module, not here: the service
// worker asks it too (before committing to the Lens-Direct route, which has no
// server markup to fall back on) and the service worker has no DOM.
import {
  canRenderFaithfully,
  itemsForSource,
  textForSource,
} from "../../shared/lens-document.js";
import {
  collapseThaiWordGaps,
  normalizeAiUnitText,
} from "../../shared/ai-markers.js";
import {
  itemGeometry,
  leftFacingGeometry,
  paragraphBlock,
  rotatedItemAabbGeometry,
  unionGeometry,
} from "./geometry.js";
import { targetTextDirection } from "./typography.js";
import { buildAiLineLayout, itemsReadVertically } from "./line-layout.js";
import { reportAiBlockCollisions } from "./ai-layout.js";
import { OVERLAY_CLASSES } from "./markup.js";
import { OVERLAY_CSS } from "./css.js";
import { makeLine } from "./line-renderer.js";
import {
  VERTICAL_TILT_DEG,
  translatedRotationSigns,
  verticalOriginalGeometries,
} from "./vertical-layout.js";

import { translatedLayoutGroups, translatedItemIsVertical } from "./translated-groups.js";
import { fitTranslatedBlockFont } from "./translated-fit.js";
import { originalDisplayGroups } from "./original-groups.js";

export { canRenderFaithfully };
export { itemGeometry, paragraphBlock, rotatedItemAabbGeometry };

export { OVERLAY_CLASSES };

export { OVERLAY_CSS };

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
/**
 * One box covering a whole paragraph, for text that has no per-item split.
 *
 * A single item keeps its own rotation. Several items are a polyline whose
 * segments differ slightly in angle, so the union is taken axis-aligned and
 * drawn upright: rotating the union by an averaged angle would tilt a block
 * that no longer follows any one baseline.
 */
/**
 * `paraId` is the LensDocument paragraph this line was drawn from, stamped as
 * `data-tp-para`. Every line of one bubble carries the same value, which is
 * what lets a reader select the whole bubble instead of a single visual row.
 * It is descriptive only — nothing in the rendering reads it back.
 */
/**
 * Render a LensDocument layer into a detached element.
 *
 * @returns {{root: HTMLElement, report: object}} The report says what was
 *   drawn and what was not. A paragraph skipped for want of text and a
 *   paragraph skipped for want of geometry look identical on screen — both are
 *   simply absent — so the caller is told which happened.
 */
export { translatedRotationSigns };

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
  // responsible for Lens upload, vertical Lens graph membership and text
  // translation only; it must not be called again to build aiItems/HTML.
  const aiLayouts = new Map();
  if (source === "ai") {
    const groupsByLeader = new Map();
    for (const group of doc?.canonicalOriginalTree?.paragraphs || []) {
      const leader = String(group?.source?.documentParagraphIds?.[0] || "");
      if (leader) groupsByLeader.set(leader, group);
    }
    const entries = [];
    for (const para of doc?.paragraphs || []) {
      const text = String(para?.aiText || "").trim();
      if (!text) continue;
      const leaderId = String(para?.id || "");
      const ids =
        Array.isArray(para?.aiGroupParagraphIds) &&
        para.aiGroupParagraphIds.length
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
        sourceItems
          .map((item) => rotatedItemAabbGeometry(item, imgW, imgH))
          .filter(Boolean),
      );
      if (!block || !sourceItems.length) continue;
      const group = groupsByLeader.get(leaderId);
      const sourceVertical =
        group?.direction === "v" || itemsReadVertically(sourceItems);
      const targetVisibleChars = Array.from(text).filter((ch) => !/\s/u.test(ch)).length;
      if (!sourceVertical && targetTextDirection(targetLanguage) === "h" && targetVisibleChars < 48)
        continue;
      const sourceGeometries = sourceItems
        .map((item) => itemGeometry(item, imgW, imgH))
        .filter(Boolean);
      const sourceRotations = sourceItems
        .map((item) => Number(item?.rotation))
        .filter(Number.isFinite);
      entries.push({
        leaderId,
        ids,
        members,
        sourceItems,
        sourceVertical,
        sourceBlock: paragraphBlock(sourceGeometries),
        sourceRotation: sourceRotations.length
          ? sourceRotations.reduce((sum, value) => sum + value, 0) / sourceRotations.length
          : 0,
        fontPx: group?.font_size_px ?? group?.para_font_size_px,
        block,
        text,
        onDark: members.some((member) =>
          Boolean(
            member?.aiTextLight !== undefined
              ? member.aiTextLight
              : member?.textLight,
          ),
        ),
      });
    }
    for (const entry of entries) {
      const lines = buildAiLineLayout(
        entry,
        entries,
        imgW,
        imgH,
        targetLanguage,
      );
      if (lines.length) aiLayouts.set(entry.leaderId, { ...entry, lines });
    }
    reportAiBlockCollisions(aiLayouts, report);
  }

  const translatedGroups = source === "translated" ? translatedLayoutGroups(doc) : [];
  const groupByParagraph = new Map();
  for (const group of translatedGroups) for (const id of group.paragraphIds) groupByParagraph.set(id,group.id);
  const verticalSigns = new Map();
  const translatedFonts = new Map();
  report.rotationMixedGroups = 0;
  report.rotationFlips = 0;
  if (source === "translated" && relayoutTranslated === false) {
    const normalized = translatedRotationSigns(doc, { groups: translatedGroups });
    normalized.signs.forEach((sign,id)=>verticalSigns.set(id,sign));
    report.rotationMixedGroups = normalized.mixedGroups;
    for (const group of translatedGroups) if (group.direction === "v")
      for (const id of group.paragraphIds) translatedFonts.set(id,group.sharedFontPx);
  }

  const relayoutBlocks = new Map();
  const relayoutCovered = new Set();
  if (source === "translated" && relayoutTranslated === true && targetTextDirection(targetLanguage) === "h") {
    for (const group of translatedGroups) {
      if (group.direction !== "v" || !group.text.trim()) continue;
      relayoutBlocks.set(group.paragraphIds[0], { block:group.block, text:group.text, members:group.members, sharedFontPx:group.sharedFontPx });
      group.paragraphIds.slice(1).forEach(id=>relayoutCovered.add(id));
    }
  }
  const originalGroups = source === "original" ? originalDisplayGroups(doc) : [];
  const originalGroupIds = new Map();
  for (const group of originalGroups) for (const id of group.paragraphIds || []) originalGroupIds.set(String(id),String(group.id));

  for (const para of doc.paragraphs || []) {
    // Checked before the layer: a paragraph with nothing to translate is not
    // a paragraph whose translation is missing. Counting it as missing would
    // pad the "ask again for these" list with ids that can never be answered.
    if (source !== "translated" && !String(para?.sourceText || "").trim()) {
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
            ownerDocument,
            row.geometry,
            row.text,
            Math.max(MIN_FONT_PX, row.fontPx),
            rebuilt.onDark,
            ["tp-bubble"],
            paraId,
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
        // The target block represents the whole explicit Lens group, not only its
        // leader paragraph.  A dark panel can be sampled differently by two
        // narrow source columns (one catches a white edge / glyph, the other
        // the black fill), so one dark member must flip the combined target to
        // white ink.  The Original browser-translate group follows the same
        // rule below.
        const onDark = rebuilt.members.some((member) =>
          Boolean(member?.textLight),
        );
        // Reflow owns the union canvas. A tiny native item must not cap every
        // line; fit discrete rows in this canvas instead of borrowing OFF font.
        const fontPx = fitTranslatedBlockFont(rebuilt.block, rebuilt.text, imgW, imgH);
        const line = makeLine(
          ownerDocument,
          rebuilt.block,
          rebuilt.text,
          Math.max(MIN_FONT_PX, fontPx),
          onDark,
          [],
          paraId,
        );
        line.classList.add("tp-bubble");
        line.setAttribute?.("data-tp-group", groupByParagraph.get(paraId));
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
    const layerItemText =
      ownItems && layerItems.some((i) => String(i?.text || "").trim());
    // The AI layer is re-laid out and can land on different background than
    // the source paragraph, so it carries its own reading. A grouped AI block
    // spans every named column, therefore one dark member flips the whole
    // combined block just like Original gtext and Translated relayout do.
    const paragraphOnDark = (member) =>
      Boolean(
        source === "ai" && member?.aiTextLight !== undefined
          ? member.aiTextLight
          : member?.textLight,
      );
    const onDark =
      Array.isArray(groupIds) && groupIds.length > 1
        ? groupIds
            .map((id) => byId.get(String(id)))
            .filter(Boolean)
            .some(paragraphOnDark)
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
      const itemGeometries =
        source === "original"
          ? verticalOriginalGeometries(item, imgW, imgH)
          : [source === "translated" && relayoutTranslated === false
            ? leftFacingGeometry(item, imgW, imgH) : itemGeometry(item, imgW, imgH)].filter(Boolean);
      if (!itemGeometries.length) {
        report.skippedNoGeometry++;
        continue;
      }
      for (const geometry of itemGeometries) {
        if (
          source === "translated" &&
          relayoutTranslated === false &&
          translatedItemIsVertical(item, imgW, imgH) && verticalSigns.has(String(para?.id))
        ) {
          if (Number(item.rotation) > 0) report.rotationFlips++;
          geometry.rotation = -90;
          geometry.sideways = true;
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
      const groupId = originalGroupIds.get(paraId);
      if (groupId) visibleParent.setAttribute?.("data-tp-group", groupId);
      scope.appendChild(visibleParent);
    }

    // Per-line text is only usable when the boxes belong to THIS layer.
    // Borrowed boxes carry the source text, and drawing that would put the
    // untranslated line on screen inside a box that looks deliberate.
    if (layerItemText && geometries.some((g) => g.text.trim())) {
      // One shared size across the bubble, because per-item fitting makes
      // neighbouring lines disagree by 10px for no reason a reader can see.
      const shared = source === "original" && geometries.some(g => g.upright)
        ? null : translatedFonts.get(String(para.id)) ?? sharedParagraphFontSize(geometries, imgW, imgH);
      for (const geometry of geometries) {
        if (!geometry.text.trim()) continue;
        const fitOne =
          geometry.upright === true ? fitColumnFontSize : fitItemFontSize;
        const fontPx =
          shared ??
          fitOne(
            geometry.widthPct,
            geometry.heightPct,
            geometry.text,
            imgW,
            imgH,
          );
        const line = makeLine(ownerDocument, geometry, geometry.text,
          Math.max(MIN_FONT_PX, fontPx), onDark, [], paraId);
        if (source === "translated" && groupByParagraph.has(paraId))
          line.setAttribute?.("data-tp-group", groupByParagraph.get(paraId));
        visibleParent.appendChild(line);
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
    const displayText =
      source === "ai" ? collapseThaiWordGaps(normalizeAiUnitText(text)) : text;
    const shouldWrap = source === "ai" || geometries.length > 1;
    const fontPx = shouldWrap
      ? fitParagraphFontSizeHorizontal(
          block.widthPct,
          block.heightPct,
          displayText,
          imgW,
          imgH,
        )
      : block.upright === true
        ? fitColumnFontSize(
            block.widthPct,
            block.heightPct,
            displayText,
            imgW,
            imgH,
          )
        : fitItemFontSize(
            block.widthPct,
            block.heightPct,
            displayText,
            imgW,
            imgH,
          );
    const line = makeLine(
      ownerDocument,
      block,
      displayText,
      Math.max(MIN_FONT_PX, fontPx),
      onDark,
      [],
      paraId,
    );
    if (shouldWrap) line.classList.add("tp-bubble");
    visibleParent.appendChild(line);
    report.lines++;
  }

  if (source === "original") {
    const covered = new Set();
    const targets = [];
    for (const group of originalGroups) {
      const ids = (group?.paragraphIds || []).map(String);
      const members = ids.map((id) => byId.get(id)).filter(Boolean);
      ids.forEach((id) => covered.add(id));
      const block = unionGeometry(
        members
          .flatMap((para) => para.items || [])
          .map((item) => rotatedItemAabbGeometry(item, imgW, imgH))
          .filter(Boolean),
      );
      const text = String(group?.text || "").trim();
      if (block && text)
        targets.push({
          block,
          text,
          groupId: String(group.id),
          onDark: members.some((para) => Boolean(para?.textLight)),
        });
    }
    for (const para of doc.paragraphs || []) {
      if (covered.has(String(para?.id))) continue;
      const text = String(para?.sourceText || "").trim();
      const block = unionGeometry(
        (para?.items || [])
          .map((item) => rotatedItemAabbGeometry(item, imgW, imgH))
          .filter(Boolean),
      );
      if (block && text)
        targets.push({ block, text, onDark: Boolean(para.textLight) });
    }
    for (const target of targets) {
      const fontPx = fitParagraphFontSizeHorizontal(
        target.block.widthPct,
        target.block.heightPct,
        target.text,
        imgW,
        imgH,
      );
      const line = makeLine(
        ownerDocument,
        target.block,
        target.text,
        Math.max(MIN_FONT_PX, fontPx),
        target.onDark,
        ["tp-gtext", "tp-bubble"],
      );
      // Rawkuma and similar reader pages commonly declare themselves English
      // even when the inserted OCR is Japanese. Chrome otherwise translates
      // this Japanese as if it were English and produces mostly Japanese/�
      // output. Give the browser's own translator the OCR source language on
      // the exact semantic group it is allowed to replace.
      if (sourceLanguage) line.setAttribute?.("lang", sourceLanguage);
      if (target.groupId) line.setAttribute?.("data-tp-group", target.groupId);
      line.setAttribute?.("translate", "yes");
      line.translate = true;
      scope.appendChild(line);
    }
  }

  return { root, report };
}
