"""Build an AI render tree directly from bubble_groups + translated text.

This module replaces the old ``patch.py`` geometry-borrowing approach.
Instead of deep-copying the Lens ``translated`` tree (which carries the
*source* language's item geometry — rotated 90° for vertical Japanese),
we build entirely new item boxes whose orientation matches the *target*
language.

Design principle
----------------
Lens builds the ``translated`` tree by giving each ``original`` item a new
text string while keeping the same geometry.  That is correct when source
and target are the same orientation (both horizontal, or both vertical CJK).
But for Japanese vertical → Thai horizontal the items come out rotated 90°
with Thai text — unreadable.

Here we build items from scratch:

1. **One paragraph per bubble group.**  Each ``bubble_group`` produced by
   :mod:`backend.render.groups` becomes one ``ai`` paragraph, carrying the
   combined translated text for that bubble.

2. **Item geometry from the bubble canvas.**  We take the group's
   ``bubble_bounds_px`` as the available canvas (the real speech-bubble
   outline detected by OpenCV / YOLO).  If the group has no
   ``bubble_bounds_px`` we fall back to the union AABB of the source items.

3. **Direction from the target language.**  :func:`resolve_text_direction`
   returns ``"h"`` for Thai / Latin / Cyrillic and ``"v"`` for CJK —
   exactly the same rule the renderer uses.  The constructed item boxes have
   ``rotation_deg = 0`` for horizontal and ``rotation_deg = 90`` for
   vertical.

4. **Font size from the source.**  We reuse the ``font_size_px`` already
   computed by ``group_paragraphs_into_bubbles`` (median glyph height of the
   source items).  This keeps the translation proportional to the surrounding
   art — the same philosophy as ``fit_render_box`` in
   :mod:`backend.render.region`.

5. **Text distribution across lines.**  The translated text is distributed
   across ``n_lines`` item boxes using
   :func:`backend.render.layout.distribute_to_template`.  ``n_lines`` is
   chosen so that each line is roughly as wide as the bubble's available
   width at the computed font size.

The resulting tree has the same paragraph → item structure as the original
and translated trees, with correct geometry for the target language.  The
renderer's ``_render_ai_region`` path continues to work unchanged: it reads
``bubble_groups["items"]`` whose boxes now already reflect the target
orientation.
"""

from __future__ import annotations

import math
from typing import Any

from backend.lens.languages import normalize as normalize_lang
from backend.render.fonts import budoux_parser
from backend.render.layout import distribute_to_template, pad_lines, font_size_minimum_for_image
from backend.render.region import LANGUAGE_DIRECTION, is_cjk_text, resolve_text_direction
from backend.render.patch import _line_text  # type: ignore[attr-defined]
from backend.render.tp_html import fit_item_font_size


# ---------------------------------------------------------------------------
# Internal geometry helpers
# ---------------------------------------------------------------------------

def _item_aabb(
    bg: dict,
    img_w: int,
    img_h: int,
) -> tuple[float, float, float, float] | None:
    """Union AABB of source items in image pixels (via normalised box field)."""
    lefts: list[float] = []
    tops: list[float] = []
    rights: list[float] = []
    bots: list[float] = []
    for it in bg.get("items") or []:
        box = it.get("box") or {}
        l = float(box.get("left") or 0.0) * img_w
        t = float(box.get("top") or 0.0) * img_h
        w = float(box.get("width") or 0.0) * img_w
        h = float(box.get("height") or 0.0) * img_h
        if w > 0 and h > 0:
            lefts.append(l)
            tops.append(t)
            rights.append(l + w)
            bots.append(t + h)
    if lefts:
        l0, t0 = min(lefts), min(tops)
        return l0, t0, max(rights) - l0, max(bots) - t0
    return None


def _item_aabb_from_bounds_px(
    bg: dict,
) -> tuple[float, float, float, float] | None:
    """Union AABB of source items using their ``bounds_px`` field directly.

    Preferred over ``_item_aabb`` when the canvas should match the exact
    source text extent (same-orientation groups) — ``bounds_px`` is already
    in pixels and is independent of the normalised ``box`` coordinate system.
    """
    x1s: list[float] = []
    y1s: list[float] = []
    x2s: list[float] = []
    y2s: list[float] = []
    for it in bg.get("items") or []:
        if not str(it.get("text") or "").strip():
            continue
        bpx = it.get("bounds_px")
        if not isinstance(bpx, (list, tuple)) or len(bpx) != 4:
            continue
        x1s.append(float(bpx[0]))
        y1s.append(float(bpx[1]))
        x2s.append(float(bpx[2]))
        y2s.append(float(bpx[3]))
    if not x1s:
        return None
    x1, y1 = min(x1s), min(y1s)
    return x1, y1, max(x2s) - x1, max(y2s) - y1


def _make_box_from_bounds_px(
    x1: float,
    y1: float,
    w_px: float,
    h_px: float,
    rot: float,
    img_w: int,
    img_h: int,
) -> dict:
    """Build a normalised box dict from pixel coordinates + rotation."""
    iw, ih = float(max(1, img_w)), float(max(1, img_h))
    left_n = x1 / iw
    top_n = y1 / ih
    w_n = w_px / iw
    h_n = h_px / ih
    cx_n = left_n + w_n / 2.0
    cy_n = top_n + h_n / 2.0
    return {
        "left": left_n,
        "top": top_n,
        "width": w_n,
        "height": h_n,
        "left_pct": left_n * 100.0,
        "top_pct": top_n * 100.0,
        "width_pct": w_n * 100.0,
        "height_pct": h_n * 100.0,
        "rotation_deg": rot,
        "rotation_deg_css": rot,
        "center": {"x": cx_n, "y": cy_n},
    }


