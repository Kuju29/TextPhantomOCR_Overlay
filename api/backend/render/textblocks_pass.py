"""One text-block detection pass, with the second look, shared by both engines.

`/v1/groups` (the extension engine) already did this: run the detector over the
vertical ROIs, and when the first view stamps nothing usable, take ONE more view
that can produce different evidence — enlarged crops of the columns still
missing, or a full page after crops found boxes that failed the coverage test —
then recover a column that has exactly one unambiguous stamped neighbour.

`pipeline.py` (the API engine) called the detector once and took what it got.
On the 2026-08-15 pages that is the whole difference: 10 of 20 vertical AI pages
came back with `blocks: 0`, so there were no bubble groups, so every Lens column
was translated on its own. Same page, same model, two answers — because one
engine looked twice and the other did not.

ONNX remains the primary authority. The recovery step only attaches a column
to a seed the model itself stamped, once, and never lets a recovered column
become a seed for another. When ONNX produces *zero usable paragraph stamps*, a
separate conservative fallback may use Lens bounds to resolve the page only if
every pair is decisively same-unit or decisively separate; any grey-zone pair
keeps the explicit grouping failure.
"""
from __future__ import annotations

from typing import Any

from backend.config import settings
from backend.lens.tree import iter_paragraphs
from backend.render.region import paragraph_reading_axis
from backend.render.textblocks import annotate_paragraph_blocks, dedupe_text_blocks

# A failed full-page pass may lose small text when the page is resized to the
# model's fixed 1280px input. Retry only the still-uncovered vertical regions
# at crop resolution. Eight crops bound the worst-case CPU cost while covering
# every failure shape observed in the 2026-08-09 trace (at most six ROIs).
MAX_FORCED_RETRY_ROIS = 8


def para_rect(para: dict) -> tuple[float, float, float, float] | None:
    """A paragraph's pixel bounds, or None when it carries none usable."""
    bp = para.get("bounds_px")
    if not isinstance(bp, (list, tuple)) or len(bp) != 4:
        return None
    try:
        x1, y1, x2, y2 = (float(v) for v in bp)
    except (TypeError, ValueError):
        return None
    if not (x2 > x1 and y2 > y1):
        return None
    return (x1, y1, x2, y2)


def vertical_with_bounds(tree: dict) -> list[dict]:
    """Every vertical paragraph the detector could actually be scored against."""
    return [
        para
        for _, para in iter_paragraphs(tree)
        if para_rect(para) is not None
        and paragraph_reading_axis(para.get("items") or []) == "v"
    ]


def clear_block_stamps(tree: dict) -> None:
    """Drop every text-block stamp so a second pass starts from the model's view."""
    for _, para in iter_paragraphs(tree):
        para.pop("_tb_block", None)
        para.pop("_tb_source", None)


def retry_strategy(*, stamped: int, blocks: int, roi_calls: int,
                   retry_candidates: int) -> str:
    """Choose a second detector view only when it can add new evidence.

    A full-page first pass can be followed by enlarged remaining-column crops.
    Conversely, individual crops which found boxes that failed the paragraph
    coverage test need a full-page view: repeating the same crops cannot change
    their geometry. A crop pass with no boxes has already exhausted that view.
    """
    if retry_candidates <= 0:
        return "none"
    if stamped > 0 or roi_calls == 0:
        return "remaining_individual"
    if blocks > 0:
        return "full_page_after_unqualified_hits"
    return "none"


def detect_retry_blocks(detector: Any, image: Any, retry_rois: list,
                        strategy: str, timings: dict) -> list:
    """Execute the selected retry view; split out for argument-level tests."""
    if strategy == "remaining_individual":
        return detector(
            image,
            retry_rois,
            timings=timings,
            force_individual=True,
            max_calls=MAX_FORCED_RETRY_ROIS,
        )
    if strategy == "full_page_after_unqualified_hits":
        return detector(image, [], timings=timings)
    return []


def conservative_block_neighbor(a: dict, b: dict) -> bool:
    """Whether two columns are close enough for safe missed-stamp recovery."""
    ra, rb = para_rect(a), para_rect(b)
    if ra is None or rb is None:
        return False
    ax1, ay1, ax2, ay2 = ra
    bx1, by1, bx2, by2 = rb
    aw, bw = ax2 - ax1, bx2 - bx1
    ah, bh = ay2 - ay1, by2 - by1
    glyph = max(aw, bw, 1.0)
    if max(aw, bw) / max(1.0, min(aw, bw)) > 1.5:
        return False
    overlap = max(0.0, min(ay2, by2) - max(ay1, by1))
    if overlap / max(1.0, min(ah, bh)) < 0.70:
        return False
    gap = max(0.0, max(ax1, bx1) - min(ax2, bx2))
    if gap > 0.80 * glyph:
        return False
    return abs(ay1 - by1) <= glyph


