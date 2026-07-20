"""Manga TEXT-BLOCK detector — the grouping authority for vertical text.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

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
    _ensure_pool()
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
            timings["lock_ms"] = round((t_infer - t_wait) * 1000, 1)
            timings["infer_ms"] = round((time.perf_counter() - t_infer) * 1000, 1)

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
