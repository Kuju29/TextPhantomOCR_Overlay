"""Lens-layer HTML rendering for source and translated trees."""

from __future__ import annotations

from backend.render.components.typography import (
    MIN_FONT_PX as _MIN_FONT_PX,
    escape_attr as _escape_attr,
    escape_text as _escape_text,
    finite_number as _num,
    fit_item_font_size_vertical,
    is_cjk_dominant as _is_cjk_dominant,
)
from backend.render.paragraphs import paragraph_rotation
from backend.render.html.geometry import (
    _font_size_for_item, _item_rotated_aabb_px, _item_reads_vertically,
)
from backend.render.text_utils import contains_rtl

def _render_group_gtext_block(
    bg: dict,
    paragraphs: list[dict],
    img_w: int,
    img_h: int,
    override_fs: int | None,
    source_lang: str = "",
) -> str:
    """ONE ``.tp-gtext`` for a whole bubble group (all its columns together).

    Geometry is the union of the group's paragraph boxes — preferring the
    canonical Lens graph group rect when there is one, since that is the shape
    the reader sees. Text comes straight from ``bg["text"]``, whose membership
    already assembled in reading order with the right separator (no spaces for
    CJK), and with furigana columns dropped so the kana readings do not
    interleave into the sentence.

    Always rendered horizontally: the translation target (Thai, English…) reads
    horizontally regardless of how the source was typeset.
    """
    text = str(bg.get("text") or "").strip()
    if not text:
        return ""

    members = {int(pi) for pi in (bg.get("para_indices") or [])}
    paras = [p for p in paragraphs if int(p.get("para_index", -1)) in members]
    if not paras:
        return ""

    left = top = float("inf")
    right = bottom = float("-inf")
    bb = bg.get("bubble_bounds_px")
    if isinstance(bb, (list, tuple)) and len(bb) == 4:
        left, top, right, bottom = (float(v) for v in bb)
    else:
        for p in paras:
            for it in p.get("items") or []:
                if not str(it.get("text") or "").strip():
                    continue
                aabb = _item_rotated_aabb_px(it, img_w, img_h)
                if aabb is None:
                    continue
                l, t, w, h = aabb
                left, top = min(left, l), min(top, t)
                right, bottom = max(right, l + w), max(bottom, t + h)
    if not (right > left and bottom > top):
        return ""

    if override_fs is not None and override_fs >= _MIN_FONT_PX:
        fs = int(override_fs)
    else:
        fs = max(_MIN_FONT_PX, int(float(bg.get("font_size_px") or 0)))
    lh = int(round(fs * 1.12))

    style = (
        f"left:{left / max(1, img_w) * 100.0:.4f}%;"
        f"top:{top / max(1, img_h) * 100.0:.4f}%;"
        f"width:{(right - left) / max(1, img_w) * 100.0:.4f}%;"
        f"height:{(bottom - top) / max(1, img_h) * 100.0:.4f}%;"
        "white-space:normal;text-align:center;"
        f"font-size:calc(var(--tp-font-scale,1) * {fs}px);"
        f"line-height:calc(var(--tp-font-scale,1) * {lh}px);"
    )
    cls = "tp-line tp-gtext rtl" if contains_rtl(text) else "tp-line tp-gtext"
    gi = int(bg.get("bubble_index", 0))
    language = f' lang="{_escape_attr(source_lang)}"' if source_lang else ""
    return (
        f'<div class="{cls}" data-bg="{gi}" data-fs="{fs}"{language} translate="yes" '
        f'style="{style}">{_escape_text(text)}</div>'
    )

