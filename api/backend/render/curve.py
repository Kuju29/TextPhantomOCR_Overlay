"""Curved-text support.

Google Lens never reports a curved baseline directly — instead it splits a
curved line into several short, *individually straight* items at slightly
different angles.  A single item therefore looks straight, but a run of
neighbouring items traces an arc.

This module reconstructs that arc:

- :func:`build_curve_map` looks at each item's position relative to its
  neighbours in the same paragraph and produces a signed "bow" offset in
  pixels (``curve_px``) — positive bows one way, negative the other.
- :func:`estimate_curve_px` clamps that raw value to something sane for a
  given item box / font size.
- :func:`warp_canvas_arc` bends a rendered RGBA strip into an arc (used by the
  image-overlay path).

The HTML renderer (:mod:`backend.render.tp_html`) consumes the curve map to
lay text out character-by-character along the arc — that is the fix for
"AI translations ignored curved / free-angle text".
"""

from __future__ import annotations

import math

import numpy as np
from PIL import Image

from backend.lens.tree import iter_paragraphs

# (para_index, item_index) -> signed curve offset in pixels.
CurveMap = dict[tuple[int, int], float]


def angle_diff_deg(a: float, b: float) -> float:
    """Smallest signed difference ``a - b`` folded into (-180, 180]."""
    d = float(a) - float(b)
    while d <= -180.0:
        d += 360.0
    while d > 180.0:
        d -= 360.0
    return d


def token_center_px(token: dict, W: int, H: int) -> tuple[float, float]:
    """Pixel centre of a token, preferring its explicit ``box.center``."""
    b = token.get("box") or {}
    c = b.get("center") or {}
    if "x" in c and "y" in c:
        return float(c.get("x") or 0.0) * W, float(c.get("y") or 0.0) * H
    left = float(b.get("left") or 0.0) * W
    top = float(b.get("top") or 0.0) * H
    width = float(b.get("width") or 0.0) * W
    height = float(b.get("height") or 0.0) * H
    return left + width / 2.0, top + height / 2.0


def token_tangent_normal_px(token: dict, W: int, H: int) -> tuple[float, float, float, float]:
    """Return ``(ux, uy, nx, ny)`` — unit tangent + normal of a token baseline.

    Falls back to the box rotation angle when no baseline points exist.
    """
    p1 = token.get("baseline_p1") or {}
    p2 = token.get("baseline_p2") or {}
    if "x" in p1 and "y" in p1 and "x" in p2 and "y" in p2:
        x1 = float(p1.get("x") or 0.0) * W
        y1 = float(p1.get("y") or 0.0) * H
        x2 = float(p2.get("x") or 0.0) * W
        y2 = float(p2.get("y") or 0.0) * H
        dx, dy = x2 - x1, y2 - y1
        length = math.hypot(dx, dy)
        if length > 1e-6:
            ux, uy = dx / length, dy / length
            return ux, uy, -uy, ux

    rad = math.radians(float((token.get("box") or {}).get("rotation_deg") or 0.0))
    ux, uy = math.cos(rad), math.sin(rad)
    return ux, uy, -uy, ux


def build_curve_map(tree: dict, W: int, H: int) -> CurveMap:
    """Estimate a signed curve offset (px) for every item in ``tree``.

    For each item we look at its previous / next sibling in the same
    paragraph.  An item that sits *off* the straight chord between its
    neighbours is on a curve; the perpendicular distance (plus a small bonus
    for sharp turns) becomes its ``curve_px``.  Tiny wobbles are zeroed out so
    nearly-straight text stays straight.
    """
    # Collect one geometry record per item.
    records: dict[tuple[int, int], dict[str, float]] = {}
    for pi, para in iter_paragraphs(tree):
        for ii, item in enumerate(para.get("items") or []):
            if not isinstance(item, dict):
                continue
            key = (pi, int(item.get("item_index", ii)))
            if key in records:
                continue
            cx, cy = token_center_px(item, W, H)
            ux, uy, nx, ny = token_tangent_normal_px(item, W, H)
            b = item.get("box") or {}
            records[key] = {
                "cx": cx, "cy": cy,
                "ux": ux, "uy": uy, "nx": nx, "ny": ny,
                "w": max(1.0, float(b.get("width") or 0.0) * W),
                "h": max(1.0, float(b.get("height") or 0.0) * H),
                "angle": float(b.get("rotation_deg") or 0.0),
            }

    # Group by paragraph and sort by item index.
    by_para: dict[int, list[tuple[int, dict[str, float]]]] = {}
    for (pi, ii), data in records.items():
        by_para.setdefault(pi, []).append((ii, data))

    out: CurveMap = {}
    for pi, entries in by_para.items():
        entries.sort(key=lambda e: e[0])
        n = len(entries)
        for idx, (ii, cur) in enumerate(entries):
            prev_data = entries[idx - 1][1] if idx > 0 else None
            next_data = entries[idx + 1][1] if (idx + 1) < n else None
            curve_px = 0.0

            if prev_data and next_data:
                # Perpendicular offset from the prev->next chord.
                ax, ay = prev_data["cx"], prev_data["cy"]
                bx, by = next_data["cx"], next_data["cy"]
                vx, vy = bx - ax, by - ay
                chord = math.hypot(vx, vy)
                if chord > 1e-6:
                    wx, wy = cur["cx"] - ax, cur["cy"] - ay
                    signed = ((vx * wy) - (vy * wx)) / chord
                    turn1 = math.degrees(math.atan2(cur["cy"] - ay, cur["cx"] - ax))
                    turn2 = math.degrees(math.atan2(by - cur["cy"], bx - cur["cx"]))
                    bend_deg = angle_diff_deg(turn2, turn1)
                    bend_sign = 1.0 if bend_deg >= 0.0 else -1.0
                    # Keep the offset sign consistent with the turn direction.
                    if signed != 0.0 and bend_deg != 0.0 and (1.0 if signed >= 0.0 else -1.0) != bend_sign:
                        signed = -signed
                    chord_span = max(cur["w"], chord * 0.5)
                    angle_bonus = min(cur["h"] * 0.32, chord_span * 0.1, abs(bend_deg) * 0.18)
                    curve_px = signed + (bend_sign * angle_bonus)
            elif prev_data or next_data:
                # Edge item: compare its own angle to the direction of its one neighbour.
                near = prev_data or next_data
                ref_angle = math.degrees(math.atan2(cur["cy"] - near["cy"], cur["cx"] - near["cx"]))
                bend_deg = angle_diff_deg(cur["angle"], ref_angle)
                if abs(bend_deg) >= 8.0:
                    sign = 1.0 if bend_deg >= 0.0 else -1.0
                    curve_px = sign * min(cur["h"] * 0.2, cur["w"] * 0.06, abs(bend_deg) * 0.2)

            if curve_px:
                limit = min(cur["h"] * 0.72, cur["w"] * 0.18, 42.0)
                if abs(curve_px) < max(2.0, cur["h"] * 0.12):
                    curve_px = 0.0  # ignore sub-pixel wobble
                else:
                    curve_px = max(-limit, min(limit, curve_px))
            out[(pi, ii)] = float(curve_px)

    return out


