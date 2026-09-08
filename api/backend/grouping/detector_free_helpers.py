"""Pure helpers for the Lens graph grouping service.

No helper imports a detector or model runtime. All source text
and item decisions remain member-addressed so a caller can audit omissions.
"""
from __future__ import annotations

from statistics import median
from typing import Any
import unicodedata
import math


def paragraph_id(paragraph: dict[str, Any], position: int) -> str:
    return str(paragraph.get("id") or f"p{position}")


def paragraph_text(paragraph: dict[str, Any]) -> str:
    own = paragraph.get("text")
    if own is not None and str(own).strip():
        return str(own)
    return "".join(str(item.get("text") or "")
                   for item in paragraph.get("items") or []
                   if isinstance(item, dict))


def group_separator(parts: list[str]) -> str:
    letters = [char for text in parts for char in text
               if unicodedata.category(char).startswith("L")]
    if not letters:
        return ""
    cjk = sum(0x3040 <= ord(char) <= 0x9FFF for char in letters)
    return "" if cjk * 2 >= len(letters) else " "


def rect(paragraph: dict[str, Any]) -> tuple[float, float, float, float] | None:
    for key in ("bubble_bounds_px", "bounds_px"):
        value = paragraph.get(key)
        if isinstance(value, (list, tuple)) and len(value) == 4:
            try:
                x1, y1, x2, y2 = (float(item) for item in value)
            except (TypeError, ValueError):
                continue
            if all(math.isfinite(v) for v in (x1,y1,x2,y2)) and x2 > x1 and y2 > y1:
                return x1, y1, x2, y2
    return None


def union_bounds(paragraphs: list[dict[str, Any]]) -> list[float] | None:
    values = [value for paragraph in paragraphs
              if (value := rect(paragraph)) is not None]
    if not values:
        return None
    return [min(v[0] for v in values), min(v[1] for v in values),
            max(v[2] for v in values), max(v[3] for v in values)]


def font_px(paragraphs: list[dict[str, Any]]) -> float:
    widths = []
    for paragraph in paragraphs:
        for item in paragraph.get("items") or []:
            if not isinstance(item, dict):
                continue
            value = item.get("bounds_px")
            if isinstance(value, (list, tuple)) and len(value) == 4:
                try:
                    width = float(value[2]) - float(value[0])
                except (TypeError, ValueError):
                    continue
                if width > 0:
                    widths.append(width)
    return round(float(median(widths)), 3) if widths else 0.0


def paragraph_orientation(paragraph: dict[str, Any]) -> tuple[str, float | None]:
    """Classify the OCR flow axis from its rendered geometry and baseline.

    Lens commonly reports near-zero baselines for Japanese vertical columns:
    each glyph baseline is horizontal even though the sequence advances down
    the page.  Therefore rotation alone is not a reading-axis contract.  A
    clearly tall/wide item envelope is authoritative; rotation resolves only
    the near-square remainder.
    """
    rotations = []
    aspects = []
    for item in paragraph.get("items") or []:
        if not isinstance(item, dict):
            continue
        bounds = item.get("bounds_px")
        if isinstance(bounds, (list, tuple)) and len(bounds) == 4:
            try:
                width = float(bounds[2]) - float(bounds[0])
                height = float(bounds[3]) - float(bounds[1])
            except (TypeError, ValueError):
                width = height = 0.0
            if math.isfinite(width) and math.isfinite(height) and width > 0.0 and height > 0.0:
                aspects.append(height / width)
        box = item.get("box") if isinstance(item.get("box"), dict) else {}
        value = box.get("rotation_deg", item.get("rotation_deg"))
        try:
            angle = float(value)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(angle):
            continue
        # Canonical signed equivalent in [-180, 180).
        rotations.append((angle + 180.0) % 360.0 - 180.0)
    actual = float(median(rotations)) if rotations else None
    if aspects:
        flow_aspect = float(median(aspects))
        if flow_aspect >= 1.35:
            return "v", round(actual if actual is not None else 90.0, 3)
        if flow_aspect <= (1.0 / 1.35):
            return "h", round(actual if actual is not None else 0.0, 3)
    if actual is None:
        return "unknown", None
    axis = "v" if 45.0 <= abs(actual) <= 135.0 else "h"
    return axis, round(actual, 3)


def group_orientation(paragraphs: list[dict[str, Any]]) -> tuple[str, float]:
    classified = [paragraph_orientation(paragraph) for paragraph in paragraphs]
    known = [(axis, rotation) for axis, rotation in classified
             if axis != "unknown" and rotation is not None]
    if not known:
        raise ValueError("group orientation is unknown")
    vertical = sum(axis == "v" for axis, _ in known) * 2 >= len(known)
    selected = [rotation for axis, rotation in known
                if (axis == "v") == vertical]
    return ("v" if vertical else "h", round(float(median(selected)), 3))


def explicit_item_policy(paragraph: dict[str, Any], inferred_ruby_indices=()) -> tuple[dict[str, Any], str, list[int]]:
    """Apply explicit/uniquely-proven item indices, retaining auditable raw text."""
    items = list(paragraph.get("items") or [])
    text_indices = [i for i, item in enumerate(items)
                    if isinstance(item, dict) and str(item.get("text") or "").strip()]
    dropped = [i for i in text_indices if i in inferred_ruby_indices or bool(items[i].get("is_ruby")) or
               str(items[i].get("role") or "").lower() == "ruby"]
    retained = [i for i in text_indices if i not in dropped]
    if not dropped or not retained:
        return {"mode": "full"}, paragraph_text(paragraph), []
    separator = group_separator([str(items[i].get("text") or "") for i in retained])
    translated = separator.join(str(items[i].get("text") or "") for i in retained)
    return ({"mode": "item_subset", "retainedItemIndices": retained,
             "separator": separator}, translated, dropped)