def _bubble_canvas(
    bg: dict,
    img_w: int,
    img_h: int,
    prefer_bounds: bool = True,
) -> tuple[float, float, float, float] | None:
    """Return ``(left, top, width, height)`` in image pixels for a bubble group.

    When ``prefer_bounds`` is ``True`` (default) and ``bubble_bounds_px`` is
    present, uses the full OpenCV-detected speech-bubble outline — giving the
    AI text the entire bubble canvas to wrap into.

    When ``prefer_bounds`` is ``False`` (the caller detected that this
    ``bubble_bounds_px`` blob is *shared* between multiple groups), falls back
    to the group's item AABB — the tight bounding box of the source text
    items.  Because each group has distinct source items the AABBs don't
    overlap, preventing two AI paragraphs from rendering on top of each other.
    """
    if prefer_bounds:
        bb = bg.get("bubble_bounds_px")
        if isinstance(bb, (list, tuple)) and len(bb) == 4:
            x1, y1, x2, y2 = (float(v) for v in bb)
            w, h = x2 - x1, y2 - y1
            if w > 0 and h > 0:
                return x1, y1, w, h

    # Item AABB — prefer bounds_px (accurate for rotated items); fall back to
    # normalised box coordinates (less accurate when items are rotated 90°,
    # because box.width/height are then in the rotated frame, not visual pixels).
    aabb = _item_aabb_from_bounds_px(bg)
    if aabb is not None:
        return aabb
    aabb = _item_aabb(bg, img_w, img_h)
    if aabb is not None:
        return aabb

    # Last resort: bubble_bounds_px when item geometry is absent.
    if not prefer_bounds:
        bb = bg.get("bubble_bounds_px")
        if isinstance(bb, (list, tuple)) and len(bb) == 4:
            x1, y1, x2, y2 = (float(v) for v in bb)
            w, h = x2 - x1, y2 - y1
            if w > 0 and h > 0:
                return x1, y1, w, h
    return None


def _estimate_n_lines(
    text: str,
    canvas_w_px: float,
    canvas_h_px: float,
    font_px: float,
    direction: str,
) -> int:
    """Estimate the number of item lines needed for ``text`` at ``font_px``.

    For horizontal text: how many lines of width ``canvas_w`` at ``font_px``
    does the text need?  For vertical text: how many columns of height
    ``canvas_h``?

    The result is clamped to [1, 20] and rounded to a reasonable integer.
    """
    n_chars = sum(1 for ch in text if not ch.isspace())
    if n_chars == 0:
        return 1

    # Characters-per-line estimate (approximate glyph width = 0.65 × font_px)
    if direction == "v":
        chars_per_line = max(1.0, canvas_h_px / max(1.0, font_px))
    else:
        chars_per_line = max(1.0, canvas_w_px / max(1.0, font_px * 0.65))

    n = math.ceil(n_chars / chars_per_line)
    return max(1, min(20, n))


def _make_item_box(
    line_idx: int,
    n_lines: int,
    canvas_left: float,
    canvas_top: float,
    canvas_w: float,
    canvas_h: float,
    font_px: float,
    direction: str,
    img_w: int,
    img_h: int,
    source_rot_deg: float = 0.0,
) -> dict:
    """Construct a normalised box dict for one item within a bubble canvas.

    For **horizontal** target language:
    - Items stack top-to-bottom; each is full-width, ``font_px`` tall (+ gap).
    - ``rotation_deg`` = ``source_rot_deg`` (inherited canvas tilt, 0° for
      flat speech bubbles, non-zero for diagonally-drawn manga labels).

    For **vertical** target language (CJK):
    - Items are columns flowing right-to-left; each is ``font_px`` wide, full height.
    - ``rotation_deg = 90`` (upright CJK column).
    """
    iw, ih = float(max(1, img_w)), float(max(1, img_h))

    if direction == "v":
        # Columns right-to-left.
        col_w = canvas_w / max(1, n_lines)
        left_px = canvas_left + canvas_w - (line_idx + 1) * col_w
        top_px = canvas_top
        w_px = col_w
        h_px = canvas_h
        rot = 90.0
    else:
        # Rows top-to-bottom; tilt inherited from source canvas.
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

    return {
        "left": left_n,
        "top": top_n,
        "width": w_n,
        "height": h_n,
        "left_pct": left_n * 100.0,
        "top_pct": top_n * 100.0,
        "width_pct": w_n * 100.0,
        "height_pct": h_n * 100.0,
        "rotation_deg": rot,
        "rotation_deg_css": rot,
        "center": {"x": cx_n, "y": cy_n},
    }


# ---------------------------------------------------------------------------
# Rotation-aware canvas
# ---------------------------------------------------------------------------

def _source_rotation_canvas(
    bg: dict,
) -> tuple[float, float, float, float, float] | None:
    """Canvas for groups whose items all share a consistent rotation angle.

    Returns ``(left_n, top_n, w_n, h_n, rot_deg)`` in normalised [0, 1]
    coordinates.  The caller uses ``left_n / top_n / w_n / h_n`` as the
    *unrotated* box dimensions and ``rot_deg`` as the CSS ``rotate()`` angle,
    with ``transform-origin: center center`` — exactly mirroring how Lens
    positions its own items.

    Returns ``None`` when:
    - the group has no text-bearing items with valid box geometry, or
    - the spread of item rotation angles exceeds 20° (mixed-angle groups
      like status screens that contain both a tilted label and a flat
      speech bubble — these are handled by the AABB fallback instead).
    """
    items = [
        it for it in (bg.get("items") or [])
        if str(it.get("text") or "").strip()
    ]
    if not items:
        return None

    rots = [
        float((it.get("box") or {}).get("rotation_deg") or 0.0)
        for it in items
    ]
    avg_rot = sum(rots) / len(rots)
    if max(rots) - min(rots) > 20.0:
        return None  # mixed angles — caller uses AABB

    lefts: list[float] = []
    tops: list[float] = []
    rights: list[float] = []
    bots: list[float] = []
    for it in items:
        box = it.get("box") or {}
        l = float(box.get("left") or 0.0)
        t = float(box.get("top") or 0.0)
        w = float(box.get("width") or 0.0)
        h = float(box.get("height") or 0.0)
        if w > 0 and h > 0:
            lefts.append(l)
            tops.append(t)
            rights.append(l + w)
            bots.append(t + h)

    if not lefts:
        return None
    l0, t0 = min(lefts), min(tops)
    w0 = max(rights) - l0
    h0 = max(bots) - t0
    if w0 <= 0 or h0 <= 0:
        return None
    return l0, t0, w0, h0, avg_rot


# ---------------------------------------------------------------------------
# Canvas expansion for direction-change boxes (spec §10 / §16)
# ---------------------------------------------------------------------------