def recover_unstamped_vertical(tree: dict) -> list[int]:
    """Attach a missed column only to an original, unambiguous model seed.

    Recovery is deliberately one pass. A recovered paragraph is evidence about
    neither the model nor its next neighbour, so it must never become a seed and
    flood-fill a long undetected run.
    """
    vertical = vertical_with_bounds(tree)
    model_seeds = tuple(
        para for para in vertical if para.get("_tb_block") is not None
    )
    recovered: list[int] = []
    for para in vertical:
        if para.get("_tb_block") is not None:
            continue
        candidates = {
            int(seed["_tb_block"])
            for seed in model_seeds
            if conservative_block_neighbor(para, seed)
        }
        if len(candidates) != 1:
            continue
        para["_tb_block"] = candidates.pop()
        para["_tb_source"] = "model_recovery"
        recovered.append(int(para.get("para_index", -1)))
    return recovered


_GEOMETRY_BLOCK_BASE = 1_000_000


def _pixel_barrier_between(image: Any, ra: tuple[float, float, float, float],
                           rb: tuple[float, float, float, float]) -> bool:
    """Strong visual evidence that two columns are separated by an ink wall.

    This is only a veto for the geometry fallback.  It never creates a merge.
    The test mirrors the renderer's erased-page barrier rule but is deliberately
    a little stricter because this path may receive the original (text-present)
    image in the API-server engine.
    """
    if image is None:
        return False
    try:
        left = min(ra[2], rb[2])
        right = max(ra[0], rb[0])
        if right - left < 3:
            return False
        y1 = max(ra[1], rb[1])
        y2 = min(ra[3], rb[3])
        if y2 - y1 < 10:
            return False
        crop = image.convert("L").crop((int(left), int(y1), int(right), int(y2)))
        w, h = crop.size
        if w < 2 or h < 10:
            return False
        import numpy as np
        arr = np.asarray(crop, dtype=np.uint8)
        # A real panel/bubble wall usually persists through most of the shared
        # vertical span.  Requiring 68% keeps ordinary glyph strokes from
        # becoming false separators on the original page.
        dark_ratio = (arr < 88).mean(axis=0)
        return bool((dark_ratio >= 0.68).any())
    except Exception:
        return False


def _geometry_pair_relation(a: dict, b: dict, image: Any = None) -> tuple[str, dict[str, float | bool]]:
    """Classify one pair as ``same``, ``separate`` or ``ambiguous``.

    ``same`` is intentionally much stricter than the renderer's ordinary
    geometric merge.  ``separate`` also requires strong evidence.  Everything
    in the grey zone remains ambiguous and therefore preserves the old
    grouping-failed behaviour instead of guessing.
    """
    ra, rb = para_rect(a), para_rect(b)
    if ra is None or rb is None:
        return "ambiguous", {}
    ax1, ay1, ax2, ay2 = ra
    bx1, by1, bx2, by2 = rb
    aw, bw = ax2 - ax1, bx2 - bx1
    ah, bh = ay2 - ay1, by2 - by1
    glyph = max(aw, bw, 1.0)
    width_ratio = max(aw, bw) / max(1.0, min(aw, bw))
    x_gap = max(0.0, max(ax1, bx1) - min(ax2, bx2))
    y_overlap = max(0.0, min(ay2, by2) - max(ay1, by1))
    overlap_ratio = y_overlap / max(1.0, min(ah, bh))
    y_gap = max(0.0, max(ay1, by1) - min(ay2, by2))
    top_delta = abs(ay1 - by1)
    barrier = _pixel_barrier_between(image, ra, rb)
    meta = {
        "widthRatio": round(width_ratio, 3),
        "xGapGlyph": round(x_gap / glyph, 3),
        "overlapRatio": round(overlap_ratio, 3),
        "yGapGlyph": round(y_gap / glyph, 3),
        "topDeltaGlyph": round(top_delta / glyph, 3),
        "barrier": barrier,
    }

    if barrier:
        return "separate", meta
    # Clearly different scale or clearly distant columns cannot be parts of one
    # Lens-shattered vertical sentence.
    if width_ratio > 2.0 or x_gap > 1.65 * glyph:
        return "separate", meta
    # Stacked/diagonal balloons have little common vertical span.  Require a
    # meaningful gap or a conspicuous top displacement before calling them
    # definitely separate; otherwise keep the pair ambiguous.
    if overlap_ratio < 0.22 and (y_gap > 0.55 * glyph or top_delta > 2.0 * glyph):
        return "separate", meta
    if y_gap > 1.25 * glyph:
        return "separate", meta
    if top_delta > 2.6 * glyph and overlap_ratio < 0.55:
        return "separate", meta

    # Strong same-utterance evidence: similar column width, almost the same
    # vertical span, close pitch and near-aligned top edge.  This matches normal
    # right-to-left manga columns but rejects the neighbouring-bubble examples
    # that triggered zero-hit failures in the HF trace.
    if (
        width_ratio <= 1.45
        and overlap_ratio >= 0.72
        and x_gap <= 0.82 * glyph
        and top_delta <= 0.95 * glyph
    ):
        return "same", meta
    return "ambiguous", meta