def estimate_curve_px(
    token: dict,
    curve_map: CurveMap,
    avail_w: float,
    avail_h: float,
    font_size: int,
    text_w: float,
    text_h: float,
) -> float:
    """Return a clamped curve offset (px) for a token, ready to render.

    Prefers the value from ``curve_map``; if absent, derives one from the
    token's own baseline-vs-centre offset.  Returns 0 when the curve is
    negligible.
    """
    pi = token.get("para_index")
    ii = token.get("item_index")
    curve_px = 0.0
    if pi is not None and ii is not None:
        curve_px = float(curve_map.get((int(pi), int(ii))) or 0.0)

    if not curve_px:
        b = token.get("box") or {}
        cx = float((b.get("center") or {}).get("x") or (float(b.get("left") or 0.0) + float(b.get("width") or 0.0) / 2.0))
        cy = float((b.get("center") or {}).get("y") or (float(b.get("top") or 0.0) + float(b.get("height") or 0.0) / 2.0))
        p1 = token.get("baseline_p1") or {}
        p2 = token.get("baseline_p2") or {}
        if "x" in p1 and "y" in p1 and "x" in p2 and "y" in p2:
            mx = (float(p1.get("x") or 0.0) + float(p2.get("x") or 0.0)) / 2.0
            my = (float(p1.get("y") or 0.0) + float(p2.get("y") or 0.0)) / 2.0
            _ux, _uy, nx, ny = token_tangent_normal_px(token, 1, 1)
            off = ((cx - mx) * nx) + ((cy - my) * ny)
            curve_px = float(off) * min(avail_w, avail_h)

    if not curve_px:
        return 0.0

    cap_h = max(text_h * 0.55, avail_h * 0.3)
    cap = min(
        max(4.0, cap_h),
        max(4.0, avail_h * 0.82),
        max(4.0, avail_w * 0.18),
        max(4.0, font_size * 0.95),
    )
    curve_px = max(-cap, min(cap, curve_px))
    return 0.0 if abs(curve_px) < 2.0 else float(curve_px)


def curve_height_extra_px(curve_px: float) -> float:
    """Extra vertical room a curved strip needs beyond its flat height."""
    return abs(float(curve_px)) * 0.9


def warp_canvas_arc(canvas: Image.Image, curve_px: float) -> Image.Image:
    """Bend an RGBA strip into a parabolic arc.

    Each column ``x`` is shifted vertically by ``curve_px * (1 - xn²)`` where
    ``xn`` is the column's position in [-1, 1].  Used by the image-overlay
    renderer; the HTML renderer arcs text with CSS instead.
    """
    curve = float(curve_px or 0.0)
    if abs(curve) < 1.0:
        return canvas
    arr = np.array(canvas, dtype=np.uint8)
    if arr.ndim != 3 or arr.shape[2] != 4:
        return canvas
    h, w, _ = arr.shape
    if h <= 0 or w <= 1:
        return canvas

    pad = int(math.ceil(abs(curve))) + 4
    out = np.zeros((h + pad * 2, w, 4), dtype=np.uint8)
    denom = float(max(1, w - 1))
    for x in range(w):
        xn = (2.0 * x / denom) - 1.0
        bow = 1.0 - (xn * xn)
        shift = int(round(curve * bow))
        y0 = pad + shift
        y1 = y0 + h
        src_top = 0
        src_bottom = h
        if y0 < 0:
            src_top = -y0
            y0 = 0
        if y1 > out.shape[0]:
            src_bottom = h - (y1 - out.shape[0])
            y1 = out.shape[0]
        if y1 <= y0 or src_bottom <= src_top:
            continue
        out[y0:y1, x, :] = arr[src_top:src_bottom, x, :]
    return Image.fromarray(out, mode="RGBA")