def _expand_canvas_for_rotation(
    src_aabb: tuple[float, float, float, float],
    other_bounds: list[tuple[float, float, float, float]],
    target_direction: str,
    img_w: int,
    img_h: int,
    aspect_target: float = 1.5,
    margin: float = 2.0,
) -> tuple[float, float, float, float]:
    """Expand a paragraph's AI canvas when its direction is being changed.

    Per spec §10 and §16:

    * a vertical source box (height > width) translated into a horizontal
      target is allowed to **expand left and right** — its height stays the
      same;
    * a horizontal source box translated into a vertical target may
      **expand upward and downward** — its width stays the same;
    * other cases are returned unchanged.

    The expansion targets an aspect ratio appropriate for the new
    direction (``aspect_target`` ≈ 1.5 = landscape for horizontal text)
    while preserving the source area, and is clipped so it:

    1. never leaves the image, and
    2. never overlaps any other paragraph's ``bounds_px`` (passed in as
       ``other_bounds`` = list of ``(x1, y1, x2, y2)`` in pixels).

    Returns ``(left, top, width, height)`` in pixels.
    """
    sx, sy, sw, sh = src_aabb
    if sw <= 0 or sh <= 0:
        return src_aabb
    area = sw * sh
    cx = sx + sw / 2.0
    cy = sy + sh / 2.0
    is_v_source = sh > sw

    if target_direction == "h" and is_v_source:
        ideal_w = math.sqrt(area * aspect_target)
        new_w = max(sw, ideal_w)
        new_left = cx - new_w / 2.0
        new_right = cx + new_w / 2.0
        new_left = max(0.0, new_left)
        new_right = min(float(img_w), new_right)
        for ox1, oy1, ox2, oy2 in other_bounds:
            if oy2 <= sy or oy1 >= sy + sh:
                continue  # no vertical overlap → doesn't block horizontal expansion
            if ox2 <= sx and ox2 > new_left:
                new_left = ox2 + margin
            if ox1 >= sx + sw and ox1 < new_right:
                new_right = ox1 - margin
        new_w = max(sw, new_right - new_left)
        return new_left, sy, new_w, sh

    if target_direction == "v" and not is_v_source:
        ideal_h = math.sqrt(area / aspect_target)
        new_h = max(sh, ideal_h)
        new_top = cy - new_h / 2.0
        new_bot = cy + new_h / 2.0
        new_top = max(0.0, new_top)
        new_bot = min(float(img_h), new_bot)
        for ox1, oy1, ox2, oy2 in other_bounds:
            if ox2 <= sx or ox1 >= sx + sw:
                continue  # no horizontal overlap
            if oy2 <= sy and oy2 > new_top:
                new_top = oy2 + margin
            if oy1 >= sy + sh and oy1 < new_bot:
                new_bot = oy1 - margin
        new_h = max(sh, new_bot - new_top)
        return sx, new_top, sw, new_h

    return src_aabb


# ---------------------------------------------------------------------------
# Span building
# ---------------------------------------------------------------------------

def _tokenise_for_spans(
    text: str,
    parser: Any,
    direction: str,
) -> list[str]:
    """Split *text* into tokens for span-level geometry.

    * Vertical text (CJK columns): one character per span — each glyph
      occupies its own slot in the column.
    * Horizontal text with a BudouX parser: parser chunks give natural
      word-break positions for Thai / Japanese / Chinese.
    * Horizontal text without parser: whitespace split (Latin, unknown).
    """
    if not text:
        return []
    if direction == "v":
        return [ch for ch in text if not ch.isspace()]
    if parser is not None:
        try:
            chunks = parser.parse(text)
            if chunks:
                return [c for c in chunks if c]
        except Exception:
            pass
    tokens = [w for w in text.split() if w]
    return tokens if tokens else [text]


def _build_item_spans(
    item: dict,
    para_index: int,
    item_index: int,
    parser: Any,
    lang_norm: str,  # noqa: ARG001 — reserved for future per-language tuning
    img_w: int,
    img_h: int,
) -> list[dict]:
    """Build word/character-level span dicts for one AI item.

    Proportional placement
    ----------------------
    Tokens are distributed evenly along the item's primary reading axis:

    * **Horizontal items** (``rotation_deg ≈ 0°``): spans go left-to-right,
      each occupying ``1/n`` of the item width.
    * **Vertical items** (``rotation_deg ≈ 90°``): spans go top-to-bottom,
      each occupying ``1/n`` of the item height (one character per slot).

    All coordinate values are normalised to [0, 1] relative to image
    dimensions — consistent with the Original / Translated tree fields.
    The returned list is empty when *item* has no text.
    """
    text = str(item.get("text") or "")
    if not text:
        return []

    box = item.get("box") or {}
    rot = float(box.get("rotation_deg") or 0.0)
    direction = "v" if abs(rot) > 60 else "h"

    tokens = _tokenise_for_spans(text, parser, direction)
    if not tokens:
        return []

    item_left = float(box.get("left") or 0.0)
    item_top = float(box.get("top") or 0.0)
    item_w = float(box.get("width") or 0.0)
    item_h = float(box.get("height") or 0.0)

    # height_raw: normalised glyph height.
    # For horizontal items the item height approximates the font cap-height.
    # For vertical columns the item *width* equals one glyph's em-square.
    height_raw = item_w if direction == "v" else item_h

    n = len(tokens)
    spans: list[dict] = []
    byte_offset = 0

    for si, token_text in enumerate(tokens):
        t0 = si / n
        t1 = (si + 1) / n

        if direction == "v":
            # Stack glyphs top-to-bottom within the column.
            sp_left = item_left
            sp_top = item_top + t0 * item_h
            sp_w = item_w
            sp_h = (t1 - t0) * item_h
            sp_cx = sp_left + sp_w / 2.0
            # Baseline runs vertically through column centre.
            bl_p1: dict = {"x": sp_cx, "y": sp_top}
            bl_p2: dict = {"x": sp_cx, "y": sp_top + sp_h}
        else:
            # Spread tokens left-to-right along the row.
            sp_left = item_left + t0 * item_w
            sp_top = item_top
            sp_w = (t1 - t0) * item_w
            sp_h = item_h
            sp_cy = sp_top + sp_h / 2.0
            # Baseline runs horizontally through row centre.
            bl_p1 = {"x": sp_left, "y": sp_cy}
            bl_p2 = {"x": sp_left + sp_w, "y": sp_cy}

        sp_box: dict = {
            "left": sp_left,
            "top": sp_top,
            "width": sp_w,
            "height": sp_h,
            "left_pct": sp_left * 100.0,
            "top_pct": sp_top * 100.0,
            "width_pct": sp_w * 100.0,
            "height_pct": sp_h * 100.0,
            "rotation_deg": rot,
            "rotation_deg_css": rot,
            "center": {"x": sp_left + sp_w / 2.0, "y": sp_top + sp_h / 2.0},
        }

        token_bytes = len(token_text.encode("utf-8"))
        end_offset = byte_offset + token_bytes

        spans.append({
            "side": "Ai",
            "para_index": para_index,
            "item_index": item_index,
            "span_index": si,
            "text": token_text,
            "valid_text": True,
            "start_raw": byte_offset,
            "end_raw": end_offset,
            "t0_raw": t0,
            "t1_raw": t1,
            "height_raw": height_raw,
            "baseline_p1": bl_p1,
            "baseline_p2": bl_p2,
            "box": sp_box,
        })
        byte_offset = end_offset

    return spans


