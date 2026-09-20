
/**
 * Split overlap introduced by Lens AABBs for two independent horizontal
 * paragraphs. OCR paragraph envelopes can extend a little into the next
 * balloon even though the paragraphs are separate semantic units. Feeding
 * those overlapping envelopes directly to the long-target AI renderer makes
 * two translations occupy the same pixels.
 *
 * This is deliberately narrower than a general collision resolver:
 * - only one-paragraph, horizontal units are eligible;
 * - grouped/multi-paragraph units are left untouched so a bad grouping splice
 *   still surfaces as a collision instead of being hidden;
 * - the split is at the midpoint between the two source centres, so each
 *   canvas keeps its own centre and is only SHRUNK, never moved elsewhere.
 */
export function partitionIndependentHorizontalBlocks(entries, report = null) {
  const prepared = entries.map((entry) => ({ ...entry, block: { ...entry.block } }));
  const eligible = (entry) => !entry.sourceVertical && (entry.ids || []).length === 1;
  const rect = (entry) => ({
    left: entry.block.leftPct,
    top: entry.block.topPct,
    right: entry.block.leftPct + entry.block.widthPct,
    bottom: entry.block.topPct + entry.block.heightPct,
  });
  const setRect = (entry, r) => {
    entry.block = { ...entry.block, leftPct:r.left, topPct:r.top,
      widthPct:r.right-r.left, heightPct:r.bottom-r.top };
  };
  const partitions = [];
  for (let i=0; i<prepared.length; i++) for (let j=i+1; j<prepared.length; j++) {
    const a=prepared[i], b=prepared[j];
    if (!eligible(a) || !eligible(b)) continue;
    const ar=rect(a), br=rect(b);
    const ix=Math.min(ar.right,br.right)-Math.max(ar.left,br.left);
    const iy=Math.min(ar.bottom,br.bottom)-Math.max(ar.top,br.top);
    if (!(ix>0) || !(iy>0)) continue;
    const smaller=Math.min((ar.right-ar.left)*(ar.bottom-ar.top),(br.right-br.left)*(br.bottom-br.top));
    if (!(smaller>0) || (ix*iy)/smaller < 0.05) continue;
    const acx=(ar.left+ar.right)/2, bcx=(br.left+br.right)/2;
    const acy=(ar.top+ar.bottom)/2, bcy=(br.top+br.bottom)/2;
    const dx=Math.abs(acx-bcx), dy=Math.abs(acy-bcy);
    // Prefer the axis that most clearly separates the paragraph centres.
    // A centre-equal pair is genuinely ambiguous and stays diagnostic-only.
    if (dx >= dy && dx > 1e-6) {
      const boundary=(acx+bcx)/2;
      if (acx < bcx) {
        const nextA={...ar,right:Math.min(ar.right,boundary)};
        const nextB={...br,left:Math.max(br.left,boundary)};
        if (nextA.right>nextA.left && nextB.right>nextB.left) { setRect(a,nextA); setRect(b,nextB); }
        else continue;
      } else {
        const nextA={...ar,left:Math.max(ar.left,boundary)};
        const nextB={...br,right:Math.min(br.right,boundary)};
        if (nextA.right>nextA.left && nextB.right>nextB.left) { setRect(a,nextA); setRect(b,nextB); }
        else continue;
      }
    } else if (dy > 1e-6) {
      const boundary=(acy+bcy)/2;
      if (acy < bcy) {
        const nextA={...ar,bottom:Math.min(ar.bottom,boundary)};
        const nextB={...br,top:Math.max(br.top,boundary)};
        if (nextA.bottom>nextA.top && nextB.bottom>nextB.top) { setRect(a,nextA); setRect(b,nextB); }
        else continue;
      } else {
        const nextA={...ar,top:Math.max(ar.top,boundary)};
        const nextB={...br,bottom:Math.min(br.bottom,boundary)};
        if (nextA.bottom>nextA.top && nextB.bottom>nextB.top) { setRect(a,nextA); setRect(b,nextB); }
        else continue;
      }
    } else continue;
    partitions.push([a.leaderId,b.leaderId].sort().join('|'));
  }
  if (report && partitions.length) {
    report.aiIndependentOverlapPartitions = partitions.length;
    report.aiIndependentOverlapPartitionIds = partitions;
  }
  return prepared;
}

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
