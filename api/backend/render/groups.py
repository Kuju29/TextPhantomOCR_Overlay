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


def _should_merge(a: dict, b: dict, img_h: int) -> bool:
    """True when paragraphs a and b belong to one bubble/reading unit.

    HYBRID grouping rule:
    * Only VERTICAL paragraphs are ever merged.  Horizontal text keeps the
      accurate 1-paragraph = 1-group default (Lens already groups horizontal
      lines well), and tilted / decorative labels are never auto-merged.
    * Never merge across reading axes (a horizontal and a vertical paragraph
      stay separate).
    This targets only the case where OCR splits one vertical multi-column
    sentence into several paragraphs, without disturbing horizontal behaviour.

    Geometry gate (no per-image constants):
    1. Both paragraphs read vertically (same axis == "v").
    2. Their boxes are adjacent across the reading axis (inter-column gap
       <= k x glyph height) and overlap along the axis.  k is looser when
       both share one OpenCV bubble blob.
    Every threshold scales with glyph size, so it is resolution-independent.
    """
    ax, bx = _para_axis(a), _para_axis(b)
    # Hybrid: merge vertical-with-vertical only; horizontal/tilted untouched.
    if ax != "v" or bx != "v":
        return False
    ra, rb = _para_xyxy(a), _para_xyxy(b)
    if ra is None or rb is None:
        return False
    glyph = max(_para_font_px(a, img_h), _para_font_px(b, img_h), 1.0)
    same_blob = (
        _bubble_key(a) is not None and _bubble_key(a) == _bubble_key(b)
    )
    k = 3.5 if same_blob else 2.0
    ax1, ay1, ax2, ay2 = ra
    bx1, by1, bx2, by2 = rb
    if ax == "v":
        gap = max(0.0, max(ax1, bx1) - min(ax2, bx2))
        overlap = max(0.0, min(ay2, by2) - max(ay1, by1))
        denom = min(ay2 - ay1, by2 - by1)
    else:
        gap = max(0.0, max(ay1, by1) - min(ay2, by2))
        overlap = max(0.0, min(ax2, bx2) - max(ax1, bx1))
        denom = min(ax2 - ax1, bx2 - bx1)
    overlap_ratio = overlap / denom if denom > 0 else 0.0
    return gap <= k * glyph and overlap_ratio >= 0.15


def _merge_paragraphs(ordered: list[dict], img_w: int, img_h: int) -> list[list[dict]]:
    """Cluster paragraphs into bubble runs via union-find on _should_merge.

    Each run is sorted into reading order (vertical -> columns right-to-left
    then top-to-bottom; horizontal -> lines top-to-bottom then left-to-right).
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
            if _should_merge(ordered[i], ordered[j], img_h):
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

        runs.append(sorted(members, key=_key))

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
) -> list[dict[str, Any]]:
    """Compute tree["bubble_groups"] in-place and return it.

    Safe to call multiple times. Skips paragraphs with no display text.
    """
    paragraphs: list[dict] = tree.get("paragraphs") or []

    ordered = sorted(
        [p for p in paragraphs if _para_full_text(p)],
        key=lambda p: int(p.get("para_index", 0)),
    )

    # Merge paragraphs into bubble runs (one run = one bubble = one unit).
    runs: list[list[dict]] = _merge_paragraphs(ordered, img_w, img_h)

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
