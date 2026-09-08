from __future__ import annotations

from typing import Any

from backend.utils.text import ZWSP

def join_line_tokens(tokens: list[tuple[str, str, float]]) -> str:
    return "".join(
        text for _kind, text, _weight in (tokens or [])
        if text and text != ZWSP
    ).strip()

def tokenise_for_spans(text: str, parser: Any, direction: str) -> list[str]:
    if not text:
        return []
    if direction == 'v':
        return [char for char in text if not char.isspace()]
    if parser is not None:
        try:
            chunks = parser.parse(text)
            if chunks:
                return [chunk for chunk in chunks if chunk]
        except Exception:
            pass
    words = [word for word in text.split() if word]
    return words or [text]

def build_item_spans(item: dict, para_index: int, item_index: int, parser: Any, lang_norm: str, img_w: int, img_h: int) -> list[dict]:
    text = str(item.get('text') or '')
    if not text:
        return []
    box = item.get('box') or {}
    rot = float(box.get('rotation_deg') or 0.0)
    direction = 'v' if abs(rot) > 60 else 'h'
    tokens = tokenise_for_spans(text, parser, direction)
    if not tokens:
        return []
    item_left = float(box.get('left') or 0.0)
    item_top = float(box.get('top') or 0.0)
    item_w = float(box.get('width') or 0.0)
    item_h = float(box.get('height') or 0.0)
    height_raw = item_w if direction == 'v' else item_h
    n = len(tokens)
    spans: list[dict] = []
    byte_offset = 0
    for si, token_text in enumerate(tokens):
        t0 = si / n
        t1 = (si + 1) / n
        if direction == 'v':
            sp_left = item_left
            sp_top = item_top + t0 * item_h
            sp_w = item_w
            sp_h = (t1 - t0) * item_h
            sp_cx = sp_left + sp_w / 2.0
            bl_p1: dict = {'x': sp_cx, 'y': sp_top}
            bl_p2: dict = {'x': sp_cx, 'y': sp_top + sp_h}
        else:
            sp_left = item_left + t0 * item_w
            sp_top = item_top
            sp_w = (t1 - t0) * item_w
            sp_h = item_h
            sp_cy = sp_top + sp_h / 2.0
            bl_p1 = {'x': sp_left, 'y': sp_cy}
            bl_p2 = {'x': sp_left + sp_w, 'y': sp_cy}
        sp_box: dict = {'left': sp_left, 'top': sp_top, 'width': sp_w, 'height': sp_h, 'left_pct': sp_left * 100.0, 'top_pct': sp_top * 100.0, 'width_pct': sp_w *
                        100.0, 'height_pct': sp_h * 100.0, 'rotation_deg': rot, 'rotation_deg_css': rot, 'center': {'x': sp_left + sp_w / 2.0, 'y': sp_top + sp_h / 2.0}}
        token_bytes = len(token_text.encode('utf-8'))
        end_offset = byte_offset + token_bytes
        spans.append({'side': 'Ai', 'para_index': para_index, 'item_index': item_index, 'span_index': si, 'text': token_text, 'valid_text': True, 'start_raw': byte_offset,
                     'end_raw': end_offset, 't0_raw': t0, 't1_raw': t1, 'height_raw': height_raw, 'baseline_p1': bl_p1, 'baseline_p2': bl_p2, 'box': sp_box})
        byte_offset = end_offset
    return spans
