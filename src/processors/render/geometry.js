/** Pure Lens-document geometry helpers shared by the overlay renderer. */
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

export function rotatedItemAabbGeometry(item, imgW, imgH) {
  const geometry = itemGeometry(item, imgW, imgH);
  if (!geometry) return null;
  const widthPx = (geometry.widthPct / 100) * imgW;
  const heightPx = (geometry.heightPct / 100) * imgH;
  const cx = ((geometry.leftPct + geometry.widthPct / 2) / 100) * imgW;
  const cy = ((geometry.topPct + geometry.heightPct / 2) / 100) * imgH;
  const rad = ((Number(geometry.rotation) || 0) * Math.PI) / 180;
  const aabbW =
    Math.abs(widthPx * Math.cos(rad)) + Math.abs(heightPx * Math.sin(rad));
  const aabbH =
    Math.abs(widthPx * Math.sin(rad)) + Math.abs(heightPx * Math.cos(rad));
  return {
    leftPct: ((cx - aabbW / 2) / imgW) * 100,
    topPct: ((cy - aabbH / 2) / imgH) * 100,
    widthPct: (aabbW / imgW) * 100,
    heightPct: (aabbH / imgH) * 100,
    rotation: 0,
    text: geometry.text,
  };
}

export function unionGeometry(geometries) {
  if (!geometries.length) return null;
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

export function geometryFromPixelBounds(bounds, imgW, imgH) {
  if (
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    !bounds.every((value) => Number.isFinite(Number(value))) ||
    !(imgW > 0) ||
    !(imgH > 0)
  )
    return null;
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

export function paragraphBlock(geometries) {
  if (geometries.length === 1) return geometries[0];
  return unionGeometry(geometries);
}

/** Lens supports both rotated baselines and tall zero-angle glyph envelopes. */
export function geometryReadingAxis(g, imgW, imgH) {
  const angle = ((Number(g?.rotation || 0) % 180) + 180) % 180;
  if (Math.abs(angle - 90) <= 12) return "v";
  if (Math.min(angle, 180 - angle) > 12) return "tilted";
  const w = g.widthPct * imgW, h = g.heightPct * imgH;
  return w > 0 && h >= 1.35 * w ? "v" : "h";
}

export function leftFacingGeometry(item, imgW, imgH) {
  const g = itemGeometry(item, imgW, imgH);
  if (!g || geometryReadingAxis(g, imgW, imgH) !== "v") return g;
  const folded = ((g.rotation % 180) + 180) % 180;
  if (Math.abs(folded - 90) > 12) {
    // Swap the local layout axes, not the physical centre or visible envelope.
    const cx = g.leftPct + g.widthPct / 2, cy = g.topPct + g.heightPct / 2;
    const widthPct = g.heightPct * imgH / imgW, heightPct = g.widthPct * imgW / imgH;
    return { ...g, leftPct: cx - widthPct / 2, topPct: cy - heightPct / 2,
      widthPct, heightPct, rotation: -90, sideways: true };
  }
  return { ...g, rotation: -90, sideways: true };
}
