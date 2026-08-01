"""Paragraph-to-bubble grouping for TextPhantom render trees.

STATUS: ACTIVE — in use in the current flow.

Turns the flat tree["paragraphs"] list (one entry per Lens OCR paragraph)
into tree["bubble_groups"], where each entry is one renderable speech-bubble
region. Paragraphs that share a reading axis and are spatially adjacent across
that axis are merged (union-find) into one bubble = one translation unit, so a
multi-column vertical sentence becomes a single group that can be laid out
horizontally for a horizontal target language. No words are dropped.
"""

from __future__ import annotations

import math
import unicodedata
from typing import Any

from backend.render.region import classify_item_axis, paragraph_reading_axis


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_SPATIAL_THRESHOLD: float = 3.0
_CJK_THRESHOLD: float = 0.45


# ---------------------------------------------------------------------------
# Internal geometry helpers
# ---------------------------------------------------------------------------

def _is_cjk(ch: str) -> bool:
    """True for CJK ideographs, Kana, Hangul, and fullwidth punctuation."""
    cp = ord(ch)
    return (
        0x3000 <= cp <= 0x9FFF
        or 0xAC00 <= cp <= 0xD7FF
        or 0xF900 <= cp <= 0xFAFF
        or 0xFF00 <= cp <= 0xFFEF
        or (unicodedata.category(ch) in ("Lo",) and "一" <= ch <= "鿿")
    )


def _is_cjk_dominant(text: str) -> bool:
    """True when CJK characters make up at least _CJK_THRESHOLD of the text."""
    if not text:
        return False
    cjk = sum(1 for ch in text if _is_cjk(ch))
    return cjk / len(text) >= _CJK_THRESHOLD


def _para_full_text(para: dict) -> str:
    """Return the paragraph's best available display text."""
    text = str(para.get("text") or "").strip()
    if text:
        return text
    parts = []
    for it in para.get("items") or []:
        t = str(it.get("text") or "").strip()
        if t:
            parts.append(t)
    return " ".join(parts).strip()


def _bubble_key(para: dict) -> tuple[float, ...] | None:
    """Hashable key for bubble_bounds_px; None if absent."""
    bb = para.get("bubble_bounds_px")
    if not isinstance(bb, (list, tuple)) or len(bb) != 4:
        return None
    return tuple(round(float(x), 1) for x in bb)


def _para_rotation(para: dict) -> float:
    """Mean baseline rotation across the paragraph's items (degrees)."""
    rots: list[float] = []
    for it in para.get("items") or []:
        if not str(it.get("text") or "").strip():
            continue
        box = it.get("box") or {}
        r = float(box.get("rotation_deg") or box.get("rotation_deg_css") or 0.0)
        rots.append(r)
    return sum(rots) / len(rots) if rots else 0.0


def _para_centroid(
    para: dict, img_w: int, img_h: int
) -> tuple[float, float] | None:
    """Mean of item centres in image pixels."""
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
    """Median item text-height in pixels (= glyph scale for the paragraph)."""
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
    c_a: tuple[float, float],
    c_b: tuple[float, float],
    rot_deg: float,
) -> float:
    """Centroid distance measured across the text direction."""
    r = math.radians(rot_deg)
    px, py = -math.sin(r), math.cos(r)
    return abs((c_b[0] - c_a[0]) * px + (c_b[1] - c_a[1]) * py)


def _is_portrait_item(item: dict) -> bool:
    """True when bounds_px is portrait-oriented (height > 2x width)."""
    bpx = item.get("bounds_px")
    if not isinstance(bpx, (list, tuple)) or len(bpx) != 4:
        return False
    w = float(bpx[2]) - float(bpx[0])
    h = float(bpx[3]) - float(bpx[1])
    return w > 0 and h > 2.0 * w


