import { isCjkDominant } from "../text-metrics.js";
import { translatedLayoutGroups, translatedItemIsVertical } from "./translated-groups.js";
import { itemGeometry, rotatedItemAabbGeometry, geometryReadingAxis } from "./geometry.js";

export const VERTICAL_TILT_DEG = 78;

export function verticalOriginalGeometries(item, imgW, imgH) {
  const raw = itemGeometry(item, imgW, imgH);
  if (!raw) return [];
  if (!(geometryReadingAxis(raw, imgW, imgH) === "v" && isCjkDominant(raw.text)))
    return [raw];
  const aabb = rotatedItemAabbGeometry(item, imgW, imgH);
  return aabb
    ? [{ ...aabb, rotation: raw.rotation, text: raw.text, upright: true }]
    : [];
}

export function translatedRotationSigns(doc, { groups = translatedLayoutGroups(doc) } = {}) {
  const signs = new Map(); let mixedGroups = 0;
  for (const group of groups) {
    const rotations = group.members.flatMap(p => (p.lensItems || []))
      .filter(it => translatedItemIsVertical(it, doc.image.width, doc.image.height)).map(it=>Number(it.rotation));
    if (!rotations.length) continue;
    if (rotations.some(r=>r>0) && rotations.some(r=>r<0)) mixedGroups++;
    // OFF means sideways left for translated vertical columns, never majority vote.
    group.paragraphIds.forEach(id=>signs.set(id,-1));
  }
  return { signs, mixedGroups };
}
