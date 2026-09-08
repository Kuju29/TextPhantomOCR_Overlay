"""AI-layer HTML rendering."""

from __future__ import annotations

import re

from backend.lens.languages import normalize
from backend.render.components.typography import (
    MIN_FONT_PX as _MIN_FONT_PX,
    escape_text as _escape_text,
    finite_number as _num,
    fit_item_font_size_vertical,
    fit_paragraph_font_size_horizontal,
)
from backend.render.fonts import budoux_parser
from backend.render.html.geometry import _para_bounds_px, _paragraph_source_is_vertical
from backend.render.region import is_rtl

def _insert_thai_word_breaks(text: str, target_lang: str) -> str:
    """Insert ZWSP (U+200B) between BudouX word boundaries in Thai text.

    Thai orthography has no inter-word spaces.  Without explicit break
    opportunities ``overflow-wrap`` falls back to splitting at any code
    point, which can separate a leading vowel from its base consonant
    (ไ | ม่) or split mid-syllable (ปั | ง, จ้อ | ง).

    With ZWSP inserted the browser has correct break points and
    ``overflow-wrap: break-word`` only ever breaks at those positions,
    keeping each Thai grapheme cluster intact.

    Single-word tokens (BudouX returns one chunk) get no ZWSP, so a
    short word like "จ้อง" or "ไม่" never acquires a spurious break
    opportunity.

    Returns ``text`` unchanged when the target language is not Thai or
    when the BudouX parser is unavailable.
    """
    if normalize(target_lang) != "th":
        return text
    parser = budoux_parser("th")
    if parser is None:
        return text

    # Process each non-whitespace run through BudouX; preserve spaces.
    out: list[str] = []
    for part in re.split(r"(\s+)", text):
        if not part or part.isspace():
            out.append(part)
            continue
        try:
            chunks = [c for c in parser.parse(part) if c]
            out.append("​".join(chunks) if len(chunks) > 1 else part)
        except Exception:
            out.append(part)
    return "".join(out)

def _render_ai_paragraph(
    para: dict,
    text: str,
    target_lang: str,
    img_w: int,
    img_h: int,
    override_fs: int | None = None,
) -> str:
    """Render one AI paragraph as a single ``<div>`` using pre-computed geometry.

    This is the correct path for trees built by
    :mod:`backend.render.build_ai_tree`.  It reads ``para_font_size_px``
    directly — already computed by the canonical typography fitter
    — rather than deriving the font size from synthetic item ``box.height``
    values (which store *slot* heights, not glyph heights, and would give
    wildly wrong sizes via :func:`compute_region_geometry`).

    Position comes from ``bubble_bounds_px`` (the OpenCV-detected speech-bubble
    outline) via :func:`_para_bounds_px`.  Text direction is read from the
    item rotation angles that :mod:`backend.render.build_ai_tree` stamped:
    0° = horizontal target language, 90° = vertical CJK target.
    """
    # Use bounds_px set by build_ai_tree — it's the group's unique canvas
    # (item AABB when bubble_bounds_px is shared, full bounds otherwise).
    # Reading it directly avoids _para_bounds_px which would try
    # bubble_bounds_px first and return the shared overlapping blob.
    bp = para.get("bounds_px")
    if isinstance(bp, (list, tuple)) and len(bp) == 4:
        x1, y1, x2, y2 = (_num(v) for v in bp)
        if x2 <= x1 or y2 <= y1:
            return ""
        left_px, top_px = x1, y1
        width_px, height_px = x2 - x1, y2 - y1
    else:
        # Fallback for AI trees not built by build_ai_tree.
        bounds = _para_bounds_px(para, img_w, img_h)
        if bounds is None:
            return ""
        left_px, top_px, width_px, height_px = bounds
    if width_px <= 0 or height_px <= 0:
        return ""

    # Direction: read from item rotations set by build_ai_tree (0° = h, 90° = v).
    is_vert = _paragraph_source_is_vertical(para)

    # Font size: use the pre-computed median from build_ai_tree.
    # Falls back to the formula-based fit only for trees not built that way.
    if override_fs is not None and override_fs >= _MIN_FONT_PX:
        # Spec \u00a717: every paragraph in the SAME real speech bubble renders at
        # one shared size (computed by the caller).  Overrides the per-paragraph
        # fit so siblings in a bubble don't read at different sizes.
        fs = int(override_fs)
    else:
        fs = int(para.get("para_font_size_px") or 0)
        if fs < _MIN_FONT_PX:
            if is_vert:
                fs = fit_item_font_size_vertical(width_px, height_px, text)
            else:
                fs = fit_paragraph_font_size_horizontal(width_px, height_px, text)
    fs = max(_MIN_FONT_PX, fs)

    lh = int(round(fs * 1.15)) if not is_vert else fs

    left_pct = left_px / max(1, img_w) * 100.0
    top_pct = top_px / max(1, img_h) * 100.0
    width_pct = width_px / max(1, img_w) * 100.0
    height_pct = height_px / max(1, img_h) * 100.0

    style = (
        f"left:{left_pct:.4f}%;"
        f"top:{top_pct:.4f}%;"
        f"width:{width_pct:.4f}%;"
        f"height:{height_pct:.4f}%;"
        f"font-size:calc(var(--tp-font-scale,1) * {fs}px);"
        f"line-height:calc(var(--tp-font-scale,1) * {lh}px);"
    )
    cls = "tp-line vert" if is_vert else "tp-line tp-bubble"
    if not is_vert and is_rtl(target_lang):
        cls += " rtl"
    display_text = _insert_thai_word_breaks(text, target_lang) if not is_vert else text
    pi = int(para.get("para_index", 0))
    return (
        f'<div class="{cls}" data-pi="{pi}" '
        f'data-fs="{fs}" style="{style}">{_escape_text(display_text)}</div>'
    )
