"""Render an OCR tree as the HTML overlay the extension injects on a page.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

Layout rules (per *item*):

- **Original / Translated layers** — render every Lens item as it came back
  from Lens: one ``<div class="tp-line">`` per item, sized to its box, and
  rotated with ``transform: rotate()`` so the line follows its baseline.
  No re-orientation, no script-based magic.  These layers are *Lens-direct*;
  Lens already laid the text out correctly for each language.

- **AI layer** — same default as Original / Translated, with one CJK
  exception inspired by ``manga-image-translator``'s ``calc_vertical``:
  when a *paragraph's* translated text is dominantly CJK (Japanese /
  Chinese / Korean) the whole paragraph collapses into one
  ``<div class="tp-line vert">`` covering the bubble (the union
  ``bounds_px``).  The div uses ``writing-mode: vertical-rl`` +
  ``text-orientation: upright`` so the translation reads as a single
  vertical block — characters upright, top-to-bottom, columns flowing
  right-to-left — like a hand-set Japanese / Chinese speech bubble.
  Per-paragraph (not per-item) avoids shattering a multi-line bubble
  into several tiny vertical strips.

The browser handles fonts, kerning and shaping with whatever Thai / CJK /
Arabic / Devanagari / Hebrew / … font is installed.  No Pillow involvement.
A single :func:`overlay_css` stylesheet covers all three layers.
"""

from __future__ import annotations

import math
from typing import Any, Final

from backend.lens.tree import iter_paragraphs
from backend.render.region import (
    compute_region_geometry,
    fit_render_box,
    is_rtl,
    resolve_text_direction,
)
from backend.render.text_utils import contains_rtl

# Per-script average glyph width as a fraction of font-size — eyeballed
# averages used by the horizontal font-size fit.
_GLYPH_W_RATIO_CJK: Final[float] = 0.95
_GLYPH_W_RATIO_THAI: Final[float] = 0.55
_GLYPH_W_RATIO_LATIN: Final[float] = 0.55

# Minimum legible font size — below this the line becomes a dot.
_MIN_FONT_PX: Final[int] = 9

# Unicode ranges that count as "CJK" for the vertical-text decision.
# Covers every block Lens may return for Japanese / Chinese / Korean —
# punctuation, kana, kanji, hangul, halfwidth/fullwidth forms, and every
# CJK Extension block.
_CJK_RANGES: Final[tuple[tuple[int, int], ...]] = (
    (0x2E80, 0x2EFF),  # CJK Radicals Supplement
    (0x2F00, 0x2FDF),  # Kangxi Radicals
    (0x3000, 0x303F),  # CJK Symbols & Punctuation
    (0x3040, 0x309F),  # Hiragana
    (0x30A0, 0x30FF),  # Katakana
    (0x3100, 0x312F),  # Bopomofo
    (0x3130, 0x318F),  # Hangul Compatibility Jamo
    (0x3190, 0x319F),  # Kanbun
    (0x31A0, 0x31BF),  # Bopomofo Extended
    (0x31C0, 0x31EF),  # CJK Strokes
    (0x31F0, 0x31FF),  # Katakana Phonetic Extensions
    (0x3200, 0x32FF),  # Enclosed CJK Letters & Months
    (0x3300, 0x33FF),  # CJK Compatibility
    (0x3400, 0x4DBF),  # CJK Extension A
    (0x4E00, 0x9FFF),  # CJK Unified Ideographs
    (0xA000, 0xA48F),  # Yi Syllables
    (0xAC00, 0xD7AF),  # Hangul Syllables
    (0xF900, 0xFAFF),  # CJK Compatibility Ideographs
    (0xFE30, 0xFE4F),  # CJK Compatibility Forms
    (0xFF00, 0xFFEF),  # Halfwidth & Fullwidth Forms
    (0x20000, 0x2A6DF),  # CJK Extension B
    (0x2A700, 0x2B73F),  # CJK Extension C
    (0x2B740, 0x2B81F),  # CJK Extension D
    (0x2B820, 0x2CEAF),  # CJK Extension E
    (0x2F800, 0x2FA1F),  # CJK Compatibility Ideographs Supplement
)