def _median_font_px(paras: list[dict], img_h: int) -> int:
    """Median of all item font heights across a group of paragraphs."""
    sizes: list[float] = []
    for p in paras:
        for it in p.get("items") or []:
            fs = it.get("font_size_px")
            if fs and int(fs) >= 6:
                sizes.append(float(fs))
                continue
            box = it.get("box") or {}
            h = float(box.get("height") or 0.0) * img_h
            if h > 1.0:
                sizes.append(h)
    if not sizes:
        return 14
    sizes.sort()
    return max(6, int(round(sizes[len(sizes) // 2])))


# ---------------------------------------------------------------------------
# Furigana (ruby) detection \u2014 for AI TEXT ONLY (never removes from the tree)
# ---------------------------------------------------------------------------

_RUBY_STRIP = "\u3002\u3001\uff65\u30fb\u2026\uff01!\uff1f?\u30fc\u2015\u301c~\uff08\uff09()\u300c\u300d\u300e\u300f \u3000\t\r\n"


def _is_kana_only_reading(text: str, max_len: int = 8) -> bool:
    """True when text is a short run made only of kana (a ruby reading).

    Ruby (furigana) is the kana pronunciation printed beside a kanji: short
    and never containing kanji / digits / latin.  Real kana dialogue is
    excluded later by the spatial test (it has no taller kanji column hugging
    it), so this is only a *candidate* gate.
    """
    core = [c for c in text if c not in _RUBY_STRIP]
    if not (1 <= len(core) <= max_len):
        return False
    return all(0x3040 <= ord(c) <= 0x30FF for c in core)


def _has_kanji(text: str) -> bool:
    return any(0x3400 <= ord(c) <= 0x9FFF for c in text)


# A reading is set at roughly half the size of the character it annotates, so a
# base run must be clearly bigger before a neighbour counts as its ruby. Same
# figure as the paragraph-level test, which compares glyph heights.
_RUBY_MIN_BASE_RATIO: float = 1.6


def _item_font_px(item: dict, img_h: int) -> float:
    """Glyph height of one item in pixels.

    A rotated item's ``box`` is stored unrotated, so ``height`` is the glyph
    size for vertical columns as well as horizontal lines. ``font_size_px`` is
    preferred when the decoder supplied it.
    """
    fs = item.get("font_size_px")
    if fs:
        try:
            if float(fs) > 1.0:
                return float(fs)
        except (TypeError, ValueError):
            pass
    box = item.get("box") or {}
    return float(box.get("height") or 0.0) * img_h


def _ruby_item_indices(items: list[dict], img_h: int) -> set[int]:
    """Indices of ruby ITEMS inside one vertical paragraph.

    Lens does not always give a reading its own paragraph — inside a vertical
    column it commonly arrives as extra *items* of the same paragraph. That
    makes ``para["text"]`` the reading glued to the run it annotates
    ("なにせんぱい何先輩"), which is not readable Japanese. Handed to a
    translator, source language detection fails on it and the result comes back
    as kana noise, which reads as "it translated Japanese into Japanese". The
    paragraph-level test cannot see this: there is only one paragraph.

    An item is ruby when it is a short pure-kana reading AND a markedly larger
    kanji-bearing item in the same paragraph sits BESIDE it — a parallel column
    (x-ranges apart, y-ranges overlapping), which is where furigana is set in
    vertical typesetting. Real kana dialogue has no such larger neighbour
    hugging it, so it survives.
    """
    info: list[tuple[int, str, list[float], float, bool]] = []
    for idx, it in enumerate(items):
        text = str(it.get("text") or "").strip()
        bp = it.get("bounds_px")
        if not text or not isinstance(bp, (list, tuple)) or len(bp) != 4:
            continue
        rect = [float(v) for v in bp]
        if rect[2] <= rect[0] or rect[3] <= rect[1]:
            continue
        info.append(
            (idx, text, rect, _item_font_px(it, img_h), _has_kanji(text))
        )

    ruby: set[int] = set()
    for idx, text, rect, font, _kanji in info:
        if font <= 0 or not _is_kana_only_reading(text):
            continue
        x1, y1, x2, y2 = rect
        width = max(1.0, x2 - x1)
        length = max(1.0, y2 - y1)
        for jdx, _jtext, jrect, jfont, jkanji in info:
            if jdx == idx or not jkanji:
                continue
            if jfont < _RUBY_MIN_BASE_RATIO * font:
                continue
            jx1, jy1, jx2, jy2 = jrect
            span = max(0.0, min(y2, jy2) - max(y1, jy1)) / length
            gap = max(jx1 - x2, x1 - jx2, 0.0)
            if span >= 0.4 and gap <= 1.6 * width:
                ruby.add(idx)
                break
    return ruby


def _para_text_without_ruby(para: dict, img_h: int) -> tuple[str, int]:
    """The paragraph's text with ruby items removed, and how many were removed.

    Returns ``para["text"]`` untouched when no ruby is found, so a paragraph
    without readings produces exactly the same string as before.
    """
    items = [
        it for it in (para.get("items") or [])
        if str(it.get("text") or "").strip()
    ]
    if len(items) < 2:
        return _para_full_text(para), 0
    ruby = _ruby_item_indices(items, img_h)
    if not ruby:
        return _para_full_text(para), 0
    kept = [
        str(it.get("text") or "").strip()
        for i, it in enumerate(items)
        if i not in ruby
    ]
    if not kept:
        return _para_full_text(para), 0
    sep = "" if _is_cjk_dominant("".join(kept)) else " "
    return sep.join(kept).strip(), len(ruby)


def _ruby_para_indices(paras: list[dict], img_h: int) -> set[int]:
    """Indices (into paras) of ruby paragraphs inside one vertical group.

    A paragraph is ruby when it is a short pure-kana reading AND a clearly
    taller kanji-bearing paragraph in the same group sits beside it (its base
    column).  Used ONLY to keep ruby out of the AI translation text \u2014 the
    paragraphs themselves stay in the tree, so original / translated rendering
    is untouched.
    """
    info = []
    for idx, p in enumerate(paras):
        bb = _para_xyxy(p)
        if bb is None:
            continue
        info.append((idx, p, bb, _para_font_px(p, img_h), _has_kanji(_para_full_text(p))))
    ruby: set[int] = set()
    for idx, p, bb, h, _kanji in info:
        if h <= 0 or not _is_kana_only_reading(_para_full_text(p)):
            continue
        x1, y1, x2, y2 = bb
        ph = y2 - y1
        for jdx, q, qb, qh, qk in info:
            if jdx == idx or qh < 1.6 * h or not qk:
                continue
            qx1, qy1, qx2, qy2 = qb
            span = max(0.0, min(y2, qy2) - max(y1, qy1)) / max(1.0, ph)
            gap = max(qx1 - x2, x1 - qx2, 0.0)
            near = gap <= 1.6 * (x2 - x1)
            if span >= 0.4 and near:
                ruby.add(idx)
                break
    return ruby


# ---------------------------------------------------------------------------
# Bubble merging (union-find by axis + proximity)
# ---------------------------------------------------------------------------

def _para_xyxy(para: dict) -> tuple[float, float, float, float] | None:
    """Paragraph bounds_px as (x1, y1, x2, y2) in pixels."""
    bp = para.get("bounds_px")
    if isinstance(bp, (list, tuple)) and len(bp) == 4:
        x1, y1, x2, y2 = (float(v) for v in bp)
        if x2 > x1 and y2 > y1:
            return (x1, y1, x2, y2)
    return None


def _para_axis(para: dict) -> str:
    """Reading axis of a paragraph: "h", "v" or "tilted"."""
    return paragraph_reading_axis(para.get("items") or [])


def _trusted_blob_key(para: dict) -> tuple[float, ...] | None:
    """``_bubble_key`` but only when the blob actually covers the text.

    Bubble detection sometimes returns a degenerate blob (smaller than the
    paragraph's own text bounds, or barely touching them).  Such a blob is
    NOT evidence of bubble membership and must not veto a merge — verified
    against the debug-jp2th example set, where a degenerate blob on one
    column of 「俺の前で / 君のその才能は」 wrongly split the sentence.
    The blob is trusted only when it covers ≥ 50 % of the paragraph bounds.
    """
    key = _bubble_key(para)
    if key is None:
        return None
    bb = para.get("bubble_bounds_px")
    bp = _para_xyxy(para)
    if bp is None:
        return None
    bx1, by1, bx2, by2 = (float(v) for v in bb)
    px1, py1, px2, py2 = bp
    ix = max(0.0, min(bx2, px2) - max(bx1, px1))
    iy = max(0.0, min(by2, py2) - max(by1, py1))
    area_p = max(1.0, (px2 - px1) * (py2 - py1))
    if (ix * iy) / area_p < 0.5:
        return None
    return key


def _is_strict_vertical(para: dict, require_cjk: bool = True) -> bool:
    """True when a paragraph is *unambiguously* a vertical column set.

    Merging exists for exactly one reason: Lens splits ONE vertical sentence
    into per-column paragraphs.  Everything else must keep the Lens paragraph
    as-is (the user's layout spec treats ``paragraphs`` as the source of
    truth).  So a merge candidate must be:

    1. majority-vertical by item rotation (``paragraph_reading_axis``), AND
    2. CJK-dominant text — see ``require_cjk`` below, AND
    3. not just rotation noise: a single-item paragraph only counts when its
       pixel bounds are clearly portrait (height > 2x width).  This blocks the
       axis-vote tie (n_v >= n_h) from sweeping a lone horizontal word whose
       angle Lens misreported into the vertical merge path.

    ``require_cjk`` exists because rule 2 reads the SCRIPT to infer the
    TYPESETTING, and that inference is wrong for the Lens "translated" tree: its
    paragraphs carry Thai/English text laid out in the *source's* vertical
    Japanese columns, so every column failed the CJK test and nothing ever
    merged — the translated layer came back as one group per column, each
    relaid out inside a single-column strip.  The geometry is the same on both
    trees; only the script changed.  So callers that have stronger evidence of
    the region (the trained text-block detector) pass ``require_cjk=False`` and
    let geometry plus the detected block decide.
    """
    if _para_axis(para) != "v":
        return False
    if require_cjk and not _is_cjk_dominant(_para_full_text(para)):
        return False
    items = [it for it in (para.get("items") or []) if str(it.get("text") or "").strip()]
    if len(items) >= 2:
        return True
    return bool(items) and _is_portrait_item(items[0])


def _ink_barrier_between(
    base_img: Any,
    ra: tuple[float, float, float, float],
    rb: tuple[float, float, float, float],
) -> bool:
    """True when a drawn line (bubble wall) separates two column rects.

    Vertical sources have no reliable Lens paragraph grouping, so geometry
    alone must decide which columns belong together — and two DIFFERENT
    bubbles drawn close to each other can pass every distance gate.  The
    erased image gives direct evidence: between columns of ONE sentence the
    strip is clean bubble interior, while between two bubbles the wall(s)
    cross it.  A barrier = some pixel column in the gap strip that is dark
    for >= 60 % of the shared vertical span (validated on the debug set:
    real walls score ~0.68, in-bubble strips <= 0.35).
    """
    if base_img is None:
        return False
    try:
        left = min(ra[2], rb[2])
        right = max(ra[0], rb[0])
        if right - left < 2:
            return False  # boxes overlap in x — no strip to inspect
        y1 = max(ra[1], rb[1])
        y2 = min(ra[3], rb[3])
        if y2 - y1 < 8:
            return False
        crop = base_img.convert("L").crop((int(left), int(y1), int(right), int(y2)))
        w, h = crop.size
        if w < 1 or h < 8:
            return False
        px = list(crop.getdata())
        for x in range(w):
            col = px[x::w]
            if sum(1 for v in col if v < 96) >= 0.6 * len(col):
                return True
        return False
    except Exception:
        return False  # image evidence is optional — never break grouping


def _should_merge(
    a: dict, b: dict, img_h: int, base_img: Any = None, tb_authority: bool = False
) -> bool:
    """True when paragraphs a and b belong to one bubble/reading unit.

    Grouping rules (user layout spec §5 / §7 / §14 — Lens ``paragraphs`` are
    the authoritative groups; merging exists ONLY to re-join the columns of
    one vertical sentence):

    * HORIZONTAL paragraphs never merge.  ``_is_strict_vertical`` also keeps
      rotation-noise / tie-vote paragraphs out of the merge path, so h→h
      groups can no longer be absorbed into a neighbour.
    * OpenCV bubble evidence is binding in BOTH directions:
        - different detected bubbles  → NEVER merge (it used to merely
          tighten the distance gate — adjacent bubbles in one panel were
          still being glued together);
        - same detected bubble        → merge generously.
    * Without shared-blob evidence the geometry must look like columns of
      ONE sentence: large overlap along the column axis (≥ 55 %), a narrow
      inter-column gap (≤ 1.3 glyph), and a similar glyph size (≤ 1.5x).
      Real neighbouring bubbles fail at least one of these.
    Every threshold scales with glyph size — resolution-independent.
    """
    # Under model authority the detected block carries the region evidence, so
    # the CJK-script gate is dropped: it would otherwise veto every column of
    # the Lens "translated" tree, whose text is already Thai/English but whose
    # columns are still the source's vertical Japanese typesetting.
    require_cjk = not tb_authority
    if not _is_strict_vertical(a, require_cjk) or not _is_strict_vertical(
        b, require_cjk
    ):
        return False
    ra, rb = _para_xyxy(a), _para_xyxy(b)
    if ra is None or rb is None:
        return False

    # MODEL-AUTHORITY MODE: when the trained text-block detector ran for this
    # image, it is the ONLY decision maker for vertical grouping — merge iff
    # both columns belong to the same detected block. No geometric rule may
    # override it (mixed decision paths made debugging impossible: you could
    # never tell WHICH rule produced a bad group).
    if tb_authority:
        ta, tb = a.get("_tb_block"), b.get("_tb_block")
        return ta is not None and ta == tb

    ka, kb = _trusted_blob_key(a), _trusted_blob_key(b)
    if ka is not None and kb is not None and ka != kb:
        return False  # OpenCV says these are different bubbles — binding.
    same_blob = ka is not None and ka == kb

    fa, fb = _para_font_px(a, img_h), _para_font_px(b, img_h)
    glyph = max(fa, fb, 1.0)
    if min(fa, fb) > 0:
        ratio = max(fa, fb) / max(1.0, min(fa, fb))
        if ratio > (1.8 if same_blob else 1.5):
            return False  # different glyph scale = different speech units

    ax1, ay1, ax2, ay2 = ra
    bx1, by1, bx2, by2 = rb
    gap = max(0.0, max(ax1, bx1) - min(ax2, bx2))
    overlap = max(0.0, min(ay2, by2) - max(ay1, by1))
    denom = min(ay2 - ay1, by2 - by1)
    overlap_ratio = overlap / denom if denom > 0 else 0.0

    if same_blob:
        return gap <= 3.5 * glyph and overlap_ratio >= 0.30
    if not (gap <= 1.3 * glyph and overlap_ratio >= 0.55):
        return False
    # Final veto from the image itself: a bubble wall in the gap strip means
    # these columns belong to two different bubbles, however close they sit.
    return not _ink_barrier_between(base_img, ra, rb)


def _split_vertical_run_at_gap_jumps(
    run: list[dict], img_h: int, tb_authority: bool = False
) -> list[list[dict]]:
    """Split one vertical run (= one detected text region) into TEXT SETS.

    One bubble/box often carries more than one utterance, and Lens cannot
    mark vertical sets the way it marks horizontal paragraphs.  Two
    typesetting signals mark a set boundary (both validated on the debug
    set):

    1. COLUMN-GAP JUMP — columns of one sentence sit at near-constant pitch
       (measured 0.14-0.55 glyph apart); a new set starts at >= ~1.5 glyph.
       Threshold: gap > 1.2 glyph.
    2. TOP-EDGE JUMP — columns of one sentence are top-aligned almost
       perfectly (measured deviation <= 0.21 glyph), while a new utterance
       often starts visibly lower/higher (e.g. the offset second set in a
       round bubble).  The jump is measured against the run's own MEDIAN
       top-delta, so uniformly staircased cover layouts (constant drift)
       are not falsely split.  Threshold: |delta - median| > 0.8 glyph.

    Under ``tb_authority`` rule 2 is DISABLED.  The top-edge signal is a guess
    about intent from a few pixels of vertical jitter, and when the detector has
    already ruled that these columns are one region that guess is the weaker
    evidence — letting it win is how a five-column bubble came back out as five
    separate groups.  The hard column-gap rule still applies, because a wide
    band of whitespace is unambiguous at any resolution.

    ``run`` must already be in reading order (columns right-to-left).
    """
    if len(run) < 2:
        return [run]
    rects = [_para_xyxy(p) for p in run]
    if any(r is None for r in rects):
        return [run]
    glyph = max(max((_para_font_px(p, img_h) for p in run), default=0.0), 1.0)

    deltas = [rects[i][1] - rects[i - 1][1] for i in range(1, len(run))]
    sorted_d = sorted(deltas)
    median_delta = sorted_d[len(sorted_d) // 2] if len(sorted_d) >= 2 else 0.0

    out: list[list[dict]] = []
    cur: list[dict] = [run[0]]
    for i in range(1, len(run)):
        prev, now = rects[i - 1], rects[i]
        # prev is the column to the RIGHT (reading order); gap = horizontal
        # whitespace between it and the next column to the left.
        gap = max(0.0, prev[0] - now[2])
        top_jump = 0.0 if tb_authority else abs(deltas[i - 1] - median_delta)
        if gap > 1.2 * glyph or top_jump > 0.8 * glyph:
            out.append(cur)
            cur = [run[i]]
        else:
            cur.append(run[i])
    out.append(cur)
    return out


def _merge_paragraphs(
    ordered: list[dict],
    img_w: int,
    img_h: int,
    base_img: Any = None,
    tb_authority: bool = False,
) -> list[list[dict]]:
    """Cluster paragraphs into bubble runs via union-find on _should_merge.

    Each run is sorted into reading order (vertical -> columns right-to-left
    then top-to-bottom; horizontal -> lines top-to-bottom then left-to-right).
    ``tb_authority=True`` means the trained text-block model decides all
    vertical grouping (runs == its blocks, no gap-splitting); otherwise the
    geometric fallback rules apply, including the gap-jump set splitter.
    """
    n = len(ordered)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[max(ri, rj)] = min(ri, rj)

    for i in range(n):
        for j in range(i + 1, n):
            if _should_merge(ordered[i], ordered[j], img_h, base_img, tb_authority):
                union(i, j)

    clusters: dict[int, list[dict]] = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(ordered[i])

    runs: list[list[dict]] = []
    for members in clusters.values():
        axis = paragraph_reading_axis(
            [it for p in members for it in (p.get("items") or [])]
        )

        def _key(p: dict, _axis: str = axis) -> tuple[float, float]:
            c = _para_centroid(p, img_w, img_h) or (0.0, 0.0)
            if _axis == "v":
                return (-c[0], c[1])
            return (c[1], c[0])

        ordered_members = sorted(members, key=_key)
        if axis == "v" and len(ordered_members) > 1:
            # Two-level contract: the model (or geometric merge) decides the
            # REGION a column belongs to; this splitter then divides each
            # region into TEXT SETS. The detector's blocks are bubble/region
            # granularity — a region holding two utterances must still split,
            # under model authority as well.
            runs.extend(
                _split_vertical_run_at_gap_jumps(
                    ordered_members, img_h, tb_authority
                )
            )
        else:
            runs.append(ordered_members)

    runs.sort(key=lambda r: (
        (_para_centroid(r[0], img_w, img_h) or (0.0, 0.0))[1],
        (_para_centroid(r[0], img_w, img_h) or (0.0, 0.0))[0],
    ))
    return runs


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def direction_is_vertical_hint(paras: list[dict]) -> bool:
    """True when the run reads vertically (so ruby detection is meaningful)."""
    items = [it for p in paras for it in (p.get("items") or [])]
    return paragraph_reading_axis(items) == "v"


def group_paragraphs_into_bubbles(
    tree: dict[str, Any],
    img_w: int,
    img_h: int,
    base_img: Any = None,
    tb_authority: bool = False,
) -> list[dict[str, Any]]:
    """Compute tree["bubble_groups"] in-place and return it.

    Safe to call multiple times. Skips paragraphs with no display text.
    ``tb_authority=True`` = the trained text-block model is the sole decision
    maker for vertical grouping (paragraphs carry ``_tb_block`` annotations).
    ``base_img`` (optional, PIL image — ideally the ERASED page) enables the
    ink-barrier veto used by the geometric fallback.
    """
    paragraphs: list[dict] = tree.get("paragraphs") or []

    ordered = sorted(
        [p for p in paragraphs if _para_full_text(p)],
        key=lambda p: int(p.get("para_index", 0)),
    )

    # Merge paragraphs into bubble runs (one run = one bubble = one unit).
    runs: list[list[dict]] = _merge_paragraphs(
        ordered, img_w, img_h, base_img, tb_authority
    )

    bubble_groups = [
        _build_group(i, paras, img_w, img_h) for i, paras in enumerate(runs)
    ]

    tree["bubble_groups"] = bubble_groups
    return bubble_groups


def _build_group(
    bubble_index: int, paras: list[dict], img_w: int, img_h: int
) -> dict[str, Any]:
    """Derive one bubble_groups entry from the paragraphs of one run.

    Extracted so a later pass (``merge_groups_sharing_canvas``) can rebuild a
    group from a different paragraph set without duplicating any of the field
    derivation — text assembly, ruby stripping, direction and rotation must
    stay defined in exactly one place.
    """
    items: list[dict] = []
    for p in paras:
        items.extend(p.get("items") or [])

    # Combined text for translation \u2014 the AI model and the browser both read
    # this one string.  Ruby (furigana) is excluded HERE ONLY; the readings stay
    # untouched in tree["paragraphs"], so original / translated rendering still
    # shows every word.
    #
    # Ruby has to be removed at BOTH granularities Lens produces it at:
    #   * whole paragraphs beside a base column, and
    #   * extra items inside one column's paragraph.
    # Missing the second case leaves the reading glued to what it annotates
    # ("\u306a\u306b\u305b\u3093\u3071\u3044\u4f55\u5148\u8f29"), which is not readable Japanese \u2014 the translator
    # then returns kana noise, and the page looks like it was translated into
    # its own language.
    is_vertical_run = direction_is_vertical_hint(paras)
    ruby_idx = _ruby_para_indices(paras, img_h) if is_vertical_run else set()
    kept = [p for i, p in enumerate(paras) if i not in ruby_idx]
    if not kept:
        kept = list(paras)

    ruby_items = 0
    fragments: list[str] = []
    for p in kept:
        if is_vertical_run:
            frag, dropped = _para_text_without_ruby(p, img_h)
            ruby_items += dropped
        else:
            frag = _para_full_text(p)
        if frag:
            fragments.append(frag)
    sep = "" if _is_cjk_dominant("".join(fragments)) else " "
    text = sep.join(fragments).strip()
    # Full text (every word incl. ruby) kept for debugging / provenance.
    all_fragments = [t for t in (_para_full_text(p) for p in paras) if t]
    text_full = sep.join(all_fragments).strip()

    text_items = [it for it in items if str(it.get("text") or "").strip()]
    item_rots = [
        float((it.get("box") or {}).get("rotation_deg")
               or (it.get("box") or {}).get("rotation_deg_css") or 0.0)
        for it in text_items
    ]
    med_abs_rot = (
        sorted(abs(r) for r in item_rots)[len(item_rots) // 2]
        if item_rots else 0.0
    )

    # Direction: vertical when item boxes are portrait OR baselines are
    # near-vertical (|rot| ~ 90, cut-off 78 so tilted labels stay h).
    n_portrait = sum(1 for it in text_items if _is_portrait_item(it))
    is_vertical = (
        n_portrait > max(1, len(text_items)) / 2 or med_abs_rot > 78.0
    )
    direction = "v" if is_vertical else "h"

    # Representative rotation: sign-normalized magnitude for vertical
    # (avoids +/-90 cancellation); signed mean for tilted/horizontal.
    if not item_rots:
        avg_rot = 0.0
    elif is_vertical:
        sign = 1.0 if sum(item_rots) >= 0 else -1.0
        avg_rot = sign * med_abs_rot
    else:
        avg_rot = sum(item_rots) / len(item_rots)

    font_size_px = _median_font_px(paras, img_h)

    # Merged bubble bounds = union of members' blobs.
    member_blobs = [
        p.get("bubble_bounds_px") for p in paras
        if isinstance(p.get("bubble_bounds_px"), (list, tuple))
        and len(p.get("bubble_bounds_px")) == 4
    ]
    if member_blobs:
        union_blob = [
            min(float(b[0]) for b in member_blobs),
            min(float(b[1]) for b in member_blobs),
            max(float(b[2]) for b in member_blobs),
            max(float(b[3]) for b in member_blobs),
        ]
    else:
        union_blob = None

    return {
        "bubble_index": bubble_index,
        "bubble_bounds_px": union_blob,
        "direction": direction,
        "rotation_deg": round(avg_rot, 2),
        "para_indices": [int(p.get("para_index", 0)) for p in paras],
        "text": text,
        "text_full": text_full,
        "ruby_items_dropped": ruby_items,
        "font_size_px": font_size_px,
        "items": items,
    }


# ---------------------------------------------------------------------------
# Canvas-conflict repair (runs AFTER the text-block rects are attached)
# ---------------------------------------------------------------------------

_CANVAS_FONT_RATIO: float = 1.8

# A canvas is EXPECTED to dwarf the ink it holds — a single vertical column is a
# thin strip inside its balloon, which is exactly why the detected rect is the
# better canvas. So size cannot be judged against the ink, only against the
# page. One speech bubble does not cover a fifth of a manga page; a rect that
# does came from a detection that swallowed several panels, and pouring one line
# into it renders that line as a speck.
_CANVAS_MAX_PAGE_FRACTION: float = 0.20


def canvas_is_oversized(
    rect: Any, img_w: int | None, img_h: int | None
) -> bool:
    """True when a canvas rect is too large to be one bubble on this page.

    Shared by both canvas producers — the OpenCV balloon outline and the trained
    text-block detector — so the size rule is defined once. Returns False when
    the page size is unknown rather than guessing a default: without it there is
    no evidence to judge against.
    """
    if not img_w or not img_h:
        return False
    if not isinstance(rect, (list, tuple)) or len(rect) != 4:
        return False
    w = float(rect[2]) - float(rect[0])
    h = float(rect[3]) - float(rect[1])
    page = float(img_w) * float(img_h)
    if w <= 0 or h <= 0 or page <= 0:
        return False
    return (w * h) / page > _CANVAS_MAX_PAGE_FRACTION


def merge_groups_sharing_canvas(
    tree: dict[str, Any], img_w: int, img_h: int
) -> dict[str, int]:
    """Repair canvas conflicts between groups, and return what changed.

    Two groups whose ``bubble_bounds_px`` is the same rect are, by definition,
    the same bubble: something upstream saw one region and the paragraph merge
    disagreed.  Left alone they render two overlays stacked at identical
    coordinates, so one hides the other and the page looks half-translated.

    A conflict is repaired no matter WHICH producer created the rect.  An
    earlier version trusted a shared OpenCV balloon on the grounds that a
    balloon outline is already per-bubble — but the two producers disagree about
    granularity: the text-block model splits a balloon holding two utterances
    into two regions, and both of those groups then inherit the one balloon as
    their canvas.  Provenance decides nothing here; a duplicated rect is a bug
    either way.

    A shared rect is NOT enough on its own: one region can legitimately hold a
    huge SFX and a small line of dialogue.  Groups only merge when they read
    along the same axis AND their glyph scales are within
    ``_CANVAS_FONT_RATIO``.  Groups that share a rect but fail that test keep
    their own identity and instead have the shared canvas withdrawn, so they
    fall back to their own ink box and stop overlapping.

    A canvas that covers too much of the page is withdrawn outright, shared or
    not: it came from a detection that swallowed several panels, and it would
    render the text as a speck in a huge empty box.

    Returns ``{"merged": n_groups_absorbed, "unshared": n_canvases_withdrawn}``.
    """
    groups: list[dict] = tree.get("bubble_groups") or []
    if not groups:
        return {"merged": 0, "unshared": 0}

    by_index: dict[int, dict] = {
        int(p.get("para_index", i)): p
        for i, p in enumerate(tree.get("paragraphs") or [])
        if isinstance(p, dict)
    }

    merged = unshared = 0
    absorbed: set[int] = set()
    rebuilt: dict[int, dict] = {}

    # Oversized canvases go first: a rect that is not a bubble must not then be
    # treated as evidence that the groups holding it are one bubble.
    for bg in groups:
        if canvas_is_oversized(bg.get("bubble_bounds_px"), img_w, img_h):
            bg["bubble_bounds_px"] = None
            bg["bubble_bounds_source"] = "canvas_oversized_withdrawn"
            unshared += 1

    def canvas_key(bg: dict) -> tuple[float, ...] | None:
        bb = bg.get("bubble_bounds_px")
        if not isinstance(bb, (list, tuple)) or len(bb) != 4:
            return None
        return tuple(round(float(v), 1) for v in bb)

    buckets: dict[tuple[float, ...], list[dict]] = {}
    for bg in groups:
        key = canvas_key(bg)
        if key is not None:
            buckets.setdefault(key, []).append(bg)

    for key, members in buckets.items():
        if len(members) < 2:
            continue
        fonts = [float(bg.get("font_size_px") or 0.0) for bg in members]
        fonts = [f for f in fonts if f > 0]
        scale_ok = (
            not fonts
            or max(fonts) / max(1.0, min(fonts)) <= _CANVAS_FONT_RATIO
        )
        axis_ok = len({str(bg.get("direction") or "") for bg in members}) == 1
        if not (scale_ok and axis_ok):
            # Different utterances that merely share a detected box: give each
            # its own ink box back rather than letting them stack.
            for bg in members:
                bg["bubble_bounds_px"] = None
                bg["bubble_bounds_source"] = "canvas_conflict_withdrawn"
                unshared += 1
            continue

        paras = [
            by_index[pi]
            for bg in members
            for pi in (bg.get("para_indices") or [])
            if int(pi) in by_index
        ]
        if len(paras) < 2:
            continue
        axis = paragraph_reading_axis(
            [it for p in paras for it in (p.get("items") or [])]
        )

        def _key(p: dict, _axis: str = axis) -> tuple[float, float]:
            c = _para_centroid(p, img_w, img_h) or (0.0, 0.0)
            return (-c[0], c[1]) if _axis == "v" else (c[1], c[0])

        keep = min(members, key=lambda bg: int(bg.get("bubble_index", 0)))
        fresh = _build_group(
            int(keep.get("bubble_index", 0)),
            sorted(paras, key=_key),
            img_w,
            img_h,
        )
        fresh["bubble_bounds_px"] = [float(v) for v in key]
        fresh["bubble_bounds_source"] = "textblock"
        fresh["merged_from_canvas"] = sorted(
            int(bg.get("bubble_index", 0)) for bg in members
        )
        rebuilt[id(keep)] = fresh
        for bg in members:
            if bg is not keep:
                absorbed.add(id(bg))
                merged += 1

    if not merged and not unshared:
        return {"merged": 0, "unshared": 0}

    out: list[dict] = []
    for bg in groups:
        if id(bg) in absorbed:
            continue
        out.append(rebuilt.get(id(bg), bg))
    for i, bg in enumerate(out):
        bg["bubble_index"] = i
    tree["bubble_groups"] = out
    return {"merged": merged, "unshared": unshared}


def group_is_ruby_only(bg: dict, tree: dict[str, Any], img_h: int) -> bool:
    """True when a group carries nothing but a furigana reading.

    ``_ruby_para_indices`` can only strip ruby that shares a run with the kanji
    column it annotates.  When the merge leaves a reading alone in its own
    group, that group's whole text is a bare kana pronunciation — useless to a
    translator and, sent to the browser on its own, translated into noise.
    Detected page-wide (the base column is looked up across every paragraph, not
    just this group's), so a stray reading is still recognised.
    """
    text = str(bg.get("text") or "").strip()
    if not text or not _is_kana_only_reading(text):
        return False
    members = {int(pi) for pi in (bg.get("para_indices") or [])}
    paras = [
        p
        for p in (tree.get("paragraphs") or [])
        if isinstance(p, dict) and int(p.get("para_index", -1)) in members
    ]
    if not paras:
        return False
    page = [p for p in (tree.get("paragraphs") or []) if isinstance(p, dict)]
    return bool(_ruby_para_indices(paras + page, img_h) & set(range(len(paras))))
