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

Nothing here invents geometry. Every block is a model decision; the recovery
step only attaches a column to a seed the model itself stamped, once, and never
lets a recovered column become a seed for another.
"""
from __future__ import annotations

from typing import Any

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
    """Drop every `_tb_block` so a second pass starts from the model's view."""
    for _, para in iter_paragraphs(tree):
        para.pop("_tb_block", None)


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
        recovered.append(int(para.get("para_index", -1)))
    return recovered


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
    meta["stamped"] = stamped
    return blocks, meta
