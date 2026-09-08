// Geometry-only diagnostic projections. Never fed back into grouping/rendering.
// Coordinates are normalized to image space; missing geometry stays unknown.
export function geometryDiagnostics(tree, { width, height, reason = 'source_geometry', sourceKind = 'original', maxRows = 48 } = {}) {
  const rows = []; let totalRows = 0;
  for (const [pi, paragraph] of (tree?.paragraphs || []).entries()) {
    for (const [ii, item] of (paragraph?.items || []).entries()) {
      totalRows++;
      if (rows.length >= maxRows) continue;
      const b = item?.bounds_px || paragraph?.bounds_px;
      const valid = Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && width > 0 && height > 0;
      rows.push({ id: `p${pi}`, itemIndex: ii, rawIndex: Number.isSafeInteger(paragraph.para_index) ? paragraph.para_index : pi,
        x: valid ? b[0] / width : null, y: valid ? b[1] / height : null,
        w: valid ? (b[2] - b[0]) / width : null, h: valid ? (b[3] - b[1]) / height : null,
        rotation: Number.isFinite(item?.box?.rotation_deg) ? item.box.rotation_deg : null });
    }
  }
  const chunks = Math.max(1, Math.ceil(rows.length / 12));
  return Array.from({ length: chunks }, (_, chunk) => ({ schema: 'tp.audit/1', event: 'geometry_snapshot', reason, sourceKind,
    totalRows, capturedRows: rows.length, complete: rows.length === totalRows, chunk, chunks, rows: rows.slice(chunk * 12, chunk * 12 + 12) }));
}
export function rubyDiagnostics(report) {
  const annotations = report?.annotations || [];
  return { schema: 'tp.audit/1', event: 'ruby_filter', reason: 'detected_ruby', sourceKind: 'original',
    counts: { removedCount: (report?.itemsDropped || 0) + (report?.spansDropped || 0),
      fallbackCount: report?.ambiguousCandidates || 0 }, totalRows: annotations.length,
    capturedRows: Math.min(12, annotations.length), complete: annotations.length <= 12,
    rows: annotations.slice(0, 12).map(a => ({ id: `p${a.paragraph}`, itemIndex: a.item,
      spanIndex: a.span, ref: `p${a.ownerParagraph}`, direction: a.axis })) };
}
// Group membership is separate from geometry, so a union box never obscures
// which cleaned source paragraphs it contains. Oversize groups say incomplete.
export function groupDiagnostics(result, width, height) {
  const groups=result?.groups || [], rows=groups.slice(0,48).map((g,i)=>{
    const b=g.boundsPx, ids=g.paragraphIds || [];
    const valid=Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&width>0&&height>0;
    return {id:g.id || `g${i}`,ids:ids.slice(0,12),count:ids.length,capturedRows:Math.min(12,ids.length),complete:ids.length<=12,
      reason:g.orientationFallback==='standalone_bounds'?'standalone_bounds':'main_columns',direction:g.direction || 'unknown',
      x:valid?b[0]/width:null,y:valid?b[1]/height:null,w:valid?(b[2]-b[0])/width:null,h:valid?(b[3]-b[1])/height:null};
  });
  const chunks=Math.max(1,Math.ceil(rows.length/12));
  return Array.from({length:chunks},(_,chunk)=>({schema:'tp.audit/1',event:'group_membership',reason:'main_columns',sourceKind:'original',
    totalRows:groups.length,capturedRows:rows.length,complete:groups.length===rows.length&&rows.every(r=>r.complete),chunk,chunks,rows:rows.slice(chunk*12,chunk*12+12)}));
}
