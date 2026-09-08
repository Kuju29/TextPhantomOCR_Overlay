from __future__ import annotations

from typing import Any

import unicodedata, math

from backend.lens.languages import normalize as normalize_lang
from backend.render.fonts import budoux_parser
from backend.render.layout import distribute_to_template, pad_lines, font_size_minimum_for_image
from backend.render.region import direction_preset, is_cjk_text, resolve_text_direction
# from backend.render.components.typography import fit_item_font_size
from backend.render.ai_tree.geometry import canvas_for_source, item_aabb, item_aabb_from_bounds_px, make_box_from_bounds_px, make_item_box
from backend.render.ai_tree.orientation import detect_image_orientation, is_axis_aligned_group, is_furigana_paragraph, is_single_set_group, is_vertical_source_paragraph, should_preserve_vertical_run
from backend.render.ai_tree.spans import build_item_spans, join_line_tokens

def build_ai_tree(bubble_groups: list[dict], ai_group_texts: list[str], original_tree: dict, target_lang: str, img_w: int, img_h: int) -> dict[str, Any]:
    lang_norm = normalize_lang(target_lang)
    parser = budoux_parser(lang_norm)
    min_size_px = font_size_minimum_for_image(img_w, img_h)
    bb_count: dict[tuple[float, ...], int] = {}
    for _bg in bubble_groups:
        _bb = _bg.get('bubble_bounds_px')
        if isinstance(_bb, (list, tuple)) and len(_bb) == 4:
            _key = tuple((round(float(v), 1) for v in _bb))
            bb_count[_key] = bb_count.get(_key, 0) + 1
    all_para_bounds: list[tuple[float, float, float, float]] = []
    for _bg in bubble_groups:
        _ab = item_aabb_from_bounds_px(_bg) or item_aabb(_bg, img_w, img_h)
        if _ab is None:
            continue
        all_para_bounds.append(
            (_ab[0], _ab[1], _ab[0] + _ab[2], _ab[1] + _ab[3]))
    lang_preset = direction_preset(target_lang)
    image_orientation = detect_image_orientation(bubble_groups)
    if lang_preset in ('h', 'hr'):
        target_orientation = 'h'
    elif lang_preset == 'v':
        target_orientation = 'v'
    elif lang_preset == 'auto':
        target_orientation = 'v'
    else:
        target_orientation = image_orientation
    image_rotates = image_orientation != target_orientation
    out_paragraphs: list[dict[str, Any]] = []
    for gi, bg in enumerate(bubble_groups):
        group_text = ai_group_texts[gi] if gi < len(ai_group_texts) else ''
        group_text = (group_text or '').strip()
        src_text = str(bg.get('text') or '').strip()
        src_visible = [c for c in src_text if not c.isspace()]
        significant_singleton = bool(src_visible) and all(
            (unicodedata.category(c)[0] in ('N', 'P', 'S') for c in src_visible))
        if len(src_visible) < 2 and (not significant_singleton):
            continue
        if is_furigana_paragraph(bg, bubble_groups, img_w, img_h):
            continue
        src_text_items = [it for it in bg.get(
            'items') or [] if str(it.get('text') or '').strip()]
        src_rots = [float((it.get('box') or {}).get(
            'rotation_deg') or 0.0) for it in src_text_items]
        avg_rot = sum(src_rots) / len(src_rots) if src_rots else 0.0
        rot_spread = max(src_rots) - \
            min(src_rots) if len(src_rots) > 1 else 0.0
        is_tilted = abs(avg_rot) > 5.0
        is_curved = rot_spread > 3.0
        is_single_set = is_single_set_group(bg)
        is_axis_aligned = is_axis_aligned_group(bg)
        preserve_vertical_run = should_preserve_vertical_run(bg, img_w, img_h)
        # residual_tilt = (avg_rot + 45.0) % 90.0 - 45.0
        is_decorative_label = not is_axis_aligned
        if is_axis_aligned:
            direction = target_orientation
            direction_change = image_rotates
        else:
            direction = str(bg.get('direction') or 'h')
            direction_change = False
        # A long, isolated vertical sidebar/sign is not dialogue.  Keep its
        # direction and original geometry even on a page whose dialogue is
        # converted to horizontal Thai.  Short ~90-degree singleton labels
        # still follow the ordinary direction-change path.
        if preserve_vertical_run:
            direction = 'v'
            direction_change = False
        if direction_change and direction == 'v' and (not is_vertical_source_paragraph(bg)):
            src_aabb_chk = item_aabb_from_bounds_px(
                bg) or item_aabb(bg, img_w, img_h)
            n_src_lines = len(src_text_items)
            if src_aabb_chk is not None:
                _sw, _sh = (src_aabb_chk[2], src_aabb_chk[3])
                if n_src_lines <= 1 and _sw > 4.0 * max(1.0, _sh):
                    direction = 'h'
                    direction_change = False
        _bb = bg.get('bubble_bounds_px')
        # prefer_bb = True
        if isinstance(_bb, (list, tuple)) and len(_bb) == 4:
            _key = tuple((round(float(v), 1) for v in _bb))
            # prefer_bb = bb_count.get(_key, 1) == 1
        aabb, use_per_item_rotation, source_rot_deg = canvas_for_source(
            bg, direction_change, direction, all_para_bounds, is_tilted, is_curved, avg_rot, img_w, img_h)
        if aabb is None:
            continue
        canvas_left, canvas_top, canvas_w, canvas_h = aabb
        if canvas_w <= 0 or canvas_h <= 0:
            continue
        # Horizontal target text always gets a newly distributed row grid.
        # Reusing Lens's source fragments made Thai phrases land in arbitrary
        # OCR slices (e.g. คิ / ถึงมา / กเลย).  Decorative/free-angle text and
        # preserved vertical sidebars keep their exact source boxes instead.
        synthesized_horizontal = bool(is_axis_aligned and direction == 'h')
        if synthesized_horizontal:
            use_per_item_rotation = False
            source_rot_deg = 0.0
        canvas_left = max(0.0, min(canvas_left, float(img_w) - 1.0))
        canvas_top = max(0.0, min(canvas_top, float(img_h) - 1.0))
        canvas_w = min(canvas_w, float(img_w) - canvas_left)
        canvas_h = min(canvas_h, float(img_h) - canvas_top)
        _n_chars = sum((1 for _c in group_text if not _c.isspace()))
        glyph_ratio = 1.0 if is_cjk_text(group_text) else 0.55
        src_font_px = max(float(min_size_px), float(
            bg.get('font_size_px') or 0.0))
        src_glyph_heights = []
        for it in src_text_items:
            box = it.get('box') or {}
            rot = abs(float(box.get('rotation_deg') or 0.0)) % 180.0
            # Glyph height is perpendicular to the reading baseline.  For a
            # near-vertical Lens run that is box width, not its (often very
            # long) column height.
            if 45.0 < rot < 135.0:
                glyph_h = float(box.get('width') or 0.0) * img_w
            else:
                glyph_h = float(box.get('height') or 0.0) * img_h
            src_glyph_heights.append(glyph_h)
        src_glyph_heights = [h for h in src_glyph_heights if h > 1.0]
        measured_source_cap = max(src_glyph_heights) if src_glyph_heights else src_font_px
        src_max_glyph_px = min(src_font_px, measured_source_cap)
        if _n_chars > 1 and canvas_w > 0 and (canvas_h > 0):
            area_cap = math.sqrt(canvas_w * canvas_h /
                                 max(1.0, _n_chars * glyph_ratio * 1.2))
        else:
            area_cap = float(max(canvas_w, canvas_h, min_size_px))
        if direction_change:
            cand_font = min(area_cap, src_max_glyph_px)
        else:
            cand_font = min(src_font_px, area_cap)
        cand_font = max(float(min_size_px), cand_font)

        def _grid_font(nl: int) -> float:
            cpl = math.ceil(_n_chars / nl) if _n_chars else 1
            if direction == 'h':
                along = canvas_w / max(1, cpl) / max(0.1, glyph_ratio)
                across = canvas_h / (nl * 1.15)
            else:
                along = canvas_h / max(1, cpl)
                across = canvas_w / max(1, nl)
            return min(along, across)

        def _wrap_units(text: str) -> int:
            if not text:
                return 1
            if parser is not None:
                try:
                    chunks = [c for c in parser.parse(text) if c]
                    if chunks:
                        return len(chunks)
                except Exception:
                    pass
            words = [w for w in text.split() if w]
            return max(1, len(words))
        if direction_change or synthesized_horizontal:
            wrap_cap = min(20, max(1, _wrap_units(group_text)))
            n_lines = 1
            best_fit = _grid_font(n_lines)
            while n_lines < wrap_cap:
                nxt = _grid_font(n_lines + 1)
                if nxt <= best_fit:
                    break
                n_lines += 1
                best_fit = nxt
        else:
            n_lines = max(1, len(src_text_items))
            best_fit = _grid_font(n_lines)
            while n_lines < 20 and best_fit < float(min_size_px):
                nxt = _grid_font(n_lines + 1)
                if nxt <= best_fit:
                    break
                n_lines += 1
                best_fit = nxt
        font_px = max(float(min_size_px), min(cand_font, _grid_font(n_lines)))
        if direction_change and direction == 'h':
            # Converted vertical boxes need breathing room: glyph metrics and
            # CSS line-height can otherwise extend beyond a mathematically
            # exact fit.  Keep a 12% safety margin without violating the
            # global readability floor.
            font_px = max(float(min_size_px), font_px * 0.88)
        template_items: list[dict] = []
        for li in range(n_lines):
            if use_per_item_rotation and li < len(src_text_items):
                src_it = src_text_items[li]
                src_rot = float((src_it.get('box') or {}).get(
                    'rotation_deg') or 0.0)
                src_bpx = src_it.get('bounds_px')
                if isinstance(src_bpx, (list, tuple)) and len(src_bpx) == 4:
                    x1, y1, x2, y2 = (float(v) for v in src_bpx)
                    iw_px = x2 - x1
                    ih_px = y2 - y1
                    if iw_px > 0 and ih_px > 0:
                        box = make_box_from_bounds_px(
                            x1, y1, iw_px, ih_px, src_rot, img_w, img_h)
                    else:
                        box = make_item_box(li, n_lines, canvas_left, canvas_top, canvas_w,
                                            canvas_h, font_px, direction, img_w, img_h, source_rot_deg=src_rot)
                else:
                    box = make_item_box(li, n_lines, canvas_left, canvas_top, canvas_w, canvas_h,
                                        font_px, direction, img_w, img_h, source_rot_deg=source_rot_deg)
            else:
                box = make_item_box(li, n_lines, canvas_left, canvas_top, canvas_w, canvas_h,
                                    font_px, direction, img_w, img_h, source_rot_deg=source_rot_deg)
            template_items.append({'side': 'Ai', 'text': '', 'valid_text': False, 'box': box, 'spans': [], 'baseline_p1': {'x': box['left'], 'y': box['top'] +
                                  box['height'] / 2.0}, 'baseline_p2': {'x': box['left'] + box['width'], 'y': box['top'] + box['height'] / 2.0}, 'height_raw': box['height']})
        if group_text:
            lines = distribute_to_template(
                group_text, template_items, parser, lang_norm, img_w, img_h)
            lines = pad_lines(lines, n_lines)
        else:
            lines = [[] for _ in range(n_lines)]
        fs_fixed = max(min_size_px, int(round(font_px)))
        for li, item in enumerate(template_items):
            line_tokens = lines[li] if li < len(lines) else []
            line_text = join_line_tokens(line_tokens)
            item['text'] = line_text
            item['valid_text'] = bool(line_text)
            item['para_index'] = gi
            item['item_index'] = li
            item['font_size_px'] = fs_fixed
            box = item['box']
            item['bounds_px'] = [box['left'] * img_w, box['top'] * img_h,
                                 (box['left'] + box['width']) * img_w, (box['top'] + box['height']) * img_h]
            item['height_raw'] = fs_fixed / float(max(1, img_h))
            mid_y = box['top'] + box['height'] / 2.0
            item['baseline_p1'] = {'x': box['left'], 'y': mid_y}
            item['baseline_p2'] = {'x': box['left'] + box['width'], 'y': mid_y}
            item['spans'] = build_item_spans(
                item, gi, li, parser, lang_norm, img_w, img_h) if line_text else []
        para: dict[str, Any] = {'side': 'Ai', 'para_index': gi, 'text': group_text, 'valid_text': bool(group_text), 'bubble_bounds_px': bg.get('bubble_bounds_px'), 'bounds_px': [canvas_left, canvas_top, canvas_left + canvas_w, canvas_top + canvas_h], 'canvas_rotation_deg': round(
            avg_rot, 2) if use_per_item_rotation and rot_spread <= 20.0 else 0.0, 'source_para_indices': bg.get('para_indices') or [], 'is_single_set': is_single_set, 'is_decorative_label': is_decorative_label, 'source_direction': str(bg.get('direction') or 'h'), 'direction': direction, 'rotated': bool(direction_change), 'items': template_items}
        para['preserved_vertical_run'] = preserve_vertical_run
        para['para_font_size_px'] = fs_fixed
        out_paragraphs.append(para)
    ai_tree: dict[str, Any] = {'side': 'Ai', 'paragraphs': out_paragraphs, 'originalContentLanguage': original_tree.get('originalContentLanguage'), 'targetLang': lang_norm, 'orientation': {'image_orientation': image_orientation, 'target_orientation': target_orientation, 'image_rotates': image_rotates, 'n_boxes': len(
        bubble_groups), 'n_single_set': sum((1 for _bg in bubble_groups if is_single_set_group(_bg))), 'n_multi_set': sum((1 for _bg in bubble_groups if not is_single_set_group(_bg)))}}
    return ai_tree