def apply_geometry_fallback_vertical(tree: dict, image: Any = None) -> dict[str, Any]:
    """Resolve a zero-model-hit vertical page only when geometry is decisive.

    The detector remains the primary authority.  This fallback is considered
    only when *no* vertical paragraph has a model/recovery stamp.  Strong-same
    pairs are unioned into one synthetic block; every relation between distinct
    components must be provably separate.  A single ambiguous pair aborts the
    entire fallback and leaves the tree untouched.

    This all-or-nothing contract is what makes sparse pages safe: one paragraph
    per speech balloon becomes a set of identity groups, while a real
    multi-column balloon can still merge when its columns are strongly aligned.
    """
    enabled = bool(getattr(settings, "textblock_geometry_fallback", True))
    vertical = vertical_with_bounds(tree)
    meta: dict[str, Any] = {
        "enabled": enabled,
        "attempted": False,
        "applied": False,
        "reason": "",
        "vertical": len(vertical),
        "groups": [],
        "mergedGroups": 0,
        "identityGroups": 0,
        "ambiguousPairs": [],
    }
    if not enabled:
        meta["reason"] = "disabled"
        return meta
    if not vertical:
        meta["reason"] = "no_vertical_paragraphs"
        return meta
    max_paras = max(1, int(getattr(settings, "textblock_geometry_fallback_max_paragraphs", 48)))
    if len(vertical) > max_paras:
        meta["reason"] = "too_many_vertical_paragraphs"
        return meta
    if any(p.get("_tb_block") is not None for p in vertical):
        meta["reason"] = "model_or_recovery_present"
        return meta

    meta["attempted"] = True
    n = len(vertical)
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

    relations: dict[tuple[int, int], tuple[str, dict[str, Any]]] = {}
    for i in range(n):
        for j in range(i + 1, n):
            relation, evidence = _geometry_pair_relation(vertical[i], vertical[j], image)
            relations[(i, j)] = (relation, evidence)
            if relation == "same":
                union(i, j)

    components: dict[int, list[int]] = {}
    for i in range(n):
        components.setdefault(find(i), []).append(i)

    # Any grey-zone relation between two would-be groups means geometry has not
    # actually proved the split.  Abort instead of translating possible sentence
    # fragments. Relations inside one strong-connected component are allowed to
    # be distant because a 3+ column sentence is naturally transitive.
    ambiguous: list[dict[str, Any]] = []
    for (i, j), (relation, evidence) in relations.items():
        if find(i) == find(j):
            continue
        if relation == "ambiguous":
            ambiguous.append({
                "a": int(vertical[i].get("para_index", -1)),
                "b": int(vertical[j].get("para_index", -1)),
                **evidence,
            })
    if ambiguous:
        meta["reason"] = "ambiguous_geometry"
        meta["ambiguousPairs"] = ambiguous[:12]
        return meta

    ordered_components = sorted(
        components.values(),
        key=lambda members: min(int(vertical[i].get("para_index", i)) for i in members),
    )
    group_indices: list[list[int]] = []
    for group_no, members in enumerate(ordered_components):
        block_id = _GEOMETRY_BLOCK_BASE + group_no
        para_indices: list[int] = []
        for i in members:
            para = vertical[i]
            para["_tb_block"] = block_id
            para["_tb_source"] = "geometry_fallback"
            para_indices.append(int(para.get("para_index", -1)))
        group_indices.append(para_indices)

    meta.update({
        "applied": True,
        "reason": "geometry_decisive",
        "groups": group_indices,
        "mergedGroups": sum(1 for g in group_indices if len(g) > 1),
        "identityGroups": sum(1 for g in group_indices if len(g) == 1),
    })
    return meta


