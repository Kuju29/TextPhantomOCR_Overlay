import { MIN_FONT_PX, isCjkDominant } from "../text-metrics.js";
import {
  distributeTokens,
  itemsReadVertically as readVertically,
  layoutTokens,
  targetTextDirection,
} from "./typography.js";
import { VERTICAL_TILT_DEG } from "./vertical-layout.js";
import {
  collapseThaiWordGaps,
  normalizeAiUnitText,
} from "../../shared/ai-markers.js";
export function itemsReadVertically(items) {
  return readVertically(items, VERTICAL_TILT_DEG);
}

function expandDirectionChangeCanvas(
  block,
  sourceDirection,
  targetDirection,
  peers,
  imgW,
  imgH,
) {
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
      else if (px1 >= inkRight)
        nextRight = Math.min(nextRight, (px1 + inkRight) / 2);
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
      else if (py1 >= inkBottom)
        nextBottom = Math.min(nextBottom, (py1 + inkBottom) / 2);
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

export function buildAiLineLayout(entry, entries, imgW, imgH, language) {
  let targetDirection = targetTextDirection(language);
  const sourceDirection = entry.sourceVertical ? "v" : "h";
  const rotations = entry.sourceItems
    .map((item) => Number(item?.rotation))
    .filter(Number.isFinite);
  const sourceRotation = Number.isFinite(Number(entry.sourceRotation))
    ? Number(entry.sourceRotation)
    : rotations.length
      ? rotations.reduce((sum, value) => sum + value, 0) / rotations.length
      : Number(entry.block?.rotation) || 0;
  const folded = ((sourceRotation % 90) + 90) % 90;
  const residualTilt = Math.min(folded, 90 - folded);
  const visibleChars = Array.from(String(entry.text || ""))
    .filter((ch) => !/\s/u.test(ch)).length;
  const blockWidthPx = (entry.block.widthPct / 100) * imgW;
  const blockHeightPx = (entry.block.heightPct / 100) * imgH;
  const preserveVerticalRun = sourceDirection === "v" &&
    entry.sourceItems.length === 1 && visibleChars >= 18 &&
    blockHeightPx / Math.max(1, blockWidthPx) >= 5;
  // Match the API axis classifier: more than 12° away from either principal
  // axis is artwork tilt, not vertical/horizontal reading direction.
  const preserveFreeAngle = residualTilt > 12;
  if (preserveVerticalRun) targetDirection = "v";
  const directionChange = sourceDirection !== targetDirection;
  const peers = entries
    .filter((candidate) => candidate !== entry)
    .map((candidate) => candidate.block);
  const canvas = preserveVerticalRun || preserveFreeAngle
    ? { ...(entry.sourceBlock || entry.block), rotation: sourceRotation }
    : expandDirectionChangeCanvas(
    entry.block,
    sourceDirection,
    targetDirection,
    peers,
    imgW,
    imgH,
    );
  const canvasW = (canvas.widthPct / 100) * imgW;
  const canvasH = (canvas.heightPct / 100) * imgH;
  const chars = Math.max(
    1,
    Array.from(entry.text).filter((ch) => !/\s/u.test(ch)).length,
  );
  const glyphRatio = isCjkDominant(entry.text) ? 1 : 0.55;
  const sourceFont = Math.max(
    MIN_FONT_PX,
    Number(entry.fontPx) || 0,
    ...entry.sourceItems
      .map((item) => Number(item?.height) * imgH)
      .filter((value) => value > 0),
  );
  const areaCap = Math.sqrt(
    (canvasW * canvasH) / Math.max(1, chars * glyphRatio * 1.2),
  );
  const candidateFont = Math.max(MIN_FONT_PX, Math.min(sourceFont, areaCap));

  // Decorative singleton geometry is authoritative. Re-distributing it as
  // dialogue changes both the artwork angle and its intended sign shape.
  if (preserveVerticalRun || preserveFreeAngle) {
    const text = collapseThaiWordGaps(normalizeAiUnitText(entry.text));
    if (!text) return [];
    return [{ geometry: { ...canvas, rotation: sourceRotation, text }, text,
      fontPx: Math.max(MIN_FONT_PX, Math.min(candidateFont, sourceFont)) }];
  }
  const natural =
    layoutTokens(entry.text, language, targetDirection === "v").length || 1;
  const gridFont = (lines) => {
    const perLine = Math.ceil(chars / Math.max(1, lines));
    return targetDirection === "v"
      ? Math.min(canvasH / perLine, canvasW / lines)
      : Math.min(
          canvasW / perLine / Math.max(0.1, glyphRatio),
          canvasH / (lines * 1.15),
        );
  };
  // Short horizontal labels already fit naturally as one line. Start the
  // target-token line search only once the Thai sentence has enough mass to
  // benefit; converted vertical dialogue always uses it.
  const targetDrivenWrap = targetDirection === "h" && visibleChars >= 48;
  let lineCount = directionChange || targetDrivenWrap
    ? 1
    : Math.max(1, Math.min(20, entry.sourceItems.length || 1));
  if (directionChange || targetDrivenWrap) {
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
  const texts = distributeTokens(
    entry.text,
    language,
    targetDirection === "v",
    lineCount,
  );
  lineCount = Math.max(1, texts.length);
  const fontPx = Math.max(
    MIN_FONT_PX,
    Math.min(candidateFont, gridFont(lineCount)),
  );
  if (targetDirection === "h") {
    // Horizontal Thai uses one compact CSS block. The target-token line-count
    // search above determines its fitted font, while browser wrapping avoids
    // stretching artificial rows and never splits an HTML-looking literal.
    const text = collapseThaiWordGaps(normalizeAiUnitText(entry.text));
    return text ? [{ geometry: { ...canvas, rotation: 0, text }, text, fontPx }] : [];
  }
  return texts.map((text, index) => {
    const geometry = {
      leftPct:
        canvas.leftPct +
        canvas.widthPct -
        ((index + 1) * canvas.widthPct) / lineCount,
      topPct: canvas.topPct,
      widthPct: canvas.widthPct / lineCount,
      heightPct: canvas.heightPct,
      rotation: 90,
      text,
    };
    return { geometry, text, fontPx };
  });
}