# ---------------------------------------------------------------------------
# Image-level orientation (the "50 % box rule")
# ---------------------------------------------------------------------------

def _count_text_items(bg: dict) -> int:
    """Number of text-bearing items inside a bubble group."""
    return sum(
        1 for it in (bg.get("items") or [])
        if str(it.get("text") or "").strip()
    )


def is_single_set_group(bg: dict) -> bool:
    """True for a *single-set* box — one box that carries one text set.

    In the source render tree this is the paragraph whose ``paragraph.text``
    (the parent group) is identical to its only ``items[].text`` (the child
    sub-group): there is exactly one text item, so the box has no internal
    structure to re-flow.

    Single-set boxes are excluded from the orientation vote and are **never**
    rotated — a lone decorative label keeps the exact angle the artist drew.
    """
    return _count_text_items(bg) <= 1


def _is_furigana_paragraph(
    bg: dict,
    bubble_groups: list[dict],
    img_w: int,
    img_h: int,
) -> bool:
    """True when a paragraph is likely a Japanese **furigana** annotation.

    Furigana is the small reading-guide kana that sits to the *right* of a
    main kanji column in vertical Japanese text.  Lens OCR detects it as a
    separate paragraph, so without filtering the pipeline translates *both*
    the furigana ("おれまえ" → "In front of me…") and the main kanji
    ("俺の前で" → "In front of me.") and renders them in nearly the same
    spot — the user sees the same English phrase stacked twice.

    A paragraph is treated as furigana when (ALL thresholds are RELATIVE to
    the candidate's own size — absolute pixel gates broke on cover pages
    whose huge stylised lettering carries equally huge furigana):

    1. its items are vertical-source (axis-aligned ≈ ±90°);
    2. another *vertical* paragraph lives immediately to its **left**
       (the kanji column) at least **2.5×** wider — a tighter ratio than
       1.5× so an ordinary multi-column dialogue bubble (e.g. pi=19
       コピーする next to pi=20 あいて相手か… at 1.78×) is not mistaken
       for a furigana annotation;
    3. the two paragraphs vertically overlap by at least half of this
       paragraph's height;
    4. the horizontal gap to that column is within ~0.8× of the candidate's
       own width (furigana hugs the column it annotates, at every scale).

    Furigana paragraphs are skipped by :func:`build_ai_tree` so the AI
    tree carries only the main translation, removing the duplicate.
    """
    if not _is_vertical_source_paragraph(bg):
        return False
    my = _item_aabb_from_bounds_px(bg) or _item_aabb(bg, img_w, img_h)
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
        if not _is_vertical_source_paragraph(other):
            continue
        ot = _item_aabb_from_bounds_px(other) or _item_aabb(other, img_w, img_h)
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
        # Furigana sits to the RIGHT of the main column: mx1 ≈ ox2.
        # Scale-relative: allow slight overlap (-0.15w) up to a 0.8w gap.
        gap = mx1 - ox2
        if -0.15 * mw <= gap <= 0.8 * mw:
            return True
    return False


def _is_vertical_source_paragraph(bg: dict) -> bool:
    """True when the source items of a paragraph read as vertical columns.

    Used to pick between :func:`_canvas_for_v_source` and
    :func:`_canvas_for_h_source` — the two **clearly separated** paragraph
    layout paths.  A paragraph is treated as vertical-source when at least
    half of its axis-aligned text items have a rotation closer to ±90° than
    to 0° (the user spec calls these "vertical Japanese / Chinese columns").
    """
    items = [
        it for it in (bg.get("items") or [])
        if str(it.get("text") or "").strip()
    ]
    if not items:
        return False
    n_axis = n_v = 0
    for it in items:
        r = float((it.get("box") or {}).get("rotation_deg") or 0.0)
        residual = ((r + 45.0) % 90.0) - 45.0
        if abs(residual) > 12.0:
            continue  # tilted / decorative — not axis-aligned, skip in vote
        n_axis += 1
        r_mod = r % 180.0
        if r_mod > 90.0:
            r_mod -= 180.0
        if abs(r_mod) > 45.0:
            n_v += 1
    if n_axis == 0:
        return False
    return n_v * 2 >= n_axis


def _canvas_for_h_source(
    bg: dict,
    direction_change: bool,
    target_direction: str,
    all_para_bounds: list[tuple[float, float, float, float]],
    is_tilted: bool,
    is_curved: bool,
    avg_rot: float,
    img_w: int,
    img_h: int,
) -> tuple[tuple[float, float, float, float] | None, bool, float]:
    """Build the AI canvas for a **horizontal-source** paragraph.

    Horizontal-source paragraphs have items stacked as rows.  Two cases:

    * **target horizontal (same direction)** — items reuse their source
      positions and tilt, so the artist's row layout / curvature is
      preserved (``use_per_item_rotation = True``).
    * **target vertical (h→v direction change)** — the canvas may grow
      *upward and downward* (spec §16) and fresh column items are placed
      inside; per-item rotation is dropped so the new columns aren't
      tilted by the original row angle.

    Returns ``(aabb, use_per_item_rotation, source_rot_deg)``.
    """
    aabb = _item_aabb_from_bounds_px(bg) or _item_aabb(bg, img_w, img_h)
    if aabb is None:
        return None, False, 0.0
    if direction_change:
        my_box = (aabb[0], aabb[1], aabb[0] + aabb[2], aabb[1] + aabb[3])
        others = [b for b in all_para_bounds if b != my_box]
        aabb = _expand_canvas_for_rotation(
            aabb, others, target_direction, img_w, img_h
        )
        return aabb, False, 0.0
    source_rot_deg = avg_rot if (is_tilted or is_curved) else 0.0
    return aabb, True, source_rot_deg


