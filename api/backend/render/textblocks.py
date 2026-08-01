"""Manga TEXT-BLOCK detector — the grouping authority for vertical text.

STATUS: ACTIVE — in use in the current flow.

Model: ``Kiuyha/Manga-Bubble-YOLO`` (YOLO26, 2025, Apache-2.0) — trained on
Manga109 + MangaDex pages with Magiv2-assisted annotations to detect text
bubbles / text regions in manga.  The YOLO26 head is END-TO-END: the ONNX
graph already performs score filtering + de-duplication and emits up to 300
final detections of shape ``(1, 300, 6)`` = ``[x1, y1, x2, y2, conf, cls]``
in input-pixel space.  No NMS post-processing is needed.

Why: Lens gives clean paragraph groups for horizontal text but shatters
vertical CJK into per-column fragments with no set boundaries.  Pure
geometry cannot always reconstruct the sets (stair layouts, offset columns).
This detector was *trained* to see text blocks the way a reader does, so its
boxes decide which columns belong together.

Safety: completely optional.  If onnxruntime or the model file is missing,
``detect_text_blocks`` returns ``[]`` and grouping falls back to geometry —
behaviour is byte-identical to the system without this module.
"""

from __future__ import annotations

import os
import queue as _queue_mod
import threading
import time
from typing import Any

import numpy as np
from PIL import Image

from backend.render.groups import canvas_is_oversized

from backend.config import settings
from backend.log import dbg, event

Box = tuple[float, float, float, float]

_INPUT_SIZE = 1280
_CONF_THRESH = 0.30

# ---------------------------------------------------------------------------
# Session pool — multiple independent ONNX sessions so workers can run
# inference in parallel instead of serialising on a single lock.
#
# With pool_size=4 and 12 concurrent workers, the maximum blocks_lock_ms
# (time a job spends waiting for a free session) is bounded at
# (pool_size−1) x ~1.3 s ≈ 3.9 s, instead of (12−1) x 1.3 s ≈ 14 s.
#
# Memory cost per session: ~25 MB (yolo26s) / ~7 MB (yolo26n) — negligible.
# ---------------------------------------------------------------------------
_pool: _queue_mod.Queue[Any] = _queue_mod.Queue()
_pool_count = 0          # sessions successfully loaded
_pool_ready = False      # init has been attempted (success or failure)
_session_failed = False  # permanent: onnxruntime missing / corrupt model
_next_download_retry = 0.0
_DOWNLOAD_RETRY_SEC = 300.0
_init_lock = threading.Lock()


def model_path() -> str:
    return (settings.textblock_model_path or "").strip()


def _download_model() -> bool:
    """Stream-download the ONNX weights (best-effort, never fatal)."""
    path = model_path()
    if not path:
        return False
    if os.path.exists(path) and os.path.getsize(path) > 1_000_000:
        return True
    url = (settings.textblock_model_url or "").strip()
    if not url:
        return False
    try:
        import httpx

        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".part"
        with httpx.Client(timeout=300, follow_redirects=True) as client:
            with client.stream("GET", url) as r:
                r.raise_for_status()
                with open(tmp, "wb") as f:
                    for chunk in r.iter_bytes(1 << 20):
                        f.write(chunk)
        os.replace(tmp, path)
        event("textblocks.model.downloaded", {"path": path, "size": os.path.getsize(path)})
        return True
    except Exception as e:  # noqa: BLE001
        event("textblocks.model.download_failed", {"error": str(e)[:200]}, ok=False)
        return False