def overlay_css() -> str:
    """Return the single stylesheet used by all three overlay layers.

    Visual style: classic scanlation — near-black text with a soft white
    halo + thin dark drop-shadow, so it reads cleanly on any background.
    A separate rule (``.tp-line.vert``) flips the same element to a
    vertical-rl block for AI items whose text is CJK-dominant.

    The ``font-family`` stack lists Noto Sans variants for every script
    Google Lens may return, then platform-specific fallbacks (PingFang,
    Microsoft YaHei, Hiragino, …), then ``system-ui`` so something always
    renders no matter which OS the extension runs on.
    """
    return (
        # The extension's popup +/- buttons set ``--tp-font-scale`` on the
        # ancestor ``.tp-ol-scope``; every ``.tp-line`` reads it through
        # ``calc(var(--tp-font-scale,1) * Npx)``.  CRITICAL: ``.tp-draw-root``
        # must NOT declare ``--tp-font-scale`` itself — doing so would create a
        # local custom property that SHADOWS the ancestor's value, freezing the
        # scale at 1 and making the +/- buttons do nothing.  The ``,1`` fallback
        # in every ``calc()`` already supplies the default when the variable is
        # unset (e.g. the standalone file preview, which has no extension).
        ".tp-draw-root{position:absolute;inset:0;pointer-events:none;}"
        ".tp-draw-scope{position:absolute;inset:0;width:100%;height:100%;"
        "transform-origin:0 0;}"
        # Shared text style — horizontal layout is the default.
        ".tp-line{"
        "position:absolute;"
        "display:flex;"
        "align-items:center;"
        "justify-content:center;"
        "white-space:nowrap;"
        "overflow:visible;"
        "box-sizing:border-box;"
        "transform-origin:center center;"
        "pointer-events:none;"
        "user-select:none;"
        "padding:0 .15em;"
        # Broad font stack covering every script Lens can return.
        "font-family:"
        "\"Noto Sans CJK JP\",\"Noto Sans CJK SC\","
        "\"Noto Sans CJK TC\",\"Noto Sans CJK KR\","
        "\"Noto Sans JP\",\"Noto Sans SC\",\"Noto Sans TC\",\"Noto Sans KR\","
        "\"Noto Sans Thai\",\"Noto Sans Thai UI\","
        "\"Noto Sans Arabic\",\"Noto Sans Hebrew\","
        "\"Noto Sans Devanagari\",\"Noto Sans Bengali\","
        "\"Noto Sans Tamil\",\"Noto Sans Telugu\","
        "\"Noto Sans Khmer\",\"Noto Sans Lao\",\"Noto Sans Myanmar\","
        "\"Noto Sans Georgian\",\"Noto Sans Armenian\","
        "\"Noto Sans Ethiopic\",\"Noto Sans\","
        "\"Hiragino Sans\",\"Hiragino Kaku Gothic ProN\",\"Yu Gothic\","
        "\"Microsoft YaHei\",\"Microsoft JhengHei\",\"Malgun Gothic\","
        "\"Apple SD Gothic Neo\",\"PingFang SC\",\"PingFang TC\","
        "system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\","
        "Roboto,Arial,sans-serif;"
        "font-weight:600;"
        "font-style:normal;"
        "letter-spacing:0;"
        # Ink + halo go through CSS variables so a paragraph sitting on a DARK
        # panel can flip to white-text-dark-halo via the .tp-on-dark wrapper
        # (custom properties inherit through the static wrapper div).
        "color:var(--tp-ink,rgba(15,15,15,.98));"
        "text-shadow:var(--tp-halo,"
        "0 0 2px rgba(255,255,255,.95),"
        "0 0 2px rgba(255,255,255,.95),"
        "0 0 3px rgba(255,255,255,.85),"
        "0 1px 1px rgba(0,0,0,.35));"
        "text-rendering:geometricPrecision;"
        "}"
        # --- Browser-translate dual layer (Original overlay only) ----------
        # .tp-src holds the pixel-exact per-line source divs and carries
        # translate="no" so the browser's Google Translate can NEVER touch
        # (or shift) them.  .tp-gtext is ONE hidden block per bubble holding
        # the full sentence; Google translates it as one segment.  When the
        # user runs right-click page translation, Chrome adds
        # class="translated-ltr|rtl" to <html> — pure CSS then swaps the
        # layers: source lines hide, the translated sentence block shows.
        # No translation => nothing changes on screen at all.
        ".tp-gtext{opacity:0;}"
        "html.translated-ltr .tp-src,html.translated-rtl .tp-src"
        "{visibility:hidden;}"
        "html.translated-ltr .tp-gtext,html.translated-rtl .tp-gtext"
        "{opacity:1;}"
        # Dark-background variant: white text with a dark halo. Applied per
        # paragraph by the renderer when the sampled background is dark.
        ".tp-on-dark{"
        "--tp-ink:rgba(248,248,248,.98);"
        "--tp-halo:0 0 2px rgba(0,0,0,.95),"
        "0 0 2px rgba(0,0,0,.95),"
        "0 0 3px rgba(0,0,0,.85),"
        "0 1px 1px rgba(255,255,255,.25);"
        "}"
        # Vertical CJK variant — top-to-bottom columns reading right-to-left.
        # ``writing-mode: vertical-rl`` rotates the block-flow axis so text
        # naturally fills a portrait box this way; ``text-orientation:
        # upright`` keeps every glyph standing up (no sideways characters).
        # Flex centring still works because the writing-mode flip swaps
        # which axis ``align-items`` / ``justify-content`` refer to.
        ".tp-line.vert{"
        "writing-mode:vertical-rl;"
        "text-orientation:upright;"
        "white-space:normal;"
        "padding:.15em 0;"
        "letter-spacing:0;"
        "}"
        # Bubble variant — used ONLY when the source items are vertical
        # (Japanese vertical, etc.) AND the target is a horizontal script
        # (Thai / Latin / Cyrillic / Arabic / …).  Per-item rotation would
        # leave the translation lying sideways like the source, so the
        # whole paragraph collapses into one axis-aligned div in the
        # bubble's AABB and the text wraps inside it.
        #
        # Padding is intentionally narrow (.1em) on the horizontal axis:
        # .3em at a small font size (e.g. 14 px) can consume most of the
        # box width, forcing ``overflow-wrap`` to kick in and split Thai
        # grapheme clusters mid-syllable ("ไ ม่", "ปั ง", "จ้อ ง").
        # Callers insert ZWSP at BudouX word boundaries so the browser
        # wraps on correct Thai word edges rather than at arbitrary code
        # points.  ``word-break:normal`` + ``overflow-wrap:break-word``
        # respects those ZWSP opportunities and falls back to mid-word only
        # as a last resort (not after every grapheme cluster).
        ".tp-line.bubble{"
        "white-space:normal;"
        "word-break:normal;"
        "overflow-wrap:break-word;"
        "text-align:center;"
        "padding:.2em .1em;"
        "}"
        # Right-to-left variant — Arabic / Hebrew / Persian / Urdu targets.
        # ``direction:rtl`` makes the browser apply the Unicode bidi algorithm
        # so the glyphs (already shaped/joined by the font) order correctly;
        # ``unicode-bidi:isolate`` keeps any embedded LTR run (numbers, latin
        # brand names) from leaking out and reordering the whole line.
        ".tp-line.rtl{"
        "direction:rtl;"
        "unicode-bidi:isolate;"
        "}"
    )


