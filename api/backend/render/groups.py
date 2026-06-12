"""Paragraph-to-bubble grouping for TextPhantom render trees.

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


def _is_strict_vertical(para: dict) -> bool:
    """True when a paragraph is *unambiguously* a vertical CJK column set.

    Merging exists for exactly one reason: Lens splits ONE vertical sentence
    into per-column paragraphs.  Everything else must keep the Lens paragraph
    as-is (the user's layout spec treats ``paragraphs`` as the source of
    truth).  So a merge candidate must be:

    1. majority-vertical by item rotation (``paragraph_reading_axis``), AND
    2. CJK-dominant text — multi-column splitting is a CJK typesetting
       phenomenon; a Thai/Latin paragraph never needs column re-joining, AND
    3. not just rotation noise: a single-item paragraph only counts when its
       pixel bounds are clearly portrait (height > 2x width).  This blocks the
       axis-vote tie (n_v >= n_h) from sweeping a lone horizontal word whose
       angle Lens misreported into the vertical merge path.
    """
    if _para_axis(para) != "v":
        return False
    if not _is_cjk_dominant(_para_full_text(para)):
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
    if not _is_strict_vertical(a) or not _is_strict_vertical(b):
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
    run: list[dict], img_h: int
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
        top_jump = abs(deltas[i - 1] - median_delta)
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
            runs.extend(_split_vertical_run_at_gap_jumps(ordered_members, img_h))
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

    bubble_groups: list[dict[str, Any]] = []

    for bubble_index, paras in enumerate(runs):
        items: list[dict] = []
        for p in paras:
            items.extend(p.get("items") or [])

        # Combined text for AI translation.  Ruby (furigana) paragraphs are
        # excluded HERE ONLY \u2014 they remain untouched in tree["paragraphs"], so
        # original / translated rendering still shows every word.  Dropping the
        # redundant kana readings (which sit right-of their kanji and would
        # otherwise interleave as "\u304a\u308c\u307e\u3048\u4ffa\u306e\u524d\u3067\u304d\u307f\u3002...") gives the model a
        # clean, correctly-ordered sentence so the translation reads naturally.
        ruby_idx = _ruby_para_indices(paras, img_h) if direction_is_vertical_hint(paras) else set()
        kept = [p for i, p in enumerate(paras) if i not in ruby_idx]
        if not kept:
            kept = list(paras)
        fragments = [t for t in (_para_full_text(p) for p in kept) if t]
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

        bubble_groups.append(
            {
                "bubble_index": bubble_index,
                "bubble_bounds_px": union_blob,
                "direction": direction,
                "rotation_deg": round(avg_rot, 2),
                "para_indices": [int(p.get("para_index", 0)) for p in paras],
                "text": text,
                "text_full": text_full,
                "font_size_px": font_size_px,
                "items": items,
            }
        )

    tree["bubble_groups"] = bubble_groups
    return bubble_groups
