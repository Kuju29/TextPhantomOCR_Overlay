/** Content-free diagnostics for overlapping AI translation canvases. */
export function reportAiBlockCollisions(aiLayouts, report) {
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
      if (!(smaller > 0) || (ix * iy) / smaller < 0.05) continue;
      const key = [a.leaderId, b.leaderId].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      report.aiBlocksOverlappingIds.push(key);
      const diagnostics = report.aiBlockOverlapGeometry ||= [];
      if (diagnostics.length < 24) diagnostics.push({id:a.leaderId,ref:b.leaderId,
        x:Math.max(a.left,b.left)/100,y:Math.max(a.top,b.top)/100,w:ix/100,h:iy/100});
    }
  }
  report.aiBlocksOverlapping = report.aiBlocksOverlappingIds.length;
}