# --- Small helpers --------------------------------------------------------

def _num(x: Any, default: float = 0.0) -> float:
    """Coerce ``x`` to a finite float, returning ``default`` on failure."""
    try:
        n = float(x)
    except (TypeError, ValueError):
        return float(default)
    if n != n or n in (float("inf"), float("-inf")):
        return float(default)
    return n


def _escape_text(s: str) -> str:
    """HTML-escape an item's text content (strip ``\\r``, keep newlines)."""
    if not s:
        return ""
    return (
        s.replace("\r", "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _is_cjk_char(ch: str) -> bool:
    """True when ``ch`` falls inside a CJK Unicode block."""
    if not ch:
        return False
    o = ord(ch)
    for lo, hi in _CJK_RANGES:
        if lo <= o <= hi:
            return True
    return False


def _classify_text(text: str) -> str:
    """Cheap script bucket used to pick a glyph-width ratio."""
    if not text:
        return "latin"
    cjk = thai = other = 0
    for ch in text:
        if _is_cjk_char(ch):
            cjk += 1
        elif 0x0E00 <= ord(ch) <= 0x0E7F:
            thai += 1
        elif ch.isalnum():
            other += 1
    if cjk and cjk >= max(thai, other):
        return "cjk"
    if thai and thai >= other:
        return "thai"
    return "latin"


def _is_cjk_dominant(text: str, threshold: float = 0.45) -> bool:
    """True when at least ``threshold`` fraction of visible chars is CJK.

    Used by the AI renderer to decide per item whether to switch to
    vertical layout — matching ``manga-image-translator``'s per-region
    horizontal-vs-vertical decision.
    """
    if not text:
        return False
    visible = 0
    cjk = 0
    for ch in text:
        if ch.isspace():
            continue
        visible += 1
        if _is_cjk_char(ch):
            cjk += 1
    return visible > 0 and (cjk / visible) >= threshold


def _glyph_width_ratio(text: str) -> float:
    """Average glyph width (as fraction of font-size) for ``text``."""
    kind = _classify_text(text)
    if kind == "cjk":
        return _GLYPH_W_RATIO_CJK
    if kind == "thai":
        return _GLYPH_W_RATIO_THAI
    return _GLYPH_W_RATIO_LATIN


def _visible_char_count(text: str) -> int:
    """Length excluding whitespace — what width fit actually pays for."""
    if not text:
        return 0
    return sum(1 for ch in text if not ch.isspace())


def fit_item_font_size(
    box_width_pct: float,
    box_height_pct: float,
    text: str,
    img_w: int,
    img_h: int,
) -> int:
    """Pure-math font-size pick for a *horizontal* Lens item.

    Height is the hard ceiling (text taller than the line looks cramped);
    width is the soft ceiling (shrink so the line fits the box).
    """
    w_px = max(0.0, box_width_pct) / 100.0 * max(1, int(img_w))
    h_px = max(0.0, box_height_pct) / 100.0 * max(1, int(img_h))
    if h_px <= 0:
        return _MIN_FONT_PX

    fs_height = h_px * 0.85
    n = _visible_char_count(text)
    if n <= 0:
        return max(_MIN_FONT_PX, int(round(fs_height)))

    ratio = _glyph_width_ratio(text)
    fs_width = w_px / max(1.0, (n + 0.5) * ratio)
    fs = min(fs_height, fs_width)
    return max(_MIN_FONT_PX, int(round(fs)))


def fit_paragraph_font_size_horizontal(
    box_w_px: float,
    box_h_px: float,
    text: str,
) -> int:
    """Closed-form font size for *wrapped* horizontal text in a bubble AABB.

    Each glyph occupies roughly ``ratio × fs`` wide and ``fs`` tall (ratio
    0.55 for Thai / Latin / Cyrillic, 0.95 for CJK).  ``n`` chars wrapped
    across width ``w`` fill ``ceil(n·ratio·fs / w)`` lines that must fit
    height ``h``:

        fs²  ≤  w · h / (n · ratio)

    A 0.85 safety factor + a hard height ceiling keep text comfortably
    inside the bubble after CSS adds its em-based padding.  Used only by
    the source-vertical → target-horizontal path (e.g. Japanese vertical
    bubble translated to Thai); horizontal source bubbles keep the
    per-item fit so they aren't affected by this size formula.
    """
    if box_w_px <= 0 or box_h_px <= 0:
        return _MIN_FONT_PX
    n = _visible_char_count(text)
    if n <= 0:
        return max(_MIN_FONT_PX, int(round(min(box_w_px, box_h_px) * 0.85)))

    ratio = _glyph_width_ratio(text)
    fs_area = math.sqrt(box_w_px * box_h_px / max(1.0, n * ratio)) * 0.85
    # Single-line ceiling — text never grows taller than ~80% of the box.
    fs_one_line = box_h_px * 0.80
    fs = min(fs_area, fs_one_line)
    return max(_MIN_FONT_PX, int(round(fs)))


def fit_item_font_size_vertical(
    box_w_px: float,
    box_h_px: float,
    text: str,
) -> int:
    """Closed-form font size for *vertical* CJK text in an axis-aligned box.

    Each CJK glyph occupies roughly ``fs × fs`` pixels.  ``n`` chars laid
    out as vertical columns inside a ``w × h`` AABB fit when total glyph
    area is no greater than the AABB area:

        n · fs²  ≤  w · h        =>  fs ≤ sqrt(w · h / n)

    Extra ceilings:
    - One column must fit horizontally: ``fs ≤ w * 0.95``.
    - A single column shouldn't exceed the height: ``fs ≤ h * 0.95``.

    A 0.9 safety factor keeps the text comfortably inside the box.
    """
    if box_w_px <= 0 or box_h_px <= 0:
        return _MIN_FONT_PX
    n = _visible_char_count(text)
    if n <= 0:
        return max(_MIN_FONT_PX, int(round(min(box_w_px, box_h_px) * 0.85)))

    fs_area = math.sqrt(box_w_px * box_h_px / n) * 0.9
    fs_col_w = box_w_px * 0.95
    fs_one = box_h_px * 0.95
    fs = min(fs_area, fs_col_w, fs_one)
    return max(_MIN_FONT_PX, int(round(fs)))


# --- Geometry helpers ----------------------------------------------------

def _item_rotated_aabb_px(
    item: dict, img_w: int, img_h: int
) -> tuple[float, float, float, float] | None:
    """Axis-aligned bounding box (in image pixels) of an item's rotated rect.

    The item's box is stored as ``(left, top, width, height)`` of the
    unrotated rectangle plus a ``rotation_deg``.  Lens applies that rotation
    around the box's *center*, so the rectangle's four corners need to be
    rotated and then unioned to get the visual axis-aligned footprint.

    Returns ``(left, top, width, height)`` in image pixels, or ``None``
    when the item lacks valid geometry.
    """
    box = item.get("box") or {}
    w_n = _num(box.get("width"))
    h_n = _num(box.get("height"))
    if w_n <= 0 or h_n <= 0:
        return None

    center = box.get("center") or {}
    cx_n = _num(center.get("x"), _num(box.get("left")) + w_n / 2.0)
    cy_n = _num(center.get("y"), _num(box.get("top")) + h_n / 2.0)
    rot_deg = _num(box.get("rotation_deg_css"), _num(box.get("rotation_deg")))

    cx = cx_n * img_w
    cy = cy_n * img_h
    half_w = w_n * img_w / 2.0
    half_h = h_n * img_h / 2.0

    rad = math.radians(rot_deg)
    cos_a = math.cos(rad)
    sin_a = math.sin(rad)

    xs: list[float] = []
    ys: list[float] = []
    for ox, oy in ((-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)):
        xs.append(cx + ox * cos_a - oy * sin_a)
        ys.append(cy + ox * sin_a + oy * cos_a)

    left = min(xs)
    top = min(ys)
    width = max(xs) - left
    height = max(ys) - top
    if width <= 0 or height <= 0:
        return None
    return left, top, width, height


def _font_size_for_item(item: dict, img_w: int, img_h: int) -> int:
    """Pick (or read) the per-item font size for horizontal rendering."""
    fs_existing = _num(item.get("font_size_px"))
    if fs_existing >= _MIN_FONT_PX:
        return int(round(fs_existing))
    box = item.get("box") or {}
    width_pct = _num(box.get("width_pct"), _num(box.get("width")) * 100.0)
    height_pct = _num(box.get("height_pct"), _num(box.get("height")) * 100.0)
    text = str(item.get("text") or "")
    return fit_item_font_size(width_pct, height_pct, text, img_w, img_h)


def _shared_vertical_font_size(para: dict, img_w: int, img_h: int) -> int | None:
    """One font size shared by every VERTICAL item in this paragraph.

    Analog of :func:`_shared_horizontal_font_size` for paragraphs whose
    source items are vertical CJK columns: each item already carries its
    real pixel footprint in ``bounds_px``, so the per-item fit uses
    :func:`fit_item_font_size_vertical` (which derives the glyph size
    from the column's width × height area).  Averaging those gives one
    consistent size for every column in the paragraph — and, combined
    with the bubble-shared step the renderer applies on top, one size
    for every paragraph that lives inside the same speech bubble.
    """
    sizes: list[int] = []
    for item in para.get("items") or []:
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        fs_existing = _num(item.get("font_size_px"))
        if fs_existing >= _MIN_FONT_PX:
            sizes.append(int(round(fs_existing)))
            continue
        aabb = _item_rotated_aabb_px(item, img_w, img_h)
        if aabb is None:
            continue
        _, _, w_px, h_px = aabb
        sizes.append(fit_item_font_size_vertical(w_px, h_px, text))
    if not sizes:
        return None
    return max(_MIN_FONT_PX, int(round(sum(sizes) / len(sizes))))


def _shared_horizontal_font_size(para: dict, img_w: int, img_h: int) -> int | None:
    """One font size shared by every horizontal item in this paragraph.

    Each Lens *item* in a paragraph (= one bubble) has its own bounding
    box, and the per-item fit picks a different size for each — so the
    same speech bubble can end up with one line at 18px and the next at
    32px purely because Lens detected the heights slightly differently.
    Averaging the per-item fits and applying the result to every item in
    the paragraph keeps the bubble visually consistent.

    Items rely on ``overflow: visible`` (already in :func:`overlay_css`)
    when the shared size is slightly larger than the smallest box: glyphs
    spill a few px past the box rather than reflowing.
    """
    sizes: list[int] = []
    for item in para.get("items") or []:
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        fs_existing = _num(item.get("font_size_px"))
        if fs_existing >= _MIN_FONT_PX:
            sizes.append(int(round(fs_existing)))
            continue
        box = item.get("box") or {}
        width_pct = _num(box.get("width_pct"), _num(box.get("width")) * 100.0)
        height_pct = _num(box.get("height_pct"), _num(box.get("height")) * 100.0)
        sizes.append(fit_item_font_size(width_pct, height_pct, text, img_w, img_h))

    if not sizes:
        return None
    avg = sum(sizes) / len(sizes)
    return max(_MIN_FONT_PX, int(round(avg)))


# --- Main renderer --------------------------------------------------------

def _bubble_group_key(para: dict) -> tuple[float, ...] | None:
    """Hashable key for grouping paragraphs that share the same bubble.

    Two Lens paragraphs that map to the same detected bubble (e.g.
    ``"โธ่"``, ``"อีกนาน"``, ``"ไหมเนี่ย?"`` inside one speech balloon)
    get the same key.  Returns ``None`` for paragraphs without a bubble
    bounds — those form their own one-paragraph group.
    """
    bb = para.get("bubble_bounds_px")
    if not isinstance(bb, (list, tuple)) or len(bb) != 4:
        return None
    return tuple(round(float(x), 1) for x in bb)


def _para_rotation(para: dict) -> float:
    """Representative baseline rotation (degrees) for a paragraph.

    The mean of its items' ``rotation_deg``.  Note: for *near-vertical*
    text the sign of this value is unstable — a column tilting a hair
    left decodes as ``-90°`` and a hair right as ``+90°`` even inside one
    bubble — so rotation is used only to pick the *perpendicular axis*
    for :func:`_perpendicular_gap` (which is sign-insensitive), never as
    a grouping signal on its own.
    """
    rots: list[float] = []
    for it in para.get("items") or []:
        if not str(it.get("text") or "").strip():
            continue
        box = it.get("box") or {}
        rots.append(float(box.get("rotation_deg") or box.get("rotation_deg_css") or 0.0))
    return sum(rots) / len(rots) if rots else 0.0


def _para_centroid(para: dict, img_w: int, img_h: int) -> tuple[float, float] | None:
    """Mean of a paragraph's item centres, in image pixels."""
    xs: list[float] = []
    ys: list[float] = []
    for it in para.get("items") or []:
        if not str(it.get("text") or "").strip():
            continue
        box = it.get("box") or {}
        center = box.get("center") or {}
        cx = center.get("x")
        cy = center.get("y")
        if cx is None:
            cx = float(box.get("left") or 0.0) + float(box.get("width") or 0.0) / 2.0
        if cy is None:
            cy = float(box.get("top") or 0.0) + float(box.get("height") or 0.0) / 2.0
        xs.append(float(cx) * img_w)
        ys.append(float(cy) * img_h)
    if not xs:
        return None
    return (sum(xs) / len(xs), sum(ys) / len(ys))


def _para_font_px(para: dict, img_h: int) -> float:
    """Median item text-height of a paragraph, in pixels — the glyph scale.

    ``box.height`` is the text height perpendicular to the baseline for
    both horizontal and vertical items, so it is the glyph size in either
    orientation.  Used as the natural length unit when deciding whether
    two paragraphs are adjacent columns or separate bubbles.
    """
    hs: list[float] = []
    for it in para.get("items") or []:
        if not str(it.get("text") or "").strip():
            continue
        box = it.get("box") or {}
        h = float(box.get("height") or 0.0) * img_h
        if h > 1.0:
            hs.append(h)
    if not hs:
        return 0.0
    hs.sort()
    return hs[len(hs) // 2]


def _perpendicular_gap(
    c_a: tuple[float, float], c_b: tuple[float, float], rot_deg: float
) -> float:
    """Distance between two centroids measured *across* the text direction.

    For vertical text this is the inter-column gap (Δx); for horizontal
    text the inter-line gap (Δy).  Measuring across-axis isolates the
    bubble's column/line spacing from variation in column/line *length*
    — a plain Euclidean distance would be inflated when neighbouring
    columns simply have different lengths.  Sign-insensitive, so the
    unstable ±90° rotation sign doesn't matter.
    """
    r = math.radians(rot_deg)
    # The text direction is (cos r, sin r); its perpendicular is
    # (-sin r, cos r).  Project the centroid delta onto that.
    px, py = -math.sin(r), math.cos(r)
    return abs((c_b[0] - c_a[0]) * px + (c_b[1] - c_a[1]) * py)


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
    import re as _re
    from backend.lens.languages import normalize as _normalise
    from backend.render.fonts import budoux_parser as _get_parser

    if _normalise(target_lang) != "th":
        return text
    parser = _get_parser("th")
    if parser is None:
        return text

    # Process each non-whitespace run through BudouX; preserve spaces.
    out: list[str] = []
    for part in _re.split(r"(\s+)", text):
        if not part or part.isspace():
            out.append(part)
            continue
        try:
            chunks = [c for c in parser.parse(part) if c]
            out.append("​".join(chunks) if len(chunks) > 1 else part)
        except Exception:
            out.append(part)
    return "".join(out)


def _render_ai_region(
    items: list[dict],
    text: str,
    target_lang: str,
    img_w: int,
    img_h: int,
) -> str:
    """Render one AI bubble as a single ``<div>`` — deterministic, no fallback.

    The geometry comes entirely from :mod:`backend.render.region`:

    - reading direction is the *target language's* direction (a fixed
      lookup table — Thai/Latin/Cyrillic → horizontal, CJK → vertical);
    - the render box is sized by a closed-form formula from the glyph
      count and the source font size;
    - the only rotation applied is the region's *residual tilt* (the part
      of the Lens rotation that isn't the 0°/90° base orientation), so a
      vertical Japanese column doesn't get a spurious 90° CSS rotation.

    Every bubble follows this exact path — there is no branch that
    silently swaps in a different algorithm, so a test result always
    traces back here.
    """
    region = compute_region_geometry(items, img_w, img_h)
    if region is None:
        return ""

    direction = resolve_text_direction(target_lang, text)
    # Override: if the language preset says "v" (or resolved to "v" via
    # auto/CJK text detection) but the *source items were actually horizontal*
    # (rotation ≈ 0°), keep horizontal — some Japanese/Chinese panels use
    # horizontal layout and we must not rotate what the author wrote upright.
    if direction == "v" and not region.source_vertical:
        direction = "h"
    left, top, width, height, font_px = fit_render_box(
        region, text, direction, img_w, img_h
    )
    if width <= 1.0 or height <= 1.0:
        return ""

    fs = max(_MIN_FONT_PX, int(round(font_px)))
    # Horizontal text wants a little leading; vertical columns want the
    # line box equal to the glyph cell so columns sit flush.
    lh = int(round(fs * 1.15)) if direction == "h" else fs

    left_pct = left / max(1, img_w) * 100.0
    top_pct = top / max(1, img_h) * 100.0
    width_pct = width / max(1, img_w) * 100.0
    height_pct = height / max(1, img_h) * 100.0

    style_parts = [
        f"left:{left_pct:.4f}%",
        f"top:{top_pct:.4f}%",
        f"width:{width_pct:.4f}%",
        f"height:{height_pct:.4f}%",
        f"font-size:calc(var(--tp-font-scale,1) * {fs}px)",
        f"line-height:calc(var(--tp-font-scale,1) * {lh}px)",
    ]
    # Apply only the residual tilt — never the 0°/90° base orientation,
    # which is expressed through the writing-mode instead.
    if abs(region.tilt_deg) > 0.5:
        style_parts.append(f"transform:rotate({region.tilt_deg:.3f}deg)")
    style = ";".join(style_parts) + ";"

    cls = "tp-line vert" if direction == "v" else "tp-line bubble"
    if direction != "v" and is_rtl(target_lang):
        cls += " rtl"
    # For horizontal Thai output insert ZWSP at BudouX word boundaries so
    # the browser wraps on correct syllable/word edges rather than at
    # arbitrary Unicode code points (which causes "ไ ม่", "ปั ง", etc.).
    display_text = (
        _insert_thai_word_breaks(text, target_lang) if direction == "h" else text
    )
    return f'<div class="{cls}" style="{style}">{_escape_text(display_text)}</div>'


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
    directly — already computed by :func:`backend.render.tp_html.fit_item_font_size`
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
    cls = "tp-line vert" if is_vert else "tp-line bubble"
    if not is_vert and is_rtl(target_lang):
        cls += " rtl"
    display_text = _insert_thai_word_breaks(text, target_lang) if not is_vert else text
    pi = int(para.get("para_index", 0))
    return (
        f'<div class="{cls}" data-pi="{pi}" '
        f'data-fs="{fs}" style="{style}">{_escape_text(display_text)}</div>'
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
      residual tilt only.  This is the manga-image-translator model:
      direction is a language property, geometry is closed-form.

    ``target_lang`` is required for the AI layer's direction lookup; for
    Original/Translated it is ignored.

    Returns ``""`` when ``tree`` has no renderable text.
    """
    if not isinstance(tree, dict):
        return ""

    is_ai_layer = str(tree.get("side") or "").lower() == "ai"

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
        key = (_bubble_group_key(para), "v" if is_v else "h")
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
        bk = _bubble_group_key(para)
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
    # Lesson learned the hard way (see chat 20 ก.ค. 2026): Chrome's built-in
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

    for para in paragraphs_in_order:
        shared_fs = _font_for_para(para)
        chunks: list[str] = []
        for item in para.get("items") or []:
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            chunk = _render_item_horizontal(item, text, para, img_w, img_h, override_fs=shared_fs)
            if chunk:
                chunks.append(chunk)
        if not chunks:
            continue
        if is_original_layer:
            group = (
                '<div class="tp-src notranslate" translate="no">'
                + "".join(chunks)
                + "</div>"
                + _render_original_gtext_block(
                    para, img_w, img_h,
                    override_fs=shared_fs,
                    is_vertical=para_vertical[id(para)],
                )
            )
            parts.append(_wrap_on_dark(group, para))
        else:
            for c in chunks:
                parts.append(_wrap_on_dark(c, para))
        has_any = True

    parts.append("</div></div>")
    return "".join(parts) if has_any else ""


def _render_original_gtext_block(
    para: dict,
    img_w: int,
    img_h: int,
    override_fs: int | None,
    is_vertical: bool,
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
    rot = 0.0 if is_vertical else _para_rotation(para)
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
    return (
        f'<div class="{cls}" data-pi="{pi}" data-fs="{fs}" '
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


def _render_paragraph_vertical_position_based(
    para: dict,
    img_w: int,
    img_h: int,
    override_fs: int | None = None,
) -> str:
    """Render a vertical-source paragraph in Lens's per-span position style.

    Lens itself renders vertical Japanese text by emitting **one positioned
    div per word**, each at rotation 0°, with vertical reading emerging from
    shared ``left%`` values and increasing ``top%`` — never from CSS rotate.
    This function mirrors that strategy:

    * one ``<div class="tp-line">`` per span in each vertical item;
    * each span's visual rect is derived from the item's visual ``bounds_px``
      and the span's ``(t0_raw, t1_raw)`` fractional offset along the
      reading axis;
    * font size is the paragraph-shared vertical fit, applied at rotation 0°
      so the glyphs sit upright (no CSS rotate, no writing-mode flip).

    Items without spans fall back to :func:`_render_item_upright_vertical`.
    """
    parts: list[str] = []
    fs = int(override_fs) if (override_fs and override_fs >= _MIN_FONT_PX) else _MIN_FONT_PX
    pi = int(para.get("para_index", 0))

    for item in para.get("items") or []:
        item_text = str(item.get("text") or "").strip()
        if not item_text:
            continue
        bp = item.get("bounds_px")
        if isinstance(bp, (list, tuple)) and len(bp) == 4:
            ix1, iy1, ix2, iy2 = (float(v) for v in bp)
            iw, ih = ix2 - ix1, iy2 - iy1
        else:
            aabb = _item_rotated_aabb_px(item, img_w, img_h)
            if aabb is None:
                continue
            ix1, iy1, iw, ih = aabb
            ix2, iy2 = ix1 + iw, iy1 + ih
        if iw <= 0 or ih <= 0:
            continue

        spans = item.get("spans") or []
        if not spans:
            chunk = _render_item_upright_vertical(item, item_text, para, img_w, img_h, override_fs)
            if chunk:
                parts.append(chunk)
            continue

        ii = int(item.get("item_index", 0))
        for si, span in enumerate(spans):
            span_text = str(span.get("text") or "").strip()
            if not span_text:
                continue
            t0 = float(span.get("t0_raw") or 0.0)
            t1 = float(span.get("t1_raw") or 1.0)
            span_y1 = iy1 + t0 * ih
            span_y2 = iy1 + t1 * ih
            sp_w = iw
            sp_h = max(span_y2 - span_y1, fs * 1.05)
            left_pct = ix1 / max(1, img_w) * 100.0
            top_pct = span_y1 / max(1, img_h) * 100.0
            width_pct = sp_w / max(1, img_w) * 100.0
            height_pct = sp_h / max(1, img_h) * 100.0
            style = (
                f"left:{left_pct:.4f}%;"
                f"top:{top_pct:.4f}%;"
                f"width:{width_pct:.4f}%;"
                f"height:{height_pct:.4f}%;"
                f"font-size:calc(var(--tp-font-scale,1) * {fs}px);"
                f"line-height:calc(var(--tp-font-scale,1) * {fs}px);"
            )
            parts.append(
                f'<div class="tp-line" data-pi="{pi}" data-ii="{ii}" '
                f'data-si="{si}" data-fs="{fs}" data-lens="v-pos" '
                f'style="{style}">{_escape_text(span_text)}</div>'
            )

    return "".join(parts)


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
    if abs(rot) > 78.0 and _is_cjk_dominant(text):
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


def _para_bounds_px(
    para: dict, img_w: int, img_h: int
) -> tuple[float, float, float, float] | None:
    """The bubble's union bounding box in image pixels.

    Resolution order:

    1. ``para.bubble_bounds_px`` — the *real* speech-bubble outline detected
       by :mod:`backend.render.bubble` (YOLO segmentation when enabled,
       OpenCV connected components otherwise).  This is what the renderer
       wants whenever it's available, because it covers the whole bubble
       canvas rather than just the text region inside it.
    2. ``para.bounds_px`` — the union of every span's rotated quad, set by
       :func:`backend.lens.tree.decode_tree`.  Tight to the text only.
    3. Compute from the items' rotated AABBs (last-resort recovery).

    Returns ``(left, top, width, height)`` or ``None`` when no signal is
    available.
    """
    bbp = para.get("bubble_bounds_px")
    if isinstance(bbp, (list, tuple)) and len(bbp) == 4:
        l, t, r, b = (_num(x) for x in bbp)
        if r > l and b > t:
            return (l, t, r - l, b - t)

    bp = para.get("bounds_px")
    if isinstance(bp, (list, tuple)) and len(bp) == 4:
        l, t, r, b = (_num(x) for x in bp)
        if r > l and b > t:
            return (l, t, r - l, b - t)

    lefts: list[float] = []
    tops: list[float] = []
    rights: list[float] = []
    bottoms: list[float] = []
    for it in para.get("items") or []:
        aabb = _item_rotated_aabb_px(it, img_w, img_h)
        if aabb is None:
            continue
        l, t, w, h = aabb
        lefts.append(l)
        tops.append(t)
        rights.append(l + w)
        bottoms.append(t + h)
    if not lefts:
        return None
    left = min(lefts)
    top = min(tops)
    width = max(rights) - left
    height = max(bottoms) - top
    if width <= 0 or height <= 0:
        return None
    return (left, top, width, height)


def _paragraph_source_is_vertical(para: dict) -> bool:
    """True when most of the paragraph's items have a vertical baseline.

    Lens decodes each line of vertical Japanese / Chinese text as an item
    whose ``rotation_deg`` is near ±90°.  When we translate such a bubble
    into a *horizontal* target (Thai / Latin / Cyrillic / …), rendering
    per-item with the same rotation would leave the translation lying
    sideways like the source — unreadable.  This predicate gates the
    "bubble-block" path that re-orients the AI output into the bubble's
    axis-aligned footprint.

    A paragraph is considered vertical when at least half of its
    text-bearing items have ``|rotation_deg| > 78°`` (a true vertical column);
    steeply-tilted horizontal labels (≈ 60–78°) stay horizontal and keep
    their tilt.
    """
    items = para.get("items") or []
    if not items:
        return False
    n_total = n_vert = 0
    for it in items:
        text = str(it.get("text") or "").strip()
        if not text:
            continue
        n_total += 1
        rot = _num((it.get("box") or {}).get("rotation_deg"), 0.0)
        if abs(rot) > 78.0:
            n_vert += 1
    return n_total > 0 and (n_vert / n_total) >= 0.5


def _render_paragraph_horizontal_block(
    para: dict, para_text: str, img_w: int, img_h: int
) -> str:
    """One horizontal ``<div class="tp-line bubble">`` covering the whole bubble.

    Used only when the source items were vertical and the AI target is
    a horizontal script.  The paragraph's union ``bounds_px`` (already
    rotated-quad-aware in :func:`backend.lens.tree.decode_tree`) is the
    canvas; CSS lets the text wrap naturally inside it
    (``white-space: normal; word-break: break-word``).  No CSS rotation
    is applied — characters stay upright while the source bubble's
    portrait AABB hosts the wrapped translation.
    """
    bounds = _para_bounds_px(para, img_w, img_h)
    if bounds is None:
        return ""

    left_px, top_px, width_px, height_px = bounds
    if width_px <= 0 or height_px <= 0:
        return ""

    fs = fit_paragraph_font_size_horizontal(width_px, height_px, para_text)

    left_pct = left_px / max(1, img_w) * 100.0
    top_pct = top_px / max(1, img_h) * 100.0
    width_pct = width_px / max(1, img_w) * 100.0
    height_pct = height_px / max(1, img_h) * 100.0
    pi = int(para.get("para_index", 0))

    style = (
        f"left:{left_pct:.4f}%;"
        f"top:{top_pct:.4f}%;"
        f"width:{width_pct:.4f}%;"
        f"height:{height_pct:.4f}%;"
        # No transform: rotate — text reads horizontally inside the AABB.
        f"font-size:calc(var(--tp-font-scale,1) * {fs}px);"
        f"line-height:calc(var(--tp-font-scale,1) * {int(round(fs * 1.15))}px);"
    )
    return (
        f'<div class="tp-line bubble" data-pi="{pi}" '
        f'data-fs="{fs}" '
        f'style="{style}">{_escape_text(para_text)}</div>'
    )


def _render_paragraph_vertical(
    para: dict, para_text: str, img_w: int, img_h: int
) -> str:
    """One vertical ``<div class="tp-line vert">`` covering the whole bubble.

    Uses ``para.bounds_px`` (the union of every item's footprint in the
    paragraph) as the canvas, so all the lines from a multi-line source
    bubble collapse into a single vertical text block — matching how
    manga-image-translator renders a translated bubble.  No CSS rotation
    is applied; ``writing-mode: vertical-rl`` + ``text-orientation:
    upright`` keep glyphs standing top-to-bottom in columns that flow
    right-to-left.
    """
    bounds = _para_bounds_px(para, img_w, img_h)
    if bounds is None:
        return ""

    left_px, top_px, width_px, height_px = bounds
    if width_px <= 0 or height_px <= 0:
        return ""

    fs = fit_item_font_size_vertical(width_px, height_px, para_text)

    left_pct = left_px / max(1, img_w) * 100.0
    top_pct = top_px / max(1, img_h) * 100.0
    width_pct = width_px / max(1, img_w) * 100.0
    height_pct = height_px / max(1, img_h) * 100.0
    pi = int(para.get("para_index", 0))

    style = (
        f"left:{left_pct:.4f}%;"
        f"top:{top_pct:.4f}%;"
        f"width:{width_pct:.4f}%;"
        f"height:{height_pct:.4f}%;"
        # No transform: rotate — the bubble's AABB is axis-aligned and the
        # CSS class flips writing-mode so columns stack right-to-left
        # with upright characters.  font-size goes through the same
        # --tp-font-scale CSS variable that horizontal items use, so the
        # extension's +/- buttons scale both layouts together.
        f"font-size:calc(var(--tp-font-scale,1) * {fs}px);"
        f"line-height:calc(var(--tp-font-scale,1) * {fs}px);"
    )
    return (
        f'<div class="tp-line vert" data-pi="{pi}" '
        f'data-fs="{fs}" '
        f'style="{style}">{_escape_text(para_text)}</div>'
    )


# --- Compatibility shims --------------------------------------------------
# Older callers may still import these names; route them all into the
# unified renderer / single CSS payload.

def ai_tree_to_tp_html(
    tree: dict | None,
    img_w: int,
    img_h: int,
    _thai_font: str = "",
    _latin_font: str = "",
) -> str:
    """Shim: AI layer uses the unified renderer."""
    return render_tree_overlay(tree, img_w, img_h)


def lens_tree_to_lens_html(tree: dict | None) -> str:
    """Shim: Original/Translated also share the unified renderer."""
    return render_tree_overlay(tree, 1000, 1000)


def tp_overlay_css() -> str:
    """Shim: single CSS payload."""
    return overlay_css()


def lens_overlay_css(*_args: Any, **_kwargs: Any) -> str:
    """Shim: single CSS payload."""
    return overlay_css()


def fit_tree_font_sizes(
    tree: dict | None,
    _thai_path: str,
    _latin_path: str,
    img_w: int,
    img_h: int,
) -> dict[int, int]:
    """Attach a starting font_size_px to every item using the heuristic.

    Useful when callers want a paragraph-size map; the renderer also picks
    sizes itself if missing.
    """
    if not isinstance(tree, dict):
        return {}
    sizes: dict[int, int] = {}
    for _, p in iter_paragraphs(tree):
        per_item: list[int] = []
        for it in p.get("items") or []:
            text = str(it.get("text") or "").strip()
            if not text:
                continue
            box = it.get("box") or {}
            width_pct = _num(box.get("width_pct"), _num(box.get("width")) * 100.0)
            height_pct = _num(box.get("height_pct"), _num(box.get("height")) * 100.0)
            fs = fit_item_font_size(width_pct, height_pct, text, img_w, img_h)
            it["font_size_px"] = int(fs)
            per_item.append(int(fs))
        if per_item:
            shared = sorted(per_item)[len(per_item) // 2]
            p["para_font_size_px"] = int(shared)
            sizes[int(p.get("para_index", 0))] = int(shared)
    return sizes


def apply_para_font_size(
    _tree: dict | None,
    _para_sizes: dict[int, int],
) -> None:
    """No-op: kept for backward compatibility."""
    return None


def compute_shared_para_sizes(
    _tree: dict | None,
    _thai_path: str,
    _latin_path: str,
    _img_w: int,
    _img_h: int,
) -> dict[int, int]:
    """No-op: returns an empty map; renderer picks sizes."""
    return {}