def _render_original_gtext_block(
    para: dict,
    img_w: int,
    img_h: int,
    override_fs: int | None,
    is_vertical: bool,
    source_lang: str = "",
) -> str:
    """The hidden translate-target block: ONE ``.tp-gtext`` per bubble.

    Invisible (opacity:0) until the browser translates the page — then CSS
    (html.translated-*) shows it while hiding the ``.tp-src`` line layer.
    Geometry: the union of the paragraph's item AABBs, so the translated
    sentence appears exactly where the bubble is.  Text: item lines joined
    into a SINGLE text node (space-separated; no separator when the source
    is CJK-dominant), so Chrome translates the whole bubble as ONE segment
    with full context.  Rendered horizontally even for vertical sources —
    the translation target (e.g. Thai) reads horizontally.
    A near-uniform source tilt is preserved via the paragraph rotation.
    """
    items = [
        (it, str(it.get("text") or "").strip())
        for it in (para.get("items") or [])
    ]
    items = [(it, tx) for it, tx in items if tx]
    if not items:
        return ""

    # Union of the items' rotated AABBs (px) -> paragraph box.  Items carry
    # either normalised (0..1) box fields or *_pct fields depending on the
    # decode path — mirror _render_item_horizontal's fallback for both.
    left = top = float("inf")
    right = bottom = float("-inf")
    for it, _tx in items:
        aabb = _item_rotated_aabb_px(it, img_w, img_h)
        if aabb is None:
            box = it.get("box") or {}
            l_pct = _num(box.get("left_pct"), _num(box.get("left")) * 100.0)
            t_pct = _num(box.get("top_pct"), _num(box.get("top")) * 100.0)
            w_pct = _num(box.get("width_pct"), _num(box.get("width")) * 100.0)
            h_pct = _num(box.get("height_pct"), _num(box.get("height")) * 100.0)
            if w_pct <= 0 or h_pct <= 0:
                continue
            aabb = (
                l_pct / 100.0 * img_w, t_pct / 100.0 * img_h,
                w_pct / 100.0 * img_w, h_pct / 100.0 * img_h,
            )
        l, t, w, h = aabb
        left, top = min(left, l), min(top, t)
        right, bottom = max(right, l + w), max(bottom, t + h)
    if not (right > left and bottom > top):
        return ""

    # Join into ONE text node. CJK sources have no word spaces — joining
    # their lines with spaces would feed Google fake word boundaries and
    # (per the user's v1.0.1 experience) skew the translation.
    line_texts = [tx for _it, tx in items]
    sep = "" if _is_cjk_dominant("".join(line_texts)) else " "
    text = sep.join(line_texts)

    if override_fs is not None and override_fs >= _MIN_FONT_PX:
        fs = int(override_fs)
    else:
        sizes = sorted(_font_size_for_item(it, img_w, img_h) for it, _tx in items)
        fs = max(_MIN_FONT_PX, sizes[len(sizes) // 2])
    lh = int(round(fs * 1.12))

    # Horizontal always (the translation target reads horizontally); keep a
    # genuine source tilt so labels drawn at an angle stay on the art.
    rot = 0.0 if is_vertical else paragraph_rotation(para)
    style = (
        f"left:{left / max(1, img_w) * 100.0:.4f}%;"
        f"top:{top / max(1, img_h) * 100.0:.4f}%;"
        f"width:{(right - left) / max(1, img_w) * 100.0:.4f}%;"
        f"height:{(bottom - top) / max(1, img_h) * 100.0:.4f}%;"
        + (f"transform:rotate({rot:.4f}deg);" if abs(rot) > 0.5 else "")
        + "white-space:normal;text-align:center;"
        f"font-size:calc(var(--tp-font-scale,1) * {fs}px);"
        f"line-height:calc(var(--tp-font-scale,1) * {lh}px);"
    )
    cls = "tp-line tp-gtext rtl" if contains_rtl(text) else "tp-line tp-gtext"
    pi = int(para.get("para_index", 0))
    language = f' lang="{_escape_attr(source_lang)}"' if source_lang else ""
    return (
        f'<div class="{cls}" data-pi="{pi}" data-fs="{fs}"{language} translate="yes" '
        f'style="{style}">{_escape_text(text)}</div>'
    )

def _render_item_upright_vertical(
    item: dict,
    text: str,
    para: dict,
    img_w: int,
    img_h: int,
    override_fs: int | None,
) -> str:
    """Render a vertical-source CJK item with *upright* characters.

    Used by the per-item dispatcher when the source line was written
    vertically (Japanese / Chinese / Korean) — those items have a Lens
    rotation near ±90°.  CSS-rotating a horizontal text run by 89° keeps
    every glyph tilted sideways (unreadable), so we instead lay the
    item's rotated AABB and switch the inner text to
    ``writing-mode: vertical-rl`` + ``text-orientation: upright``.  That
    stacks characters top-to-bottom in their natural form, matching how
    the source page actually reads — exactly what the user expects from
    the Original layer for vertical Japanese text.
    """
    aabb = _item_rotated_aabb_px(item, img_w, img_h)
    if aabb is None:
        return ""
    left_px, top_px, width_px, height_px = aabb
    if width_px <= 0 or height_px <= 0:
        return ""

    if override_fs is not None and override_fs >= _MIN_FONT_PX:
        fs = int(override_fs)
    else:
        fs = fit_item_font_size_vertical(width_px, height_px, text)

    left_pct = left_px / max(1, img_w) * 100.0
    top_pct = top_px / max(1, img_h) * 100.0
    width_pct = width_px / max(1, img_w) * 100.0
    height_pct = height_px / max(1, img_h) * 100.0
    pi = int(para.get("para_index", 0))
    ii = int(item.get("item_index", 0))

    style = (
        f"left:{left_pct:.4f}%;"
        f"top:{top_pct:.4f}%;"
        f"width:{width_pct:.4f}%;"
        f"height:{height_pct:.4f}%;"
        # No transform: rotate — the AABB already covers the visual
        # footprint, and writing-mode does the orientation.
        f"font-size:calc(var(--tp-font-scale,1) * {fs}px);"
        f"line-height:calc(var(--tp-font-scale,1) * {fs}px);"
    )
    return (
        f'<div class="tp-line vert" data-pi="{pi}" data-ii="{ii}" '
        f'data-fs="{fs}" '
        f'style="{style}">{_escape_text(text)}</div>'
    )

def _render_item_horizontal(
    item: dict,
    text: str,
    para: dict,
    img_w: int,
    img_h: int,
    override_fs: int | None = None,
) -> str:
    """Per-item dispatcher used by every layer.

    - Vertical-source items (rotation near ±90°) that carry CJK text get
      the upright-vertical path so characters stay readable — Japanese
      vertical bubbles render exactly like the source page, instead of a
      horizontal text run rotated 89° (which leaves every glyph lying on
      its side).
    - Everything else uses the original CSS-rotate path: a horizontal
      text run rotated to match the item's baseline.  Translated layers
      where Lens MT puts non-CJK text in a vertical-source box stay on
      this path, so the Translated overlay remains Lens-direct.

    ``override_fs`` is the paragraph-shared font size from
    :func:`_shared_horizontal_font_size`; when given, it replaces the
    item's own per-fit size so every line in the bubble matches.
    """
    box = item.get("box") or {}
    rot = _num(box.get("rotation_deg_css"), _num(box.get("rotation_deg")))

    # Vertical-source + CJK text → upright vertical-rl rendering.
    # Only NEAR-vertical text (|rot| ≈ 90°) is a real vertical column; a
    # steeply-tilted horizontal label (e.g. 68° status text on a slanted game
    # screen) must keep its tilt via CSS-rotate, not be snapped upright — so
    # the cut-off is 78°, not 60°.
    if _item_reads_vertically(item, img_w, img_h) and _is_cjk_dominant(text) and not item.get("presentation_sideways"):
        return _render_item_upright_vertical(
            item, text, para, img_w, img_h, override_fs
        )

    left_pct = _num(box.get("left_pct"), _num(box.get("left")) * 100.0)
    top_pct = _num(box.get("top_pct"), _num(box.get("top")) * 100.0)
    width_pct = _num(box.get("width_pct"), _num(box.get("width")) * 100.0)
    height_pct = _num(box.get("height_pct"), _num(box.get("height")) * 100.0)
    if width_pct <= 0 or height_pct <= 0:
        return ""
    fs = (
        int(override_fs)
        if (override_fs is not None and override_fs >= _MIN_FONT_PX)
        else _font_size_for_item(item, img_w, img_h)
    )
    lh = int(round(fs * 1.05))

    pi = int(para.get("para_index", 0))
    ii = int(item.get("item_index", 0))
    # The font-size and line-height are wrapped in calc(var(--tp-font-scale,
    # 1) * Npx) so the extension's +/- buttons can scale every line by
    # flipping a single CSS variable on .tp-ol-scope.  When the variable is
    # absent (or = 1) the size is exactly what the API picked.
    style = (
        f"left:{left_pct:.4f}%;"
        f"top:{top_pct:.4f}%;"
        f"width:{width_pct:.4f}%;"
        f"height:{height_pct:.4f}%;"
        f"transform:rotate({rot:.4f}deg);"
        f"font-size:calc(var(--tp-font-scale,1) * {fs}px);"
        f"line-height:calc(var(--tp-font-scale,1) * {lh}px);"
    )
    cls = "tp-line rtl" if contains_rtl(text) else "tp-line"
    return (
        f'<div class="{cls}" data-pi="{pi}" data-ii="{ii}" '
        f'data-fs="{fs}" '
        f'style="{style}">{_escape_text(text)}</div>'
    )

def _para_full_text(para: dict) -> str:
    """Reassemble a paragraph's combined text from its items.

    Prefers the precomputed ``para.text`` (set by ``decode_tree`` / patch);
    falls back to joining item texts when that field is empty.  Whitespace
    is trimmed at the edges but kept between items so words from adjacent
    horizontal lines don't merge.
    """
    text = str(para.get("text") or "").strip()
    if text:
        return text
    items = para.get("items") or []
    return "".join(str(it.get("text") or "") for it in items).strip()
