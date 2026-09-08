"""Top-level HTML overlay composition."""

from __future__ import annotations

from typing import Any

from backend.lens.tree import iter_paragraphs
from backend.render.components.typography import MIN_FONT_PX as _MIN_FONT_PX, is_cjk_dominant
from backend.render.paragraphs import bubble_key, group_is_ruby_only
from backend.render.html.ai import _render_ai_paragraph
from backend.render.html.geometry import (
    _paragraph_source_is_vertical, _item_reads_vertically,
    _shared_horizontal_font_size, _shared_vertical_font_size,
)
from backend.render.html.lens import (
    _para_full_text, _render_group_gtext_block, _render_item_horizontal,
    _render_original_gtext_block,
)

def render_tree_overlay(
    tree: dict | None,
    img_w: int,
    img_h: int,
    target_lang: str = "",
) -> str:
    """Render every paragraph/item in ``tree`` as ``<div class="tp-line">``s.

    Two layout modes:

    - **Original / Translated** (``tree.side`` in {"original", "translated"}):
      every item is rendered horizontally, rotated to match its source
      baseline.  Lens-direct — the layout Lens chose is preserved as-is.

    - **AI** (``tree.side == "Ai"``): paragraphs that share a bubble are
      merged, and each bubble renders as ONE deterministic block via
      :func:`_render_ai_region` — reading direction from the target
      language, box size from the glyph count, rotation from the
      residual tilt only.  This keeps the established overlay geometry:
      direction is a language property, geometry is closed-form.

    ``target_lang`` is required for the AI layer's direction lookup; for
    Original/Translated it is ignored.

    Returns ``""`` when ``tree`` has no renderable text.
    """
    if not isinstance(tree, dict):
        return ""

    is_ai_layer = str(tree.get("side") or "").lower() == "ai"
    source_lang = str(tree.get("source_lang") or tree.get("originalContentLanguage") or "").strip()

    parts: list[str] = ['<div class="tp-draw-root"><div class="tp-draw-scope">']
    has_any = False

    def _wrap_on_dark(chunk: str, para: dict) -> str:
        """Wrap a rendered chunk so dark-background paragraphs flip colour.

        The wrapper is position:static, so the absolutely-positioned
        ``.tp-line`` children keep ``.tp-draw-scope`` as their containing
        block — only the inherited CSS variables change.
        """
        if chunk and para.get("text_light"):
            return '<div class="tp-on-dark">' + chunk + "</div>"
        return chunk

    if is_ai_layer:
        # AI layer: two rendering paths based on canvas geometry.
        #
        # 1. **Flat paragraphs** (canvas_rotation_deg ≈ 0°) — speech bubbles
        #    whose text is roughly horizontal.  A single block div with
        #    word-wrap keeps the translation readable even when it is longer
        #    than the original.  Uses _render_ai_paragraph.
        #
        # 2. **Tilted paragraphs** (|canvas_rotation_deg| > 1°) — diagonal
        #    manga labels, sound effects, status-screen text drawn at an angle.
        #    Rendered per-item via _render_item_horizontal, which applies
        #    transform:rotate() from item.box.rotation_deg.  This also
        #    naturally supports *curved* text: each item can carry a slightly
        #    different rotation angle, letting the line of items follow a curve
        #    exactly as Lens detected it in the original art.
        ai_paras = [p for _, p in iter_paragraphs(tree) if str(p.get("text") or "").strip()]

        # Spec \u00a717 (font consistency inside one bubble) for the AI layer.
        # Flat paragraphs that genuinely share one detected speech bubble must
        # render at ONE shared size.  We bucket flat paragraphs by
        # ``bubble_bounds_px`` and average their pre-computed fonts.  A bucket
        # of size 1 is left untouched; blob-collisions where build_ai_tree gave
        # paragraphs distinct ``bounds_px`` outside the shared blob are NOT
        # forced equal (their bounds don't fall inside the common bubble), so a
        # caption/watermark wrongly sharing a blob keeps its own size.
        shared_ai_fs: dict[int, int] = {}
        flat_bucket: dict[tuple[float, ...], list[dict]] = {}
        for p in ai_paras:
            if abs(float(p.get("canvas_rotation_deg") or 0.0)) > 1.0:
                continue  # tilted/per-item path is not bubble-bucketed
            bb = p.get("bubble_bounds_px")
            if not (isinstance(bb, (list, tuple)) and len(bb) == 4):
                continue
            flat_bucket.setdefault(tuple(round(float(x), 1) for x in bb), []).append(p)
        for bb_key, members in flat_bucket.items():
            if len(members) < 2:
                continue
            bx1, by1, bx2, by2 = bb_key
            # keep only members whose own bounds_px fall (mostly) inside the
            # shared bubble — filters out blob-collision strangers.
            inside = []
            for p in members:
                pb = p.get("bounds_px")
                if not (isinstance(pb, (list, tuple)) and len(pb) == 4):
                    continue
                px1, py1, px2, py2 = (float(v) for v in pb)
                ix = max(0.0, min(px2, bx2) - max(px1, bx1))
                iy = max(0.0, min(py2, by2) - max(py1, by1))
                inter = ix * iy
                area = max(1.0, (px2 - px1) * (py2 - py1))
                if inter / area >= 0.6:
                    inside.append(p)
            if len(inside) < 2:
                continue
            sizes = [int(p.get("para_font_size_px") or 0) for p in inside]
            sizes = [s for s in sizes if s >= _MIN_FONT_PX]
            if not sizes:
                continue
            shared = max(_MIN_FONT_PX, int(round(sum(sizes) / len(sizes))))
            for p in inside:
                shared_ai_fs[id(p)] = shared

        for para in ai_paras:
            para_text = str(para.get("text") or "").strip()
            para_rot = float(para.get("canvas_rotation_deg") or 0.0)
            if abs(para_rot) > 1.0:
                # Per-item path: each AI item already has the correct
                # rotation_deg set by build_ai_tree._make_item_box, so
                # _render_item_horizontal applies transform:rotate() for free.
                for item in para.get("items") or []:
                    item_text = str(item.get("text") or "").strip()
                    if not item_text:
                        continue
                    chunk = _render_item_horizontal(
                        item, item_text, para, img_w, img_h
                    )
                    if chunk:
                        parts.append(_wrap_on_dark(chunk, para))
                        has_any = True
            else:
                # Single-block path: word-wrap inside the bubble canvas.
                chunk = _render_ai_paragraph(
                    para, para_text, target_lang, img_w, img_h,
                    override_fs=shared_ai_fs.get(id(para)),
                )
                if chunk:
                    parts.append(_wrap_on_dark(chunk, para))
                    has_any = True

        parts.append("</div></div>")
        return "".join(parts) if has_any else ""

    # Non-AI layers (Original / Translated) — Lens-direct rendering.
    # Lens already chose the correct layout (rotation, line boxes) for each
    # item; we render every item exactly as received, one <div> per item.
    #
    # Vertical and horizontal source paragraphs go down SEPARATE paths:
    #
    #   • horizontal paragraphs (rotation ≈ 0°) use the horizontal per-item
    #     fit (``_shared_horizontal_font_size``) — height is the ceiling,
    #     width is the soft constraint;
    #   • vertical paragraphs (rotation ≈ ±90°) use the vertical fit
    #     (``_shared_vertical_font_size``) — every glyph is square so font
    #     size is derived from the column's actual area.
    #
    # Bubble-shared font then bucketises by (bubble_key, orientation), so a
    # vertical column inside a bubble shares its size with the OTHER
    # vertical columns in the same bubble (not with a horizontal caption
    # that happens to fall inside the same blob).
    paragraphs_in_order = [p for _, p in iter_paragraphs(tree) if _para_full_text(p)]
    para_vertical: dict[int, bool] = {
        id(p): _paragraph_source_is_vertical(p) for p in paragraphs_in_order
    }

    para_fonts: dict[int, int] = {}
    bucket: dict[tuple[Any, str], list[int]] = {}
    for para in paragraphs_in_order:
        is_v = para_vertical[id(para)]
        fs = (
            _shared_vertical_font_size(para, img_w, img_h)
            if is_v else
            _shared_horizontal_font_size(para, img_w, img_h)
        )
        if fs is None:
            continue
        para_fonts[id(para)] = fs
        key = (bubble_key(para), "v" if is_v else "h")
        bucket.setdefault(key, []).append(fs)
    # Bubble-shared font (spec \u00a717): the representative size for a bubble is
    # the MEDIAN of its paragraphs' own fits, not the mean \u2014 so one tiny
    # ruby (furigana) paragraph cannot drag the size up or down.
    def _median(vals: list[int]) -> int:
        s = sorted(vals)
        return s[len(s) // 2]
    bubble_font: dict[tuple[Any, str], int] = {
        k: max(_MIN_FONT_PX, _median(v))
        for k, v in bucket.items() if v
    }

    def _font_for_para(para: dict) -> int | None:
        is_v = para_vertical[id(para)]
        bk = bubble_key(para)
        key = (bk, "v" if is_v else "h")
        own = para_fonts.get(id(para))
        if bk is not None and key in bubble_font and own is not None:
            shared = bubble_font[key]
            # Sibling dialogue lines snap to ONE shared size for consistency
            # (spec \u00a717).  But a paragraph whose own fit is an OUTLIER vs the
            # bubble median \u2014 either much smaller (ruby / furigana) or much
            # larger (the base kanji column when ruby dominate the median) \u2014
            # keeps its OWN size.  The band is relative (0.67\u20131.5\u00d7), so it is
            # size-driven and general, never tuned to one image.
            if 0.67 * shared <= own <= 1.5 * shared:
                return shared
            return own
        return own

    # Rendering is **Lens-direct**: every item keeps the rotation,
    # position and writing-mode Lens chose.  The only change versus the
    # raw Lens layout is the font size — shared across every item in the
    # same speech bubble (spec §17), and vertical paragraphs get a
    # vertical-specific fit so a column of CJK glyphs is sized by its
    # actual area rather than by horizontal width × height.
    #
    # ORIGINAL layer only — browser-translate DUAL LAYER.
    #
    # Lesson learned the hard way (see chat 2026-07-20): Chrome's built-in
    # Google Translate segments by LAYOUT, not by tag — absolutely-positioned
    # elements are each their own segment, so per-line divs AND per-line
    # spans inside one wrapper both translate word-by-word ("ISN'T THAT" →
    # "ไม่ใช่อย่างนั้น" per box).  Merging lines into one visible block (the
    # v1.0.1 shape) translates correctly but shifts the source layout.
    #
    # So the Original layer now emits BOTH, and pure CSS swaps them when
    # Chrome translates the page (html.translated-ltr/rtl — see overlay_css):
    #
    #   .tp-src    — the pixel-exact per-line divs, translate="no"/
    #                notranslate: Google never touches them, nothing shifts.
    #   .tp-gtext  — ONE hidden block per bubble with the full sentence as a
    #                single text node: Google translates it as one segment
    #                and re-inserts it as one readable group in the bubble.
    is_original_layer = str(tree.get("side") or "").lower() == "original"

    # BUBBLE-LEVEL translate targets.
    #
    # Chrome segments by layout, so ONE .tp-gtext per Lens paragraph means one
    # translation segment per paragraph. That is fine for horizontal text, where
    # a Lens paragraph IS the sentence — but vertical Japanese comes back as one
    # paragraph PER COLUMN, so a single bubble was handed to Google as several
    # unrelated fragments, in Lens's order rather than reading order. The result
    # is a bubble whose translated lines are shuffled and translated without
    # each other's context.
    #
    # ``tree["bubble_groups"]`` from the canonical Lens graph contract
    # already carries the columns of one utterance joined into ``text`` in
    # reading order — right-to-left for vertical Japanese. So when groups exist,
    # the translate target is built per GROUP and the per-line .tp-src layer is
    # left exactly as it was: nothing moves on screen, Google just receives whole
    # sentences.
    group_of_para: dict[int, int] = {}
    groups_list = tree.get("bubble_groups") or [] if is_original_layer else []
    for gi, bg in enumerate(groups_list):
        if not isinstance(bg, dict):
            continue
        for pi in bg.get("para_indices") or []:
            group_of_para[int(pi)] = gi
    # Emit each group's translate block once, at its first paragraph.
    gtext_done: set[int] = set()

    for para in paragraphs_in_order:
        shared_fs = _font_for_para(para)
        chunks: list[str] = []
        native_upright = is_original_layer and any(
            _item_reads_vertically(it, img_w, img_h) and is_cjk_dominant(str(it.get("text") or ""))
            for it in para.get("items") or [] if isinstance(it, dict))
        for item in para.get("items") or []:
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            chunk = _render_item_horizontal(item, text, para, img_w, img_h,
                override_fs=None if native_upright else shared_fs)
            if chunk:
                chunks.append(chunk)
        if not chunks:
            continue
        if is_original_layer:
            gi = group_of_para.get(int(para.get("para_index", -1)))
            gtext = ""
            if gi is None:
                # No explicit group covers this paragraph —
                # per-paragraph target, the original behaviour.
                gtext = _render_original_gtext_block(
                    para, img_w, img_h,
                    override_fs=shared_fs,
                    is_vertical=para_vertical[id(para)],
                    source_lang=source_lang,
                )
            elif gi not in gtext_done:
                gtext_done.add(gi)
                # A group holding nothing but a furigana reading gets NO target
                # block: on its own a bare kana pronunciation carries no
                # meaning, and the browser turns it into noise that then paints
                # over the neighbouring bubble's real translation.
                if not group_is_ruby_only(groups_list[gi], tree, img_h):
                    gtext = _render_group_gtext_block(
                        groups_list[gi], paragraphs_in_order, img_w, img_h,
                        override_fs=shared_fs,
                        source_lang=source_lang,
                    )
            group = (
                '<div class="tp-src notranslate" translate="no">'
                + "".join(chunks)
                + "</div>"
                + gtext
            )
            dark_para = para
            if gi is not None and gtext:
                member_indices = {
                    int(pi) for pi in (groups_list[gi].get("para_indices") or [])
                }
                if any(
                    bool(member.get("text_light"))
                    for member in paragraphs_in_order
                    if int(member.get("para_index", -1)) in member_indices
                ):
                    dark_para = {**para, "text_light": True}
            parts.append(_wrap_on_dark(group, dark_para))
        else:
            for c in chunks:
                parts.append(_wrap_on_dark(c, para))
        has_any = True

    parts.append("</div></div>")
    return "".join(parts) if has_any else ""
