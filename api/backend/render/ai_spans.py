"""Rebuild AI-layer spans after a font-size change.

⛔ STATUS: DORMANT — ยังไม่ได้ใช้งาน (ORPHAN: ไม่มีไฟล์ไหน import โมดูลนี้เลย,
ตรวจ 20 ก.ค. 2026). โค้ดถูกเขียนไว้แต่ไม่เคยถูกต่อเข้า render pipeline —
อย่าเข้าใจว่า span rebuild นี้ทำงานอยู่

After :func:`backend.render.tp_html.compute_shared_para_sizes` forces a
uniform font size onto the AI tree, each item's spans no longer match their
text at the new size.  These helpers re-tokenise every AI item and re-emit
its spans, then make sure all spans within an item share one size.
"""

from __future__ import annotations

from PIL import Image, ImageDraw

from backend.lens.languages import normalize as normalize_lang
from backend.lens.tree import iter_paragraphs
from backend.render.fonts import budoux_parser, pick_font
from backend.render.layout import apply_line_to_item, tokens_with_spaces
from backend.render.text_utils import contains_thai, sanitize_draw_text
from backend.render.tp_html import _item_line_text

_SCRATCH = ImageDraw.Draw(Image.new("RGBA", (10, 10), (0, 0, 0, 0)))


def uniformize_item_span_font_size(
    item: dict, img_w: int, img_h: int, thai_font: str, latin_font: str
) -> None:
    """Shrink an item's font size if any span would overflow its own box.

    All spans in the item end up sharing the smallest size that fits.
    """
    spans = item.get("spans") or []
    if not spans or img_w <= 0 or img_h <= 0:
        return

    base_size = item.get("font_size_px")
    try:
        base_size = int(base_size) if base_size is not None else None
    except (TypeError, ValueError):
        base_size = None
    if not base_size:
        for sp in spans:
            fs = sp.get("font_size_px") if isinstance(sp, dict) else None
            if isinstance(fs, int) and fs > 0:
                base_size = fs
                break
    if not base_size or base_size <= 0:
        return

    font_cache: dict[tuple[int, int], object] = {}

    def font_for(text: str, size: int):
        key = (int(size), 1 if contains_thai(text) else 0)
        cached = font_cache.get(key)
        if cached is None:
            cached = pick_font(text, thai_font, latin_font, int(size))
            font_cache[key] = cached
        return cached

    min_size = int(base_size)
    for sp in spans:
        if not isinstance(sp, dict):
            continue
        txt = sanitize_draw_text(sp.get("text") or "")
        if not txt.strip():
            continue

        b = sp.get("box") or {}
        avail_w = float(b.get("width") or 0.0) * img_w
        avail_h = float(b.get("height") or 0.0) * img_h
        if avail_w <= 0.0 or avail_h <= 0.0:
            continue

        font = font_for(txt, base_size)
        try:
            bb = _SCRATCH.textbbox((0, 0), txt, font=font, anchor="ls")
            tw, th = float(bb[2] - bb[0]), float(bb[3] - bb[1])
        except Exception:
            tw, th = (float(v) for v in _SCRATCH.textsize(txt, font=font))  # type: ignore[attr-defined]
        if tw <= 0.0 or th <= 0.0:
            continue

        scale = min((avail_w * 0.995) / tw, (avail_h * 0.995) / th)
        if scale < 1.0:
            req = max(10, int(base_size * scale))
            min_size = min(min_size, req)

    if min_size != base_size:
        item["font_size_px"] = int(min_size)
        for sp in spans:
            if isinstance(sp, dict):
                sp["font_size_px"] = int(min_size)


def rebuild_ai_spans_after_font_resize(
    ai_tree: dict,
    img_w: int,
    img_h: int,
    thai_font: str,
    latin_font: str,
    lang: str,
) -> None:
    """Re-tokenise and re-lay every AI item so spans match the forced size."""
    if not ai_tree or img_w <= 0 or img_h <= 0:
        return
    lang_norm = normalize_lang(lang)
    parser = budoux_parser(lang_norm)

    for pi, p in iter_paragraphs(ai_tree):
        for ii, item in enumerate(p.get("items") or []):
            text = _item_line_text(item)
            if not str(text).strip():
                item["spans"] = []
                continue

            tokens = tokens_with_spaces(str(text), parser, lang_norm)
            line_tokens = [(k, s, 0.0) for k, s in tokens]

            forced = item.get("font_size_px") or p.get("para_font_size_px")
            if isinstance(forced, float):
                forced = int(forced)
            elif isinstance(forced, str) and forced.strip().isdigit():
                forced = int(forced.strip())

            apply_line_to_item(
                item,
                line_tokens,
                int(p.get("para_index", pi)),
                int(item.get("item_index", ii)),
                int(item.get("start_raw", 0)),
                img_w,
                img_h,
                thai_font,
                latin_font,
                forced,
                apply_baseline_shift=False,
                kerning_adjust=True,
            )
            uniformize_item_span_font_size(item, img_w, img_h, thai_font, latin_font)