def _canvas_for_v_source(
    bg: dict,
    direction_change: bool,
    target_direction: str,
    all_para_bounds: list[tuple[float, float, float, float]],
    is_tilted: bool,
    is_curved: bool,
    avg_rot: float,
    img_w: int,
    img_h: int,
) -> tuple[tuple[float, float, float, float] | None, bool, float]:
    """Build the AI canvas for a **vertical-source** paragraph.

    Vertical-source paragraphs have items as columns: either several columns
    side-by-side (manga right-to-left), or one column split into sub-items
    (furigana / annotation breaks).  Two cases:

    * **target vertical (same direction)** — items reuse their source
      column positions so the artist's column layout is preserved
      (``use_per_item_rotation = True``).
    * **target horizontal (v→h direction change)** — the multi-column
      source text is treated as one continuous paragraph (``group_text``,
      already pre-joined by groups.py), the canvas may grow *left and
      right* (spec §16) and fresh row items are placed inside.

    Returns ``(aabb, use_per_item_rotation, source_rot_deg)``.
    """
    aabb = _item_aabb_from_bounds_px(bg) or _item_aabb(bg, img_w, img_h)
    if aabb is None:
        return None, False, 0.0
    if direction_change:
        my_box = (aabb[0], aabb[1], aabb[0] + aabb[2], aabb[1] + aabb[3])
        others = [b for b in all_para_bounds if b != my_box]
        aabb = _expand_canvas_for_rotation(
            aabb, others, target_direction, img_w, img_h
        )
        return aabb, False, 0.0
    source_rot_deg = avg_rot if (is_tilted or is_curved) else 0.0
    return aabb, True, source_rot_deg


def _is_axis_aligned_group(bg: dict) -> bool:
    """True when a bubble group reads at a clear 0° / ±90° axis.

    Per spec §13 / §9, tilted, curved or distorted paragraphs are excluded
    both from the image-direction vote and from automatic rotation — they
    may be decorative or follow the artwork's flow rather than the main
    reading direction.

    A paragraph is considered axis-aligned when **every** item is within
    ±12° of either 0° or ±90° AND every item lives on the *same* axis (all
    horizontal or all vertical) — two vertical columns reported as +89°
    and –89° still count as one vertical paragraph, but a mix of 0° items
    and 90° items does not (that is a curved / mixed group).
    """
    items = [
        it for it in (bg.get("items") or [])
        if str(it.get("text") or "").strip()
    ]
    if not items:
        return False
    axes: set[str] = set()
    for it in items:
        r = float((it.get("box") or {}).get("rotation_deg") or 0.0)
        residual = ((r + 45.0) % 90.0) - 45.0
        if abs(residual) > 12.0:
            return False  # tilted / curved item — not axis-aligned
        r_mod = r % 180.0
        if r_mod > 90.0:
            r_mod -= 180.0
        axes.add("v" if abs(r_mod) > 45.0 else "h")
    return len(axes) == 1