def _init_pool() -> None:
    """Load pool_size ONNX sessions into _pool. Called once, under _init_lock."""
    global _pool_count, _pool_ready, _session_failed, _next_download_retry

    path = model_path()
    if not path:
        _session_failed = True
        _pool_ready = True
        return

    if not (os.path.exists(path) and os.path.getsize(path) > 1_000_000):
        now = time.time()
        if now < _next_download_retry:
            _pool_ready = True
            return
        if not _download_model():
            _next_download_retry = now + _DOWNLOAD_RETRY_SEC
            _pool_ready = True
            return

    try:
        import onnxruntime as ort

        n = max(1, settings.textblock_pool_size)
        # Divide CPU threads evenly across sessions so concurrent inference
        # does not over-subscribe the machine.  On a 2-vCPU HF Space with
        # n=1 this leaves 2 threads for the single session (the proven-fast
        # path).  With n>1 each session gets floor(cpu_count/n) >= 1 thread.
        cpu_count = os.cpu_count() or 2
        threads_per_session = max(1, cpu_count // n)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads_per_session
        opts.inter_op_num_threads = 1  # sequential graph operators; parallel handled above
        for _ in range(n):
            sess = ort.InferenceSession(
                path, sess_options=opts, providers=["CPUExecutionProvider"]
            )
            _pool.put(sess)
        _pool_count = n
        event(
            "textblocks.model.loaded",
            {"path": path, "sessions": n, "threads_each": threads_per_session},
        )
    except Exception as e:  # noqa: BLE001
        _session_failed = True
        event("textblocks.model.load_failed", {"error": str(e)[:200]}, ok=False)
    finally:
        _pool_ready = True


def _ensure_pool() -> None:
    """Trigger pool initialisation on first use (idempotent)."""
    if _pool_ready:
        return
    with _init_lock:
        if not _pool_ready:
            _init_pool()


def ensure_model() -> bool:
    """Download + load the session pool (called from warmup, best-effort)."""
    _ensure_pool()
    return _pool_count > 0


def available() -> bool:
    """True once the pool has at least one loaded session."""
    _ensure_pool()
    return not _session_failed and _pool_count > 0


def detect_text_blocks(img: Image.Image, timings: dict | None = None) -> list[Box]:
    """Detect text-block boxes on a page. Returns [] when the model is off.

    Preprocess mirrors the model card: plain resize to 1280x1280, RGB,
    CHW, /255.  Output boxes are mapped back with the inverse scale.

    ``timings`` (optional) is filled with ``lock_ms`` (time waiting for a
    free session from the pool) and ``infer_ms`` (this job's own inference).
    With pool_size=4, max wait ≈ (pool_size−1)xinfer_ms instead of
    (workers−1)xinfer_ms.
    """
    # Model load is measured separately: on a cold process this is seconds of
    # work that used to vanish into the caller's blocks_ms with no matching
    # lock/infer time, which reads as "inference was mysteriously slow once".
    _t_load = time.perf_counter()
    _ensure_pool()
    load_ms = round((time.perf_counter() - _t_load) * 1000, 1)
    if timings is not None:
        timings["load_ms"] = timings.get("load_ms", 0.0) + load_ms
    if _session_failed or _pool_count == 0:
        return []
    try:
        t0 = time.perf_counter()
        W, H = img.size
        rgb = img.convert("RGB").resize((_INPUT_SIZE, _INPUT_SIZE), Image.BILINEAR)
        arr = np.asarray(rgb, dtype=np.float32) / 255.0
        arr = np.expand_dims(arr.transpose(2, 0, 1), 0)  # 1x3xHxW

        # Grab a session from the pool (blocks until one is free).
        t_wait = time.perf_counter()
        try:
            session = _pool.get(timeout=60.0)
        except _queue_mod.Empty:
            event("textblocks.pool_timeout", {}, ok=False)
            return []
        t_infer = time.perf_counter()
        try:
            input_name = session.get_inputs()[0].name
            out = session.run(None, {input_name: arr})[0]
        finally:
            _pool.put(session)  # always return, even on exception
        if timings is not None:
            # Accumulate: the ROI path calls this once per crop, and a caller
            # reading "how long did detection take" must see the total, not the
            # last crop's slice.
            timings["lock_ms"] = round(
                timings.get("lock_ms", 0.0) + (t_infer - t_wait) * 1000, 1
            )
            timings["infer_ms"] = round(
                timings.get("infer_ms", 0.0) + (time.perf_counter() - t_infer) * 1000, 1
            )

        det = np.asarray(out)
        det = det.reshape(-1, det.shape[-1])  # (300, 6)
        sx, sy = W / float(_INPUT_SIZE), H / float(_INPUT_SIZE)
        boxes: list[Box] = []
        for row in det:
            if len(row) < 6 or float(row[4]) < _CONF_THRESH:
                continue
            x1, y1, x2, y2 = (float(v) for v in row[:4])
            x1, x2 = sorted((max(0.0, x1 * sx), min(float(W), x2 * sx)))
            y1, y2 = sorted((max(0.0, y1 * sy), min(float(H), y2 * sy)))
            if x2 - x1 >= 4 and y2 - y1 >= 4:
                boxes.append((x1, y1, x2, y2))
        dbg("textblocks.detect", {
            "boxes": len(boxes),
            "ms": round((time.perf_counter() - t0) * 1000, 1),
        })
        return boxes
    except Exception as e:  # noqa: BLE001 - never break the pipeline
        event("textblocks.detect_failed", {"error": str(e)[:200]}, ok=False)
        return []


# --- ROI (cropped) detection ------------------------------------------------
#
# Cropping does NOT reduce inference cost: every input is resized to
# _INPUT_SIZE x _INPUT_SIZE, so one crop costs the same as one full page and N
# crops cost N times as much. What cropping buys is EFFECTIVE RESOLUTION — a
# narrow vertical column blown up to 1280 px is much easier for the model to
# read than the same column inside a downscaled full page.
#
# So the ROI path is only worth taking when the crops are few AND small. Both
# conditions are enforced below, and the reason for the choice is always
# reported so a log reader never has to guess which path ran.

def _roi_plan(
    rois: list[Box], img_w: int, img_h: int
) -> tuple[list[Box], str]:
    """Decide which crops to run. Returns ``(rois_to_run, reason)``.

    An empty list means "run the full page instead".
    """
    if not settings.vertical_roi_enabled:
        return [], "disabled"
    if not rois:
        return [], "no_vertical_rois"
    page_area = float(max(1, img_w * img_h))

    def _area(r: Box) -> float:
        return max(0.0, r[2] - r[0]) * max(0.0, r[3] - r[1])

    coverage = sum(_area(r) for r in rois) / page_area
    if coverage >= settings.vertical_roi_max_coverage:
        # The crops already cover most of the page: the zoom gain is small and
        # we would pay for several inferences to see nearly the same pixels.
        return [], f"coverage_{coverage:.2f}"
    if len(rois) > settings.vertical_roi_max_calls:
        # Too many crops to be worth N inferences. Try their union: if that is
        # still meaningfully smaller than the page, one crop still zooms in.
        xs1 = min(r[0] for r in rois)
        ys1 = min(r[1] for r in rois)
        xs2 = max(r[2] for r in rois)
        ys2 = max(r[3] for r in rois)
        union: Box = (xs1, ys1, xs2, ys2)
        if _area(union) / page_area < settings.vertical_roi_max_coverage:
            return [union], f"union_of_{len(rois)}"
        return [], f"too_many_rois_{len(rois)}"
    return list(rois), f"roi_{len(rois)}"


def _dedupe_boxes(boxes: list[Box], iou_thresh: float = 0.6) -> list[Box]:
    """Drop near-duplicate boxes produced by overlapping crops."""
    kept: list[Box] = []
    for b in boxes:
        b_area = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
        dup = False
        for k in kept:
            ix = max(0.0, min(b[2], k[2]) - max(b[0], k[0]))
            iy = max(0.0, min(b[3], k[3]) - max(b[1], k[1]))
            inter = ix * iy
            if inter <= 0:
                continue
            k_area = max(0.0, k[2] - k[0]) * max(0.0, k[3] - k[1])
            union = b_area + k_area - inter
            if union > 0 and inter / union >= iou_thresh:
                dup = True
                break
        if not dup:
            kept.append(b)
    return kept


def detect_text_blocks_in_rois(
    img: Image.Image,
    rois: list[Box],
    timings: dict | None = None,
) -> list[Box]:
    """Detect text blocks by running the model on cropped regions.

    Falls back to a full-page detection whenever :func:`_roi_plan` says the
    crops are not worth it, so the caller always gets a usable result. The
    decision is written into ``timings["roi_reason"]`` — it is never silent,
    because "ROI was enabled but the full page ran" is exactly the kind of
    thing that makes a benchmark meaningless.
    """
    W, H = img.size
    plan, reason = _roi_plan(list(rois or []), W, H)
    if timings is not None:
        timings["roi_reason"] = reason
        timings["roi_candidates"] = len(rois or [])
        timings["roi_calls"] = len(plan)
    if not plan:
        return detect_text_blocks(img, timings=timings)

    boxes: list[Box] = []
    for r in plan:
        x1 = max(0, int(r[0]))
        y1 = max(0, int(r[1]))
        x2 = min(W, int(round(r[2])))
        y2 = min(H, int(round(r[3])))
        if x2 - x1 < 8 or y2 - y1 < 8:
            continue
        crop = img.crop((x1, y1, x2, y2))
        for b in detect_text_blocks(crop, timings=timings):
            # Crop-local pixels -> page pixels.
            boxes.append((b[0] + x1, b[1] + y1, b[2] + x1, b[3] + y1))
    merged = _dedupe_boxes(boxes)
    dbg("textblocks.roi", {"crops": len(plan), "boxes": len(merged), "reason": reason})
    return merged


def attach_block_bounds_to_groups(
    tree: dict | None,
    blocks: list[Box],
    img_w: int | None = None,
    img_h: int | None = None,
) -> int:
    """Give every bubble group without a bubble outline its ONNX block rect.

    ``bubble_bounds_px`` normally comes from the OpenCV balloon detector and is
    what the relayout uses as the canvas to pour text into. When that detector
    finds nothing (common on borderless panels, narration boxes and dark
    bubbles) the relayout falls back to the union of the source items — which
    for vertical text is a TALL, NARROW column. Horizontal text poured into it
    wraps to one or two characters per line, which is the "text stacked in a
    thin strip" failure.

    The trained text-block model already knows the real extent of the text set,
    so its rect is a far better canvas than a single column's AABB. This fills
    that gap in, and only that gap: a group that already has a detected balloon
    keeps it, because the balloon outline is the more accurate shape.

    Returns how many groups were given a fallback rect.
    """
    if not isinstance(tree, dict) or not blocks:
        return 0
    by_index: dict[int, dict] = {
        int(p.get("para_index", i)): p
        for i, p in enumerate(tree.get("paragraphs") or [])
        if isinstance(p, dict)
    }
    filled = 0
    for bg in tree.get("bubble_groups") or []:
        if not isinstance(bg, dict):
            continue
        bb = bg.get("bubble_bounds_px")
        if isinstance(bb, (list, tuple)) and len(bb) == 4:
            continue
        # Union of the block rects covering this group's paragraphs.
        idxs: set[int] = set()
        for pi in bg.get("para_indices") or []:
            para = by_index.get(int(pi))
            if para is not None and para.get("_tb_block") is not None:
                idxs.add(int(para["_tb_block"]))
        rects = [blocks[i] for i in sorted(idxs) if 0 <= i < len(blocks)]
        if not rects:
            continue
        cand = (
            min(r[0] for r in rects), min(r[1] for r in rects),
            max(r[2] for r in rects), max(r[3] for r in rects),
        )
        if not _canvas_is_plausible(cand, bg, by_index, img_w, img_h):
            bg["bubble_bounds_source"] = "textblock_rejected_oversize"
            continue
        bg["bubble_bounds_px"] = list(cand)
        bg["bubble_bounds_source"] = "textblock"
        filled += 1
    return filled


# How much of the group's own ink the rect must cover to count as its canvas.
_CANVAS_MIN_INK_COVERAGE: float = 0.6


def _canvas_is_plausible(
    cand: Box,
    bg: dict,
    by_index: dict[int, dict],
    img_w: int | None = None,
    img_h: int | None = None,
) -> bool:
    """True when a block rect is a believable canvas for this group's text.

    Guards the one failure this fallback can introduce: a bad detection that
    covers half the page becomes the layout canvas, and the relaid-out line is
    then centred inside a huge empty box. Rejecting it is strictly better than
    accepting it — the caller simply leaves ``bubble_bounds_px`` unset and the
    renderer falls back to the paragraph union, which is at least the right
    order of magnitude. The rejection is recorded in ``bubble_bounds_source``
    rather than dropped silently, so a page that looks wrong can be traced to
    this decision instead of looking like a layout bug.

    Both tests are skipped when the evidence for them is missing rather than
    guessed at: no page size means no page-fraction test, no paragraph rects
    mean no coverage test.
    """
    cw, ch = float(cand[2]) - float(cand[0]), float(cand[3]) - float(cand[1])
    if cw <= 0 or ch <= 0:
        return False

    if canvas_is_oversized(cand, img_w, img_h):
        return False

    ink = [
        _para_rect(by_index[int(pi)])
        for pi in (bg.get("para_indices") or [])
        if int(pi) in by_index
    ]
    ink = [r for r in ink if r is not None]
    if not ink:
        return True  # nothing to compare against — keep the detector's word

    ix1 = min(r[0] for r in ink)
    iy1 = min(r[1] for r in ink)
    ix2 = max(r[2] for r in ink)
    iy2 = max(r[3] for r in ink)
    ink_area = max(1.0, (ix2 - ix1) * (iy2 - iy1))

    # The block must actually contain the ink it claims to describe; a rect
    # that only clips the text set is a mis-assignment, not a canvas.
    ox = max(0.0, min(ix2, float(cand[2])) - max(ix1, float(cand[0])))
    oy = max(0.0, min(iy2, float(cand[3])) - max(iy1, float(cand[1])))
    return (ox * oy) / ink_area >= _CANVAS_MIN_INK_COVERAGE


def _para_rect(para: dict) -> Box | None:
    bp = para.get("bounds_px")
    if isinstance(bp, (list, tuple)) and len(bp) == 4:
        x1, y1, x2, y2 = (float(v) for v in bp)
        if x2 > x1 and y2 > y1:
            return (x1, y1, x2, y2)
    return None


def annotate_paragraph_blocks(tree: dict | None, blocks: list[Box]) -> int:
    """Stamp each paragraph with the index of its best text block.

    Assignment = highest IoU-like score, requiring the block to cover at
    least half of the paragraph.  Paragraphs with no qualifying block carry
    no annotation and keep the geometric grouping path.
    Returns the number of annotated paragraphs.
    """
    if not isinstance(tree, dict) or not blocks:
        return 0
    n = 0
    for para in tree.get("paragraphs") or []:
        if not isinstance(para, dict):
            continue
        pr = _para_rect(para)
        if pr is None:
            continue
        px1, py1, px2, py2 = pr
        p_area = max(1.0, (px2 - px1) * (py2 - py1))
        best_i, best_score = None, 0.0
        for i, (bx1, by1, bx2, by2) in enumerate(blocks):
            ix = max(0.0, min(px2, bx2) - max(px1, bx1))
            iy = max(0.0, min(py2, by2) - max(py1, by1))
            inter = ix * iy
            if inter / p_area < 0.5:
                continue  # block must cover most of the paragraph
            union = p_area + (bx2 - bx1) * (by2 - by1) - inter
            score = inter / max(1.0, union)
            if score > best_score:
                best_i, best_score = i, score
        if best_i is not None:
            para["_tb_block"] = best_i
            n += 1
    return n
