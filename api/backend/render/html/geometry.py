"""Geometry and shared font sizing for HTML overlays."""

from __future__ import annotations

import math
from typing import Any

from backend.render.components.typography import (
    MIN_FONT_PX as _MIN_FONT_PX,
    finite_number as _num,
    fit_item_font_size,
    fit_item_font_size_vertical,
)

def _item_rotated_aabb_px(
    item: dict, img_w: int, img_h: int
) -> tuple[float, float, float, float] | None:
    """Return the rotated item AABB in image pixels."""
    box = item.get("box") or {}
    w_n = _num(box.get("width"))
    h_n = _num(box.get("height"))
    if w_n <= 0 or h_n <= 0:
        return None

    center = box.get("center") or {}
    cx_n = _num(center.get("x"), _num(box.get("left")) + w_n / 2.0)
    cy_n = _num(center.get("y"), _num(box.get("top")) + h_n / 2.0)
    rot_deg = _num(box.get("rotation_deg_css"), _num(box.get("rotation_deg")))

    cx = cx_n * img_w
    cy = cy_n * img_h
    half_w = w_n * img_w / 2.0
    half_h = h_n * img_h / 2.0

    rad = math.radians(rot_deg)
    cos_a = math.cos(rad)
    sin_a = math.sin(rad)

    xs: list[float] = []
    ys: list[float] = []
    for ox, oy in ((-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)):
        xs.append(cx + ox * cos_a - oy * sin_a)
        ys.append(cy + ox * sin_a + oy * cos_a)

    left = min(xs)
    top = min(ys)
    width = max(xs) - left
    height = max(ys) - top
    if width <= 0 or height <= 0:
        return None
    return left, top, width, height

def _font_size_for_item(item: dict, img_w: int, img_h: int) -> int:
    """Pick (or read) the per-item font size for horizontal rendering."""
    fs_existing = _num(item.get("font_size_px"))
    if fs_existing >= _MIN_FONT_PX:
        return int(round(fs_existing))
    box = item.get("box") or {}
    width_pct = _num(box.get("width_pct"), _num(box.get("width")) * 100.0)
    height_pct = _num(box.get("height_pct"), _num(box.get("height")) * 100.0)
    text = str(item.get("text") or "")
    return fit_item_font_size(width_pct, height_pct, text, img_w, img_h)

def _shared_vertical_font_size(para: dict, img_w: int, img_h: int) -> int | None:
    """Return one fitted size for all vertical items in a paragraph."""
    sizes: list[int] = []
    for item in para.get("items") or []:
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        fs_existing = _num(item.get("font_size_px"))
        if fs_existing >= _MIN_FONT_PX:
            sizes.append(int(round(fs_existing)))
            continue
        aabb = _item_rotated_aabb_px(item, img_w, img_h)
        if aabb is None:
            continue
        _, _, w_px, h_px = aabb
        sizes.append(fit_item_font_size_vertical(w_px, h_px, text))
    if not sizes:
        return None
    return max(_MIN_FONT_PX, int(round(sum(sizes) / len(sizes))))

def _shared_horizontal_font_size(para: dict, img_w: int, img_h: int) -> int | None:
    """Return one fitted size for all horizontal items in a paragraph."""
    sizes: list[int] = []
    for item in para.get("items") or []:
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        fs_existing = _num(item.get("font_size_px"))
        if fs_existing >= _MIN_FONT_PX:
            sizes.append(int(round(fs_existing)))
            continue
        box = item.get("box") or {}
        width_pct = _num(box.get("width_pct"), _num(box.get("width")) * 100.0)
        height_pct = _num(box.get("height_pct"), _num(box.get("height")) * 100.0)
        sizes.append(fit_item_font_size(width_pct, height_pct, text, img_w, img_h))

    if not sizes:
        return None
    avg = sum(sizes) / len(sizes)
    return max(_MIN_FONT_PX, int(round(avg)))

def _para_bounds_px(
    para: dict, img_w: int, img_h: int
) -> tuple[float, float, float, float] | None:
    """Return bubble, paragraph, or recovered item bounds in that order."""
    bbp = para.get("bubble_bounds_px")
    if isinstance(bbp, (list, tuple)) and len(bbp) == 4:
        l, t, r, b = (_num(x) for x in bbp)
        if r > l and b > t:
            return (l, t, r - l, b - t)

    bp = para.get("bounds_px")
    if isinstance(bp, (list, tuple)) and len(bp) == 4:
        l, t, r, b = (_num(x) for x in bp)
        if r > l and b > t:
            return (l, t, r - l, b - t)

    lefts: list[float] = []
    tops: list[float] = []
    rights: list[float] = []
    bottoms: list[float] = []
    for it in para.get("items") or []:
        aabb = _item_rotated_aabb_px(it, img_w, img_h)
        if aabb is None:
            continue
        l, t, w, h = aabb
        lefts.append(l)
        tops.append(t)
        rights.append(l + w)
        bottoms.append(t + h)
    if not lefts:
        return None
    left = min(lefts)
    top = min(tops)
    width = max(rights) - left
    height = max(bottoms) - top
    if width <= 0 or height <= 0:
        return None
    return (left, top, width, height)

def _paragraph_source_is_vertical(para: dict) -> bool:
    """True when most of the paragraph's items have a vertical baseline.

    Lens decodes each line of vertical Japanese / Chinese text as an item
    whose ``rotation_deg`` is near ±90°.  When we translate such a bubble
    into a *horizontal* target (Thai / Latin / Cyrillic / …), rendering
    per-item with the same rotation would leave the translation lying
    sideways like the source — unreadable.  This predicate gates the
    "bubble-block" path that re-orients the AI output into the bubble's
    axis-aligned footprint.

    A paragraph is considered vertical when at least half of its
    text-bearing items have ``|rotation_deg| > 78°`` (a true vertical column);
    steeply-tilted horizontal labels (≈ 60–78°) stay horizontal and keep
    their tilt.
    """
    items = para.get("items") or []
    if not items:
        return False
    n_total = n_vert = 0
    for it in items:
        text = str(it.get("text") or "").strip()
        if not text:
            continue
        n_total += 1
        rot = _num((it.get("box") or {}).get("rotation_deg"), 0.0)
        if abs(rot) > 78.0:
            n_vert += 1
    return n_total > 0 and (n_vert / n_total) >= 0.5


def _item_reads_vertically(item: dict, img_w: int, img_h: int) -> bool:
    box = item.get("box") or {}
    angle = _num(box.get("rotation_deg_css"), _num(box.get("rotation_deg"))) % 180
    if abs(angle - 90) <= 12:
        return True
    if min(angle, 180 - angle) > 12:
        return False
    aabb = _item_rotated_aabb_px(item, img_w, img_h)
    return bool(aabb and aabb[3] >= 1.35 * aabb[2])
