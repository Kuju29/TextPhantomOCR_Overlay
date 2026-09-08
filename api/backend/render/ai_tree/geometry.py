from __future__ import annotations

import math

def item_aabb(bg: dict, img_w: int, img_h: int) -> tuple[float, float, float, float] | None:
    lefts: list[float] = []
    tops: list[float] = []
    rights: list[float] = []
    bots: list[float] = []
    for it in bg.get('items') or []:
        box = it.get('box') or {}
        l = float(box.get('left') or 0.0) * img_w
        t = float(box.get('top') or 0.0) * img_h
        w = float(box.get('width') or 0.0) * img_w
        h = float(box.get('height') or 0.0) * img_h
        if w > 0 and h > 0:
            lefts.append(l)
            tops.append(t)
            rights.append(l + w)
            bots.append(t + h)
    if lefts:
        l0, t0 = (min(lefts), min(tops))
        return (l0, t0, max(rights) - l0, max(bots) - t0)
    return None

def item_aabb_from_bounds_px(bg: dict) -> tuple[float, float, float, float] | None:
    x1s: list[float] = []
    y1s: list[float] = []
    x2s: list[float] = []
    y2s: list[float] = []
    for it in bg.get('items') or []:
        if not str(it.get('text') or '').strip():
            continue
        bpx = it.get('bounds_px')
        if not isinstance(bpx, (list, tuple)) or len(bpx) != 4:
            continue
        x1s.append(float(bpx[0]))
        y1s.append(float(bpx[1]))
        x2s.append(float(bpx[2]))
        y2s.append(float(bpx[3]))
    if not x1s:
        return None
    x1, y1 = (min(x1s), min(y1s))
    return (x1, y1, max(x2s) - x1, max(y2s) - y1)

def make_box_from_bounds_px(x1: float, y1: float, w_px: float, h_px: float, rot: float, img_w: int, img_h: int) -> dict:
    iw, ih = (float(max(1, img_w)), float(max(1, img_h)))
    left, top, width, height = (x1 / iw, y1 / ih, w_px / iw, h_px / ih)
    return {'left': left, 'top': top, 'width': width, 'height': height, 'left_pct': left * 100.0, 'top_pct': top * 100.0, 'width_pct': width * 100.0, 'height_pct': height * 100.0, 'rotation_deg': rot, 'rotation_deg_css': rot, 'center': {'x': left + width / 2.0, 'y': top + height / 2.0}}

def bubble_canvas(bg: dict, img_w: int, img_h: int, prefer_bounds: bool = True) -> tuple[float, float, float, float] | None:
    if prefer_bounds:
        bb = bg.get('bubble_bounds_px')
        if isinstance(bb, (list, tuple)) and len(bb) == 4:
            x1, y1, x2, y2 = (float(v) for v in bb)
            w, h = (x2 - x1, y2 - y1)
            if w > 0 and h > 0:
                return (x1, y1, w, h)
    aabb = item_aabb_from_bounds_px(bg)
    if aabb is not None:
        return aabb
    aabb = item_aabb(bg, img_w, img_h)
    if aabb is not None:
        return aabb
    if not prefer_bounds:
        bb = bg.get('bubble_bounds_px')
        if isinstance(bb, (list, tuple)) and len(bb) == 4:
            x1, y1, x2, y2 = (float(v) for v in bb)
            w, h = (x2 - x1, y2 - y1)
            if w > 0 and h > 0:
                return (x1, y1, w, h)
    return None

def estimate_n_lines(text: str, canvas_w_px: float, canvas_h_px: float, font_px: float, direction: str) -> int:
    char_count = sum((1 for char in text if not char.isspace()))
    if not char_count:
        return 1
    extent = canvas_h_px if direction == 'v' else canvas_w_px
    glyph = font_px if direction == 'v' else font_px * 0.65
    chars_per_line = max(1.0, extent / max(1.0, glyph))
    return max(1, min(20, math.ceil(char_count / chars_per_line)))

def make_item_box(line_idx: int, n_lines: int, canvas_left: float, canvas_top: float, canvas_w: float, canvas_h: float, font_px: float, direction: str, img_w: int, img_h: int, source_rot_deg: float = 0.0) -> dict:
    iw, ih = (float(max(1, img_w)), float(max(1, img_h)))
    if direction == 'v':
        col_w = canvas_w / max(1, n_lines)
        left_px = canvas_left + canvas_w - (line_idx + 1) * col_w
        top_px = canvas_top
        w_px = col_w
        h_px = canvas_h
        rot = 90.0
    else:
        row_h = canvas_h / max(1, n_lines)
        left_px = canvas_left
        top_px = canvas_top + line_idx * row_h
        w_px = canvas_w
        h_px = row_h
        rot = source_rot_deg
    left_n = left_px / iw
    top_n = top_px / ih
    w_n = w_px / iw
    h_n = h_px / ih
    cx_n = left_n + w_n / 2.0
    cy_n = top_n + h_n / 2.0
    return {'left': left_n, 'top': top_n, 'width': w_n, 'height': h_n, 'left_pct': left_n * 100.0, 'top_pct': top_n * 100.0, 'width_pct': w_n * 100.0, 'height_pct': h_n * 100.0, 'rotation_deg': rot, 'rotation_deg_css': rot, 'center': {'x': cx_n, 'y': cy_n}}

