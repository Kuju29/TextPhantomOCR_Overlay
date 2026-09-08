from __future__ import annotations
# from backend.render.region import box_rotation_deg, classify_item_axis, paragraph_reading_axis
from backend.render.ai_tree.geometry import item_aabb, item_aabb_from_bounds_px

def count_text_items(bg: dict) -> int:
    return sum((1 for it in bg.get('items') or [] if str(it.get('text') or '').strip()))

def is_single_set_group(bg: dict) -> bool:
    return count_text_items(bg) <= 1

def is_furigana_paragraph(bg: dict, bubble_groups: list[dict], img_w: int, img_h: int) -> bool:
    if not is_vertical_source_paragraph(bg):
        return False
    my = item_aabb_from_bounds_px(bg) or item_aabb(bg, img_w, img_h)
    if my is None:
        return False
    mx1, my1, mw, mh = my
    if mw <= 0:
        return False
    mx2 = mx1 + mw
    my2 = my1 + mh
    for other in bubble_groups:
        if other is bg:
            continue
        if not is_vertical_source_paragraph(other):
            continue
        ot = item_aabb_from_bounds_px(other) or item_aabb(other, img_w, img_h)
        if ot is None:
            continue
        ox1, oy1, ow, oh = ot
        if ow < 2.5 * mw:
            continue
        ox2 = ox1 + ow
        oy2 = oy1 + oh
        v_overlap = max(0.0, min(my2, oy2) - max(my1, oy1))
        if v_overlap < 0.5 * mh:
            continue
        gap = mx1 - ox2
        if -0.15 * mw <= gap <= 0.8 * mw:
            return True
    return False

def is_vertical_source_paragraph(bg: dict) -> bool:
    items = [it for it in bg.get('items') or [] if str(
        it.get('text') or '').strip()]
    if not items:
        return False
    n_axis = n_v = 0
    for it in items:
        r = float((it.get('box') or {}).get('rotation_deg') or 0.0)
        residual = (r + 45.0) % 90.0 - 45.0
        if abs(residual) > 12.0:
            continue
        n_axis += 1
        r_mod = r % 180.0
        if r_mod > 90.0:
            r_mod -= 180.0
        if abs(r_mod) > 45.0:
            n_v += 1
    if n_axis == 0:
        return False
    return n_v * 2 >= n_axis

def is_axis_aligned_group(bg: dict) -> bool:
    items = [it for it in bg.get('items') or [] if str(
        it.get('text') or '').strip()]
    if not items:
        return False
    axes: set[str] = set()
    for it in items:
        r = float((it.get('box') or {}).get('rotation_deg') or 0.0)
        residual = (r + 45.0) % 90.0 - 45.0
        if abs(residual) > 12.0:
            return False
        r_mod = r % 180.0
        if r_mod > 90.0:
            r_mod -= 180.0
        axes.add('v' if abs(r_mod) > 45.0 else 'h')
    return len(axes) == 1


def should_preserve_vertical_run(
    bg: dict, img_w: int, img_h: int, *, min_chars: int = 18,
    min_aspect: float = 5.0,
) -> bool:
    """Keep long, standalone vertical copy in its source direction.

    A page sidebar/sign is geometrically different from dialogue: Lens gives it
    one long narrow run rather than several neighbouring columns.  Rotating
    that run creates a very wide Thai banner and can make it collide with the
    page.  This predicate deliberately uses only OCR geometry and visible text
    mass; it has no page- or image-specific exceptions.
    """
    if not is_single_set_group(bg) or not is_vertical_source_paragraph(bg):
        return False
    bounds = item_aabb_from_bounds_px(bg) or item_aabb(bg, img_w, img_h)
    if bounds is None:
        return False
    _x, _y, width, height = bounds
    visible = sum(1 for char in str(bg.get("text") or "") if not char.isspace())
    return visible >= min_chars and height / max(1.0, width) >= min_aspect

def detect_image_orientation(bubble_groups: list[dict]) -> str:
    pool = [bg for bg in bubble_groups if not is_single_set_group(
        bg) and is_axis_aligned_group(bg)]
    if not pool:
        pool = [bg for bg in bubble_groups if is_axis_aligned_group(bg)]
    if not pool:
        return 'h'
    n_vert = sum((1 for bg in pool if str(bg.get('direction') or 'h') == 'v'))
    return 'v' if n_vert * 2 >= len(pool) else 'h'
