"""Bounded geometry-only diagnostic views; no source text or decision feedback."""
from __future__ import annotations
import math

def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)

def geometry_diagnostics(tree, width, height, reason="source_geometry", source_kind="original", max_rows=48):
    rows = []
    total = 0
    for pi, para in enumerate(tree.get("paragraphs") or []):
        for ii, item in enumerate(para.get("items") or []):
            total += 1
            if len(rows) >= max_rows:
                continue
            bounds = item.get("bounds_px") or para.get("bounds_px")
            valid = isinstance(bounds, list) and len(bounds) == 4 and all(map(_finite, bounds)) and width > 0 and height > 0
            raw = para.get("para_index")
            angle = (item.get("box") or {}).get("rotation_deg")
            rows.append(dict(id=f"p{pi}", itemIndex=ii, rawIndex=raw if type(raw) is int else pi,
                x=bounds[0]/width if valid else None, y=bounds[1]/height if valid else None,
                w=(bounds[2]-bounds[0])/width if valid else None, h=(bounds[3]-bounds[1])/height if valid else None,
                rotation=angle if _finite(angle) else None))
    chunks = max(1, (len(rows) + 11) // 12)
    return [dict(schema="tp.audit/1", event="geometry_snapshot", reason=reason, sourceKind=source_kind,
        totalRows=total, capturedRows=len(rows), complete=len(rows) == total, chunk=n, chunks=chunks,
        rows=rows[n*12:n*12+12]) for n in range(chunks)]

def ruby_diagnostics(report):
    annotations = report.get("annotations") or []
    return dict(schema="tp.audit/1", event="ruby_filter", reason="detected_ruby", sourceKind="original",
        counts=dict(removedCount=report.get("itemsDropped",0)+report.get("spansDropped",0), fallbackCount=report.get("ambiguousCandidates",0)),
        totalRows=len(annotations), capturedRows=min(12,len(annotations)), complete=len(annotations)<=12,
        rows=[dict(id=f"p{a['paragraph']}", itemIndex=a['item'], spanIndex=a['span'], ref=f"p{a['ownerParagraph']}",direction=a['axis']) for a in annotations[:12]])

def group_diagnostics(result, width, height):
    groups = result.get("groups") or []
    rows = []
    for index, group in enumerate(groups[:48]):
        b = group.get("boundsPx")
        ids = group.get("paragraphIds") or []
        valid = isinstance(b, list) and len(b) == 4 and all(map(_finite, b)) and width > 0 and height > 0
        rows.append(dict(id=group.get("id") or f"g{index}", ids=ids[:12], count=len(ids), capturedRows=min(12,len(ids)), complete=len(ids)<=12,
            reason="standalone_bounds" if group.get("orientationFallback")=="standalone_bounds" else "main_columns", direction=group.get("direction") or "unknown",
            x=b[0]/width if valid else None,y=b[1]/height if valid else None,w=(b[2]-b[0])/width if valid else None,h=(b[3]-b[1])/height if valid else None))
    chunks = max(1,(len(rows)+11)//12)
    return [dict(schema="tp.audit/1",event="group_membership",reason="main_columns",sourceKind="original",totalRows=len(groups),capturedRows=len(rows),
        complete=len(groups)==len(rows) and all(row["complete"] for row in rows),chunk=chunk,chunks=chunks,rows=rows[chunk*12:chunk*12+12]) for chunk in range(chunks)]


def emit_group_diagnostics(result, width, height):
    """Diagnostics cannot change the grouping result, even for a bad diagnostic projection."""
    from backend import trace
    if trace.enabled():
        try:
            for event in group_diagnostics(result,width,height):
                trace.note("groupMembership",event)
        except (TypeError,ValueError,KeyError):
            trace.note("groupMembership",dict(schema="tp.audit/1",event="group_membership",reason="failed",complete=False))
