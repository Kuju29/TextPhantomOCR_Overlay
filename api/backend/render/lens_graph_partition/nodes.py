"""Convert mutable Lens dictionaries into immutable geometry nodes."""
from __future__ import annotations

from statistics import median
from typing import Any

from .model import Rect, VerticalNode


def _rect(value: Any) -> Rect | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        x1, y1, x2, y2 = (float(v) for v in value)
    except (TypeError, ValueError):
        return None
    return (x1, y1, x2, y2) if x2 > x1 and y2 > y1 else None


def _text(para: dict) -> str:
    own = str(para.get("text") or "")
    if own.strip():
        return own
    return "".join(str(item.get("text") or "")
                   for item in para.get("items") or [])


def extract_nodes(tree: dict, item_exclusions: dict | None = None) -> tuple[VerticalNode, ...]:
    """Inventory every nonblank Lens paragraph without changing its text.

    Invalid or missing geometry is deliberately retained.  The partitioner
    accounts for it as unresolved instead of silently losing OCR content.
    """
    nodes = []
    for position, para in enumerate(tree.get("paragraphs") or []):
        if not isinstance(para, dict):
            continue
        text = _text(para)
        if not text.strip():
            continue
        pid = str(para.get("id") or f"p{position}")
        excluded = set((item_exclusions or {}).get(pid, ()))
        bounds = None if excluded else _rect(para.get("bounds_px"))
        item_bounds = tuple(rect for i, item in enumerate(para.get("items") or [])
                            if i not in excluded and isinstance(item,dict)
                            and (rect := _rect(item.get("bounds_px"))) is not None)
        if bounds is None and item_bounds:
            # Some valid Lens responses omit the paragraph envelope while
            # retaining every item rectangle.  Their deterministic union is
            # equivalent grouping geometry, not a reason to reject the page.
            bounds = (
                min(rect[0] for rect in item_bounds),
                min(rect[1] for rect in item_bounds),
                max(rect[2] for rect in item_bounds),
                max(rect[3] for rect in item_bounds),
            )
        widths = [rect[2] - rect[0] for rect in item_bounds
                  if rect[2] - rect[0] > 1]
        glyph = median(widths) if widths else (
            bounds[2] - bounds[0] if bounds is not None else None)
        nodes.append(VerticalNode(
            paragraph_id=str(para.get("id") or f"p{position}"),
            paragraph_index=int(para.get("para_index", position)),
            bounds=bounds, text=text,
            glyph_px=max(1.0, glyph) if glyph is not None else None,
            item_bounds=item_bounds,
            container_id=(str(para["container_id"])
                          if para.get("container_id") is not None else None),
        ))
    return tuple(nodes)