def detect_image_orientation(bubble_groups: list[dict]) -> str:
    """Decide the whole page's dominant reading orientation — ``"h"`` / ``"v"``.

    Per spec §13, the "50 % box rule" counts how many *multi-set,
    axis-aligned* boxes read vertically vs horizontally.  Three exclusions:

    1. single-set paragraphs (one box, one item) — an isolated label is not
       evidence of the page's reading flow;
    2. tilted / curved / distorted paragraphs — decorative or art-driven
       text doesn't describe the main reading direction either;
    3. anything not clearly 0° or 90°.

    When at least half of the eligible boxes are vertical the image is
    vertical, otherwise horizontal.  Falls back to any axis-aligned box,
    then ``"h"``, when no eligible vote can be cast.
    """
    pool = [
        bg for bg in bubble_groups
        if not is_single_set_group(bg) and _is_axis_aligned_group(bg)
    ]
    if not pool:
        pool = [bg for bg in bubble_groups if _is_axis_aligned_group(bg)]
    if not pool:
        return "h"
    n_vert = sum(1 for bg in pool if str(bg.get("direction") or "h") == "v")
    return "v" if n_vert * 2 >= len(pool) else "h"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_ai_tree(
    bubble_groups: list[dict],
    ai_group_texts: list[str],
    original_tree: dict,
    target_lang: str,
    img_w: int,
    img_h: int,
) -> dict[str, Any]:
    """Build a fresh AI render tree from bubble groups + translated texts.

    Parameters
    ----------
    bubble_groups:
        The ``original_tree["bubble_groups"]`` list produced by
        :func:`backend.render.groups.group_paragraphs_into_bubbles`.
    ai_group_texts:
        Translated text for each group (same order as ``bubble_groups``).
        Produced by :func:`backend.ai.markers.extract_paragraphs` after the
        AI translation call.
    original_tree:
        The original Lens tree.  Used only to carry ``side`` metadata and
        image-level fields; its ``paragraphs`` list is **not** copied into
        the result.
    target_lang:
        ISO language code of the target language (e.g. ``"th"``, ``"en"``).
    img_w, img_h:
        Image dimensions in pixels.

    Returns
    -------
    dict
        A new AI tree ``{"side": "Ai", "paragraphs": [...], ...}`` whose
        items have geometry appropriate for ``target_lang``.
    """
    lang_norm = normalize_lang(target_lang)
    parser = budoux_parser(lang_norm)
    min_size_px = font_size_minimum_for_image(img_w, img_h)

    # Pre-count bubble_bounds_px occurrences.  When the same OpenCV blob
    # covers multiple groups (e.g. two speech bubbles merged into one detected
    # region), prefer_bounds is set False so each group uses its item AABB
    # instead — preventing their AI paragraphs from overlapping in the render.
    bb_count: dict[tuple[float, ...], int] = {}
    for _bg in bubble_groups:
        _bb = _bg.get("bubble_bounds_px")
        if isinstance(_bb, (list, tuple)) and len(_bb) == 4:
            _key = tuple(round(float(v), 1) for v in _bb)
            bb_count[_key] = bb_count.get(_key, 0) + 1

    # Per-paragraph AABBs in pixels — needed so a direction-change box that
    # has to expand (spec §10 / §16) can avoid overlapping any neighbour.
    all_para_bounds: list[tuple[float, float, float, float]] = []
    for _bg in bubble_groups:
        _ab = _item_aabb_from_bounds_px(_bg) or _item_aabb(_bg, img_w, img_h)
        if _ab is None:
            continue
        all_para_bounds.append((_ab[0], _ab[1], _ab[0] + _ab[2], _ab[1] + _ab[3]))

    # ── Image-level orientation decision (computed once for the page) ──────
    #
    # The reading orientation is now a single page-wide decision instead of a
    # per-group guess:
    #
    #   • image_orientation  — the 50 %-box vote (detect_image_orientation),
    #                          counting only multi-set boxes.
    #   • target_orientation — what the target language wants
    #                          (LANGUAGE_DIRECTION; "auto" CJK → the image).
    #   • image_rotates      — True when those differ, i.e. the page must be
    #                          rotated 90°↔0° to suit the target language.
    #
    # The four rotation cases the user described fall out of this directly:
    #   source 90° → target  0°  : image_rotates = True   (vertical → flat)
    #   source  0° → target 90°  : image_rotates = True   (flat → vertical)
    #   source  0° → target  0°  : image_rotates = False  (no change)
    #   source 90° → target 90°  : image_rotates = False  (no change)
    lang_preset = LANGUAGE_DIRECTION.get(lang_norm, "")
    image_orientation = detect_image_orientation(bubble_groups)
    if lang_preset in ("h", "hr"):
        target_orientation = "h"
    elif lang_preset == "v":
        target_orientation = "v"
    else:
        # "auto" target: CJK (ja/zh) is conventionally typeset VERTICALLY in
        # manga, so default to vertical regardless of the source page's
        # orientation.  A horizontal source page (e.g. English) is then
        # re-arranged into vertical CJK columns (h->v direction change) — the
        # existing horizontal groups are simply re-stacked as columns.  Truly
        # unknown target languages fall back to following the detected page.
        if lang_preset == "auto":
            target_orientation = "v"
        else:
            target_orientation = image_orientation
    image_rotates = image_orientation != target_orientation

    out_paragraphs: list[dict[str, Any]] = []

    for gi, bg in enumerate(bubble_groups):
        group_text = ai_group_texts[gi] if gi < len(ai_group_texts) else ""
        group_text = (group_text or "").strip()

        # Skip single-character source fragments (Lens OCR artefacts like
        # "し", "も" detached from their sentence).  These generate meaningless
        # one-word translations that render over the real bubble text.
        src_text = str(bg.get("text") or "").strip()
        if sum(1 for c in src_text if not c.isspace()) < 2:
            continue


        # Skip furigana annotation paragraphs — small reading-guide kana
        # drawn next to the main kanji column.  Without this filter the
        # pipeline translates both the furigana ("おれまえ") and the kanji
        # ("俺の前で") and the user sees the same English phrase stacked
        # twice in nearly the same position.
        if _is_furigana_paragraph(bg, bubble_groups, img_w, img_h):
            continue

        # Source item rotations — drive both the direction decision and the
        # curvature / tilt detection below.
        src_text_items = [
            it for it in (bg.get("items") or [])
            if str(it.get("text") or "").strip()
        ]
        src_rots = [
            float((it.get("box") or {}).get("rotation_deg") or 0.0)
            for it in src_text_items
        ]
        avg_rot = sum(src_rots) / len(src_rots) if src_rots else 0.0
        rot_spread = (max(src_rots) - min(src_rots)) if len(src_rots) > 1 else 0.0

        # Tilted: group's average angle is significantly non-zero (±5°+).
        # Curved: multiple items whose individual angles differ by > 3° total.
        is_tilted = abs(avg_rot) > 5.0
        is_curved = rot_spread > 3.0

        # Direction ————————————————————————————————————————————————
        # Per spec §9 + §11: a paragraph can only auto-rotate when its
        # source angle is *clearly* 0° or ±90° (axis-aligned).  Tilted,
        # curved or distorted text — decorative captions, sound effects,
        # art-aligned labels — preserves the artist's angle / curvature
        # and is never auto-rotated.
        #
        # The rule covers BOTH single-set and multi-item paragraphs in one
        # check, replacing the older "single-set is exempt" carve-out: a
        # single vertical reading column (axis-aligned, |rot|≈90°) still
        # flips to horizontal for a horizontal target, while a diagonally
        # drawn single label stays at its tilt.
        is_single_set = is_single_set_group(bg)
        is_axis_aligned = _is_axis_aligned_group(bg)
        residual_tilt = ((avg_rot + 45.0) % 90.0) - 45.0  # angle off the 0/90 grid
        is_decorative_label = not is_axis_aligned
        if is_axis_aligned:
            direction = target_orientation
            direction_change = image_rotates
        else:
            direction = str(bg.get("direction") or "h")
            direction_change = False

        # Guard against shattering a long, WIDE-AND-SHORT horizontal caption
        # into many sparse vertical columns on an h->v change.  A single-line
        # banner (e.g. a footer credit) whose source box is far wider than tall
        # has no vertical room: forced vertical it becomes 10+ thin columns
        # spread across the page.  When the source is one wide-short horizontal
        # line, keep it horizontal even if the page rotates.  Purely aspect-
        # driven (no per-image constant): "wide-short" = width > 4x height with
        # a single source line.
        if (
            direction_change
            and direction == "v"
            and not _is_vertical_source_paragraph(bg)
        ):
            src_aabb_chk = _item_aabb_from_bounds_px(bg) or _item_aabb(bg, img_w, img_h)
            n_src_lines = len(src_text_items)
            if src_aabb_chk is not None:
                _sw, _sh = src_aabb_chk[2], src_aabb_chk[3]
                if n_src_lines <= 1 and _sw > 4.0 * max(1.0, _sh):
                    direction = "h"
                    direction_change = False

        # Shared-blob guard — prefer item AABB over bubble_bounds_px when the
        # same OpenCV blob covers multiple groups (prevents overlapping divs).
        _bb = bg.get("bubble_bounds_px")
        prefer_bb = True
        if isinstance(_bb, (list, tuple)) and len(_bb) == 4:
            _key = tuple(round(float(v), 1) for v in _bb)
            prefer_bb = (bb_count.get(_key, 1) == 1)

        # ── Geometry ──────────────────────────────────────────────────────────
        #
        # INVARIANT: The AI canvas must never exceed the original
        # paragraph.bounds_px.  The translated text occupies the same spatial
        # footprint as the source — no bigger.  bubble_bounds_px is the
        # speech-bubble outline (often much larger than the text area) and
        # must not be used as the canvas.
        #
        # Canvas source priority (all cases):
        #   1. Union AABB of source item bounds_px (_item_aabb_from_bounds_px)
        #      — preferred because bounds_px is pixel-accurate and
        #        orientation-independent (a vertical CJK column has the
        #        correct visual extent in bounds_px even though its box.*
        #        fields are in the rotated coordinate frame).
        #   2. Union AABB via normalised box fields (_item_aabb) — fallback
        #      when bounds_px is absent.
        #   3. Skip this group entirely.
        #
        # Per-item rotation:
        #   • Consistent-angle tilted/curved groups (rot_spread ≤ 20°):
        #     each AI item inherits the rotation of its matching source item.
        #   • Mixed-rotation groups (rot_spread > 20°): degrade to flat
        #     rendering using only the flat source items (|rot| < 20°) so
        #     the canvas doesn't encroach on adjacent paragraphs.
        #   • All other groups (flat / direction-change): flat layout.

        # ── Canvas dispatch: vertical-source vs horizontal-source path ──
        # The two paths are clearly separated so the vertical-only quirks
        # (multi-column items, ±90° rotation signs, tall-narrow AABB) never
        # bleed into the horizontal handling and vice-versa.
        src_is_vertical = _is_vertical_source_paragraph(bg)
        if src_is_vertical:
            aabb, use_per_item_rotation, source_rot_deg = _canvas_for_v_source(
                bg, direction_change, direction, all_para_bounds,
                is_tilted, is_curved, avg_rot, img_w, img_h,
            )
        else:
            aabb, use_per_item_rotation, source_rot_deg = _canvas_for_h_source(
                bg, direction_change, direction, all_para_bounds,
                is_tilted, is_curved, avg_rot, img_w, img_h,
            )

        if aabb is None:
            continue
        canvas_left, canvas_top, canvas_w, canvas_h = aabb

        if canvas_w <= 0 or canvas_h <= 0:
            continue

        # Clamp the canvas inside the image so a direction-change expansion
        # (h->v growing up/down, v->h growing left/right) can never push a box
        # past the page edge.  General safety net for every orientation.
        canvas_left = max(0.0, min(canvas_left, float(img_w) - 1.0))
        canvas_top = max(0.0, min(canvas_top, float(img_h) - 1.0))
        canvas_w = min(canvas_w, float(img_w) - canvas_left)
        canvas_h = min(canvas_h, float(img_h) - canvas_top)

        # Text metrics ──────────────────────────────────────────────────────
        # ``glyph_ratio`` is the glyph advance as a fraction of the font size:
        # CJK glyphs are ~square (1.0), Thai / Latin glyphs ~0.55 as wide as
        # tall.  It drives both the font cap and the line-count estimate.
        _n_chars = sum(1 for _c in group_text if not _c.isspace())
        glyph_ratio = 1.0 if is_cjk_text(group_text) else 0.55

        src_font_px = max(float(min_size_px), float(bg.get("font_size_px") or 0.0))

        # Largest source glyph height (px) across the group's text items.  This
        # is how big the ORIGINAL text was drawn, and it caps the translation so
        # a merged vertical bubble (whose union canvas can be large) does not
        # blow the font up to fill the whole box on a direction change.  Using
        # the MAX (not median) keeps the main display line readable while still
        # bounding it to the artist's own scale — fully size-driven, no per-image
        # constants.
        src_glyph_heights = [
            float((it.get("box") or {}).get("height") or 0.0) * img_h
            for it in src_text_items
        ]
        src_glyph_heights = [h for h in src_glyph_heights if h > 1.0]
        src_max_glyph_px = max(src_glyph_heights) if src_glyph_heights else src_font_px

        # Area cap — the largest font whose total glyph area fits the canvas
        # (``n × ratio × F`` wide, wrapped, × ``F × line_height`` tall).
        if _n_chars > 1 and canvas_w > 0 and canvas_h > 0:
            area_cap = math.sqrt(
                canvas_w * canvas_h / max(1.0, _n_chars * glyph_ratio * 1.2)
            )
        else:
            area_cap = float(max(canvas_w, canvas_h, min_size_px))

        # Candidate font size.
        #   • direction change — the source glyph size measured along the OLD
        #     axis isn't directly reusable, but the source's largest glyph
        #     HEIGHT is a good scale anchor: the translation should read about
        #     as big as the original display text, never bigger.  So the
        #     candidate is the area-fill cap bounded by ~1.2× the largest source
        #     glyph — preventing the over-inflation seen on merged vertical
        #     bubbles while still letting a small label grow a little.
        #   • same orientation — keep the source glyph size, area-capped.
        if direction_change:
            cand_font = min(area_cap, src_max_glyph_px)
        else:
            cand_font = min(src_font_px, area_cap)
        cand_font = max(float(min_size_px), cand_font)

        # Grid-fit font: the largest size at which ``nl`` lines/columns of
        # this text fit the canvas in BOTH axes — the along-line extent
        # (glyphs per line) and the across-line extent (line count).
        def _grid_font(nl: int) -> float:
            cpl = math.ceil(_n_chars / nl) if _n_chars else 1
            if direction == "h":
                along = canvas_w / max(1, cpl) / max(0.1, glyph_ratio)
                across = canvas_h / (nl * 1.15)
            else:
                along = canvas_h / max(1, cpl)
                across = canvas_w / max(1, nl)
            return min(along, across)

        # Line / column count — the *fewest* lines that still let the text
        # render at a readable size.  Starting from the artist's own item
        # count (1 for a direction change, which re-flows onto a new axis),
        # the count is raised only while the grid-fit font would fall below
        # the per-image minimum.  This keeps a short label on a single line
        # instead of chopping it into several, yet still wraps a long
        # translation just enough to fit — wrapping is not rotation, so the
        # single-set "do not rotate" rule is unaffected.
        # Natural wrap-unit count of the translated text — BudouX chunks
        # for Thai/CJK targets, whitespace-separated tokens otherwise.  Used
        # as an upper bound on the line count so a short translation doesn't
        # get character-broken across more lines than it has words.
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

        if direction_change:
            # Direction change — the canvas keeps the source's tall-narrow
            # (or wide-short) shape, so the rotated text would otherwise sit
            # tiny inside a much larger box.  Grow ``n_lines`` toward the
            # grid-fit *peak* (the largest font the canvas can hold) so the
            # text fills the available area, capped by the natural wrap-unit
            # count so we never character-break a short translation across
            # too many lines.
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
            # Same direction — start at the artist's own item count and grow
            # only while the grid-fit font is still below the minimum (a
            # genuinely cramped box).  This keeps short labels on a single
            # line instead of fragmenting them, the behaviour the user
            # specifically asked for in §7 / §14.
            n_lines = max(1, len(src_text_items))
            best_fit = _grid_font(n_lines)
            while n_lines < 20 and best_fit < float(min_size_px):
                nxt = _grid_font(n_lines + 1)
                if nxt <= best_fit:
                    break
                n_lines += 1
                best_fit = nxt

        # Final font: the source / area candidate, clamped to the grid so the
        # text cannot spill past the canvas; never below the image minimum.
        font_px = max(float(min_size_px), min(cand_font, _grid_font(n_lines)))


        # Build synthetic template items.
        # For per-item-rotation path: each item box is copied from the
        # corresponding source item's bounds_px + rotation_deg so that
        # tilted labels and curved baselines are reproduced exactly.
        template_items: list[dict] = []
        for li in range(n_lines):
            if use_per_item_rotation and li < len(src_text_items):
                src_it = src_text_items[li]
                src_rot = float((src_it.get("box") or {}).get("rotation_deg") or 0.0)
                src_bpx = src_it.get("bounds_px")
                if isinstance(src_bpx, (list, tuple)) and len(src_bpx) == 4:
                    x1, y1, x2, y2 = (float(v) for v in src_bpx)
                    iw_px = x2 - x1
                    ih_px = y2 - y1
                    if iw_px > 0 and ih_px > 0:
                        box = _make_box_from_bounds_px(
                            x1, y1, iw_px, ih_px, src_rot, img_w, img_h
                        )
                    else:
                        box = _make_item_box(
                            li, n_lines,
                            canvas_left, canvas_top, canvas_w, canvas_h,
                            font_px, direction, img_w, img_h,
                            source_rot_deg=src_rot,
                        )
                else:
                    box = _make_item_box(
                        li, n_lines,
                        canvas_left, canvas_top, canvas_w, canvas_h,
                        font_px, direction, img_w, img_h,
                        source_rot_deg=source_rot_deg,
                    )
            else:
                box = _make_item_box(
                    li, n_lines,
                    canvas_left, canvas_top, canvas_w, canvas_h,
                    font_px, direction, img_w, img_h,
                    source_rot_deg=source_rot_deg,
                )
            template_items.append({
                "side": "Ai",
                "text": "",
                "valid_text": False,
                "box": box,
                "spans": [],
                "baseline_p1": {"x": box["left"], "y": box["top"] + box["height"] / 2.0},
                "baseline_p2": {"x": box["left"] + box["width"], "y": box["top"] + box["height"] / 2.0},
                "height_raw": box["height"],
            })

        # Distribute text
        if group_text:
            lines = distribute_to_template(
                group_text, template_items, parser, lang_norm, img_w, img_h
            )
            lines = pad_lines(lines, n_lines)
        else:
            lines = [[] for _ in range(n_lines)]

        # Populate items with distributed text + font sizes.
        # Use the pre-computed font_px for all items \u2014 consistent and
        # predictable.  fit_item_font_size is intentionally bypassed here
        # because it tries to fill the box *height*, which for evenly-split
        # horizontal rows is the row height (canvas_h / n_lines), not the
        # intended glyph size.  This caused font sizes of 100+ px for groups
        # whose canvas is tall (e.g. portrait English speech bubbles).
        fs_fixed = max(min_size_px, int(round(font_px)))
        for li, item in enumerate(template_items):
            line_tokens = lines[li] if li < len(lines) else []
            line_text = _line_text(line_tokens)

            item["text"] = line_text
            item["valid_text"] = bool(line_text)
            item["para_index"] = gi
            item["item_index"] = li
            item["font_size_px"] = fs_fixed

            box = item["box"]

            # Item bounds_px: [x1, y1, x2, y2] in pixels (same format as Lens).
            item["bounds_px"] = [
                box["left"] * img_w,
                box["top"] * img_h,
                (box["left"] + box["width"]) * img_w,
                (box["top"] + box["height"]) * img_h,
            ]

            # height_raw: normalised glyph height (font px / image height).
            item["height_raw"] = fs_fixed / float(max(1, img_h))

            # Baseline: midline through the item box (normalised).
            mid_y = box["top"] + box["height"] / 2.0
            item["baseline_p1"] = {"x": box["left"], "y": mid_y}
            item["baseline_p2"] = {"x": box["left"] + box["width"], "y": mid_y}

            # Spans: word/character tokens with proportional geometry.
            item["spans"] = (
                _build_item_spans(item, gi, li, parser, lang_norm, img_w, img_h)
                if line_text else []
            )

        # Build paragraph
        para: dict[str, Any] = {
            "side": "Ai",
            "para_index": gi,
            "text": group_text,
            "valid_text": bool(group_text),
            "bubble_bounds_px": bg.get("bubble_bounds_px"),
            "bounds_px": [canvas_left, canvas_top, canvas_left + canvas_w, canvas_top + canvas_h],
            # canvas_rotation_deg: 0 for flat word-wrap block, avg_rot for
            # consistent-angle tilted/curved groups (per-item rendering).
            # Mixed-angle groups (rot_spread > 20) force flat=0 so all text
            # goes into one word-wrap div instead of the smallest angled box.
            "canvas_rotation_deg": (
                round(avg_rot, 2)
                if use_per_item_rotation and rot_spread <= 20.0
                else 0.0
            ),
            "source_para_indices": bg.get("para_indices") or [],
            # Orientation provenance — useful for debugging / the comparison
            # report.  ``is_single_set`` boxes are exempt from rotation;
            # ``rotated`` records whether this box actually changed axis.
            "is_single_set": is_single_set,
            "is_decorative_label": is_decorative_label,
            "source_direction": str(bg.get("direction") or "h"),
            "direction": direction,
            "rotated": bool(direction_change),
            "items": template_items,
        }
        para["para_font_size_px"] = fs_fixed

        out_paragraphs.append(para)

    # Assemble tree
    ai_tree: dict[str, Any] = {
        "side": "Ai",
        "paragraphs": out_paragraphs,
        "originalContentLanguage": original_tree.get("originalContentLanguage"),
        "targetLang": lang_norm,
        # Page-wide orientation decision (the 50 %-box rule).
        "orientation": {
            "image_orientation": image_orientation,
            "target_orientation": target_orientation,
            "image_rotates": image_rotates,
            "n_boxes": len(bubble_groups),
            "n_single_set": sum(
                1 for _bg in bubble_groups if is_single_set_group(_bg)
            ),
            "n_multi_set": sum(
                1 for _bg in bubble_groups if not is_single_set_group(_bg)
            ),
        },
    }
    return ai_tree