def copy_geometry_fallback_stamps(source_tree: dict, target_tree: dict) -> int:
    """Copy synthetic fallback block ids by ``para_index`` between Lens layers."""
    source = {
        int(p.get("para_index", -1)): int(p["_tb_block"])
        for _, p in iter_paragraphs(source_tree)
        if p.get("_tb_source") == "geometry_fallback" and p.get("_tb_block") is not None
    }
    if not source:
        return 0
    copied = 0
    for _, para in iter_paragraphs(target_tree):
        idx = int(para.get("para_index", -1))
        if idx not in source:
            continue
        para["_tb_block"] = source[idx]
        para["_tb_source"] = "geometry_fallback"
        copied += 1
    return copied


def detect_blocks_with_second_look(
    detector: Any,
    image: Any,
    tree: dict,
    rois: list,
    *,
    build_rois: Any,
    width: int,
    height: int,
    timings: dict | None = None,
) -> tuple[list, dict[str, Any]]:
    """First pass, optional second view, recovery. Returns (blocks, meta).

    ``tree`` is stamped in place (``_tb_block``). ``build_rois`` is passed in
    rather than imported so the caller keeps control of its own margin policy.
    """
    timings = timings if isinstance(timings, dict) else {}
    clear_block_stamps(tree)
    blocks = detector(image, rois, timings=timings)
    stamped = annotate_paragraph_blocks(tree, blocks)

    missing = [p for p in vertical_with_bounds(tree) if p.get("_tb_block") is None]
    retry_rois = build_rois({"paragraphs": missing}, width, height) if missing else []
    strategy = retry_strategy(
        stamped=stamped,
        blocks=len(blocks),
        roi_calls=int(timings.get("roi_calls") or 0),
        retry_candidates=len(retry_rois),
    )

    meta: dict[str, Any] = {
        "attempted": strategy != "none",
        "uncoveredBefore": len(missing),
        "roiCandidates": len(retry_rois),
        "roiCalls": 0,
        "blocks": 0,
        "reason": strategy if strategy != "none" else (
            "already_individual_no_blocks" if retry_rois else ""
        ),
        "initialOutcome": (
            "qualified_blocks" if stamped > 0 else
            "blocks_no_qualifying_overlap" if blocks else
            "no_blocks"
        ),
        "initialStamped": stamped,
    }

    if strategy != "none":
        retry_timings: dict[str, Any] = {}
        retry_blocks = detect_retry_blocks(detector, image, retry_rois, strategy, retry_timings)
        meta["roiCalls"] = retry_timings.get("roi_calls", 0)
        meta["blocks"] = len(retry_blocks)
        meta["detectorReason"] = retry_timings.get("roi_reason", "")
        meta["inferMs"] = retry_timings.get("infer_ms")
        meta["lockMs"] = retry_timings.get("lock_ms")
        meta["loadMs"] = retry_timings.get("load_ms")
        # The pipeline perf object is meant to describe the WHOLE detector pass.
        # The previous code reported only first-pass lock/infer time, so a page
        # whose retry spent 8 seconds waiting looked mysteriously slow outside
        # every named stage. Fold retry timing into the caller's totals.
        for _key in ("load_ms", "lock_ms", "infer_ms"):
            timings[_key] = round(
                float(timings.get(_key) or 0.0) + float(retry_timings.get(_key) or 0.0), 1
            )
        if retry_blocks:
            # For the alternate full-page view, prefer its geometry when dedupe
            # sees a near-duplicate of the unqualified crop box. Otherwise the
            # old under-box can mask the evidence we retried for.
            ordered = (
                [*retry_blocks, *blocks]
                if strategy == "full_page_after_unqualified_hits"
                else [*blocks, *retry_blocks]
            )
            blocks = dedupe_text_blocks(ordered)
            clear_block_stamps(tree)
            stamped = annotate_paragraph_blocks(tree, blocks)

    meta["recovered"] = recover_unstamped_vertical(tree)
    meta["geometryFallback"] = apply_geometry_fallback_vertical(tree, image=image)
    meta["modelStamped"] = stamped
    meta["stamped"] = sum(
        1 for p in vertical_with_bounds(tree) if p.get("_tb_block") is not None
    )
    return blocks, meta
