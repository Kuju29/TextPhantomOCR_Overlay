"""Pure geometry helpers for text boxes / baselines.

Coordinates in the tree are normalised 0..1; these helpers convert them to
pixel space and produce the rotated quadrilaterals (``quad``) that the
renderer and the eraser both consume.

A *token* here is any dict with a ``box`` and (optionally) ``baseline_p1`` /
``baseline_p2`` — items and spans both qualify.
"""

from __future__ import annotations

import copy
import math

# Lens reports the OCR baseline; the visual box is shifted down from it by a
# fraction of the text height.  These two tunables reproduce that shift.
BASELINE_SHIFT: bool = True
BASELINE_SHIFT_FACTOR: float = 0.40

Quad = list[tuple[float, float]]


def ensure_box_fields(box: dict | None) -> dict:
    """Return a copy of ``box`` with derived fields (center, *_pct) filled in.

    Lens boxes only carry ``left/top/width/height``; the renderer also wants a
    ``center`` and percentage variants.  Missing rotation defaults to 0.
    """
    if not isinstance(box, dict):
        return {}
    b = copy.deepcopy(box)
    b.setdefault("rotation_deg", 0.0)
    b.setdefault("rotation_deg_css", 0.0)

    has_rect = all(k in b for k in ("left", "top", "width", "height"))
    if has_rect:
        if "center" not in b:
            b["center"] = {
                "x": b["left"] + b["width"] / 2.0,
                "y": b["top"] + b["height"] / 2.0,
            }
        b.setdefault("left_pct", b["left"] * 100.0)
        b.setdefault("top_pct", b["top"] * 100.0)
        b.setdefault("width_pct", b["width"] * 100.0)
        b.setdefault("height_pct", b["height"] * 100.0)
    return b


def token_box_px(token: dict, W: int, H: int, pad_px: int = 0) -> tuple[int, int, int, int] | None:
    """Axis-aligned pixel bbox of a token's ``box`` (ignores rotation).

    Returns ``None`` if the box is degenerate or fully off-canvas.
    """
    b = token.get("box") or {}
    left = int(round(float(b.get("left", 0.0)) * W)) - pad_px
    top = int(round(float(b.get("top", 0.0)) * H)) - pad_px
    right = int(round((float(b.get("left", 0.0)) + float(b.get("width", 0.0))) * W)) + pad_px
    bottom = int(round((float(b.get("top", 0.0)) + float(b.get("height", 0.0))) * H)) + pad_px

    left = max(0, min(W, left))
    top = max(0, min(H, top))
    right = max(0, min(W, right))
    bottom = max(0, min(H, bottom))
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def token_quad_px(token: dict, W: int, H: int, pad_px: float = 0.0, apply_baseline_shift: bool = True) -> Quad | None:
    """Rotated quad built from a token's *baseline* + height.

    This is the precise text outline — it follows the baseline direction
    rather than an axis-aligned box, so it works for slanted text.
    Returns ``None`` for invalid / zero-length tokens.
    """
    if not token.get("valid_text"):
        return None

    p1 = token.get("baseline_p1") or {}
    p2 = token.get("baseline_p2") or {}
    x1 = float(p1.get("x", 0.0)) * W
    y1 = float(p1.get("y", 0.0)) * H
    x2 = float(p2.get("x", 0.0)) * W
    y2 = float(p2.get("y", 0.0)) * H

    dx = x2 - x1
    dy = y2 - y1
    # Normalise direction so the baseline always points left->right-ish.
    if dx < 0 or (abs(dx) < 1e-12 and dy < 0):
        x1, y1, x2, y2 = x2, y2, x1, y1
        dx, dy = x2 - x1, y2 - y1

    length = math.hypot(dx, dy)
    if length <= 1e-9:
        return None

    ux, uy = dx / length, dy / length
    nx, ny = -uy, ux
    if ny < 0:
        nx, ny = -nx, -ny

    t0 = float(token.get("t0_raw") if token.get("t0_raw") is not None else 0.0)
    t1 = float(token.get("t1_raw") if token.get("t1_raw") is not None else 1.0)

    sx = x1 + ux * (t0 * length)
    sy = y1 + uy * (t0 * length)
    ex = x1 + ux * (t1 * length)
    ey = y1 + uy * (t1 * length)

    h = max(1.0, float(token.get("height_raw") or 0.0) * H)
    if apply_baseline_shift and BASELINE_SHIFT:
        shift = h * BASELINE_SHIFT_FACTOR
        sx += nx * shift
        sy += ny * shift
        ex += nx * shift
        ey += ny * shift

    pad = max(0.0, float(pad_px))
    sx -= ux * pad
    sy -= uy * pad
    ex += ux * pad
    ey += uy * pad

    hh = (h / 2.0) + pad
    ox, oy = nx * hh, ny * hh
    return [(sx - ox, sy - oy), (ex - ox, ey - oy), (ex + ox, ey + oy), (sx + ox, sy + oy)]


def token_box_quad_px(token: dict, W: int, H: int, pad_px: float = 0.0) -> Quad | None:
    """Rotated quad built from a token's *box* (left/top/width/height + angle).

    Unlike :func:`token_quad_px` this uses the axis box rotated about its
    centre — used where the baseline is not needed (e.g. bounds computation).
    """
    b = token.get("box") or {}
    w = float(b.get("width", 0.0)) * W
    h = float(b.get("height", 0.0)) * H
    if w <= 0.0 or h <= 0.0:
        return None

    left = float(b.get("left", 0.0)) * W
    top = float(b.get("top", 0.0)) * H
    cx = left + (w / 2.0)
    cy = top + (h / 2.0)

    hw = (w / 2.0) + float(pad_px)
    hh = (h / 2.0) + float(pad_px)

    rad = math.radians(float(b.get("rotation_deg", 0.0)))
    c, s = math.cos(rad), math.sin(rad)

    out: Quad = []
    for x, y in [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]:
        out.append((cx + (x * c - y * s), cy + (x * s + y * c)))
    return out


def quad_bbox(quad: Quad, W: int, H: int) -> tuple[int, int, int, int] | None:
    """Integer axis-aligned bbox of a quad, clamped to the canvas."""
    xs = [p[0] for p in quad]
    ys = [p[1] for p in quad]
    left = max(0, min(W, int(math.floor(min(xs)))))
    top = max(0, min(H, int(math.floor(min(ys)))))
    right = max(0, min(W, int(math.ceil(max(xs)))))
    bottom = max(0, min(H, int(math.ceil(max(ys)))))
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def normalize_angle_deg(angle_deg: float) -> float:
    """Fold an angle into (-90, 90].

    Text rotated 200° is visually the same as 20°; the renderer only cares
    about that folded value.
    """
    while angle_deg <= -180.0:
        angle_deg += 360.0
    while angle_deg > 180.0:
        angle_deg -= 360.0
    if angle_deg < -90.0:
        angle_deg += 180.0
    if angle_deg > 90.0:
        angle_deg -= 180.0
    return angle_deg
