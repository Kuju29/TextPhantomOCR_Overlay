"""Manga TEXT-BLOCK detector — the grouping authority for vertical text.

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

_lock = threading.Lock()
_session: Any = None
_session_failed = False          # permanent: onnxruntime missing / corrupt model
_next_download_retry = 0.0       # cooldown for auto-download attempts
_DOWNLOAD_RETRY_SEC = 300.0


def model_path() -> str:
    return (settings.textblock_model_path or "").strip()


def ensure_model() -> bool:
    """Download the ONNX model when missing (called from warmup, best-effort)."""
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
    except Exception as e:  # noqa: BLE001 - optional feature, never fatal
        event("textblocks.model.download_failed", {"error": str(e)[:200]}, ok=False)
        return False


def _get_session() -> Any:
    """Load the onnxruntime session, AUTO-DOWNLOADING the model when missing.

    The model is the primary grouping authority, so this is self-healing:
    a missing file triggers an inline download (with a 5-minute retry
    cooldown on failure) instead of silently disabling the feature. Only a
    truly permanent problem (onnxruntime not installed, corrupt model file)
    marks the session as failed for the process lifetime.
    """
    global _session, _session_failed, _next_download_retry
    if _session is not None or _session_failed:
        return _session
    with _lock:
        if _session is not None or _session_failed:
            return _session
        path = model_path()
        if not path:
            _session_failed = True  # explicitly disabled via TP_TEXTBLOCK_MODEL=""
            return None
        if not os.path.exists(path):
            now = time.time()
            if now < _next_download_retry:
                return None
            if not ensure_model():
                _next_download_retry = now + _DOWNLOAD_RETRY_SEC
                return None
        try:
            import onnxruntime as ort

            _session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
            event("textblocks.model.loaded", {"path": path})
        except Exception as e:  # noqa: BLE001
            _session_failed = True
            event("textblocks.model.load_failed", {"error": str(e)[:200]}, ok=False)
    return _session


def available() -> bool:
    return _get_session() is not None


def detect_text_blocks(img: Image.Image) -> list[Box]:
    """Detect text-block boxes on a page. Returns [] when the model is off.

    Preprocess mirrors the model card: plain resize to 1280x1280, RGB,
    CHW, /255.  Output boxes are mapped back with the inverse scale.
    """
    session = _get_session()
    if session is None:
        return []
    try:
        t0 = time.perf_counter()
        W, H = img.size
        rgb = img.convert("RGB").resize((_INPUT_SIZE, _INPUT_SIZE), Image.BILINEAR)
        arr = np.asarray(rgb, dtype=np.float32) / 255.0
        arr = np.expand_dims(arr.transpose(2, 0, 1), 0)  # 1x3xHxW

        # Serialise inference: one CPU session shared across worker threads.
        with _lock:
            input_name = session.get_inputs()[0].name
            out = session.run(None, {input_name: arr})[0]

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