def source_rotation_canvas(bg: dict) -> tuple[float, float, float, float, float] | None:
    items = [it for it in bg.get('items') or [] if str(
        it.get('text') or '').strip()]
    if not items:
        return None
    rots = [float((it.get('box') or {}).get('rotation_deg') or 0.0)
            for it in items]
    avg_rot = sum(rots) / len(rots)
    if max(rots) - min(rots) > 20.0:
        return None
    lefts: list[float] = []
    tops: list[float] = []
    rights: list[float] = []
    bots: list[float] = []
    for it in items:
        box = it.get('box') or {}
        l = float(box.get('left') or 0.0)
        t = float(box.get('top') or 0.0)
        w = float(box.get('width') or 0.0)
        h = float(box.get('height') or 0.0)
        if w > 0 and h > 0:
            lefts.append(l)
            tops.append(t)
            rights.append(l + w)
            bots.append(t + h)
    if not lefts:
        return None
    l0, t0 = (min(lefts), min(tops))
    w0 = max(rights) - l0
    h0 = max(bots) - t0
    if w0 <= 0 or h0 <= 0:
        return None
    return (l0, t0, w0, h0, avg_rot)

def expand_canvas_for_rotation(src_aabb: tuple[float, float, float, float], other_bounds: list[tuple[float, float, float, float]], target_direction: str, img_w: int, img_h: int, aspect_target: float = 1.5, margin: float = 2.0) -> tuple[float, float, float, float]:
    sx, sy, sw, sh = src_aabb
    if sw <= 0 or sh <= 0:
        return src_aabb
    area = sw * sh
    cx = sx + sw / 2.0
    cy = sy + sh / 2.0
    is_v_source = sh > sw
    if target_direction == 'h' and is_v_source:
        ideal_w = math.sqrt(area * aspect_target)
        new_w = max(sw, ideal_w)
        new_left = cx - new_w / 2.0
        new_right = cx + new_w / 2.0
        new_left = max(0.0, new_left)
        new_right = min(float(img_w), new_right)
        for ox1, oy1, ox2, oy2 in other_bounds:
            if oy2 <= sy or oy1 >= sy + sh:
                continue
            if ox2 <= sx and ox2 > new_left:
                new_left = ox2 + margin
            if ox1 >= sx + sw and ox1 < new_right:
                new_right = ox1 - margin
        new_w = max(sw, new_right - new_left)
        return (new_left, sy, new_w, sh)
    if target_direction == 'v' and (not is_v_source):
        ideal_h = math.sqrt(area / aspect_target)
        new_h = max(sh, ideal_h)
        new_top = cy - new_h / 2.0
        new_bot = cy + new_h / 2.0
        new_top = max(0.0, new_top)
        new_bot = min(float(img_h), new_bot)
        for ox1, oy1, ox2, oy2 in other_bounds:
            if ox2 <= sx or ox1 >= sx + sw:
                continue
            if oy2 <= sy and oy2 > new_top:
                new_top = oy2 + margin
            if oy1 >= sy + sh and oy1 < new_bot:
                new_bot = oy1 - margin
        new_h = max(sh, new_bot - new_top)
        return (sx, new_top, sw, new_h)
    return src_aabb

def canvas_for_source(bg: dict, direction_change: bool, target_direction: str, all_para_bounds: list[tuple[float, float, float, float]], is_tilted: bool, is_curved: bool, avg_rot: float, img_w: int, img_h: int) -> tuple[tuple[float, float, float, float] | None, bool, float]:
    aabb = item_aabb_from_bounds_px(bg) or item_aabb(bg, img_w, img_h)
    if aabb is None:
        return (None, False, 0.0)
    if direction_change:
        my_box = (aabb[0], aabb[1], aabb[0] + aabb[2], aabb[1] + aabb[3])
        others = [b for b in all_para_bounds if b != my_box]
        aabb = expand_canvas_for_rotation(
            aabb, others, target_direction, img_w, img_h)
        return (aabb, False, 0.0)
    source_rot_deg = avg_rot if is_tilted or is_curved else 0.0
    return (aabb, True, source_rot_deg)
