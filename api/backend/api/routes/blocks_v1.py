"""Text-block detection as a service the EXTENSION calls (v1).


``POST /v1/blocks``
    The extension sends an image and gets back the text-block rectangles the
    ONNX detector found. Nothing else: no grouping, no layout, no rendering.

The extension owns the workflow; the API provides operations unavailable in a
browser. ONNX is one of those: the
detector is a 6 MB model driven by `onnxruntime`, and shipping that into a
content script is not on the table today.

The extension decides whether it needs blocks, requests them, and owns grouping
and layout.

Coordinates
-----------
In and out, boxes are NORMALISED to 0..1 against the image, matching
``tp.lens-document/1`` and ``tp.erase-boxes/1``. The browser displays a page at
CSS size while the model measured it at natural size, and a pixel box is wrong
the moment those differ.

What it does NOT do
-------------------
No caching by image hash. The detector is ~262 ms on 2 vCPU and the cache key
would have to include the ROI list, which is derived from Lens geometry the
server no longer holds on this path. A cache that misses on every call is
slower than no cache and harder to reason about.
"""

from __future__ import annotations

import io
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from backend import trace
from backend.config import settings
from backend.jobs.admission import AdmissionRejected, identity_of
from backend.log import event

router = APIRouter()

SCHEMA = "tp.text-blocks/1"

# A page is a page. Anything much past this is not a manga page, and decoding it
# would cost more memory than the detection saves.
MAX_IMAGE_BYTES = 24 * 1024 * 1024
MAX_ROIS = 32


def _norm_box(box: Any, width: int, height: int) -> list[float] | None:
    """One detector box (pixels) as normalised [l, t, r, b], or None."""
    try:
        x0, y0, x1, y1 = (float(v) for v in box)
    except (TypeError, ValueError):
        return None
    if not (width > 0 and height > 0):
        return None
    left, right = sorted((x0 / width, x1 / width))
    top, bottom = sorted((y0 / height, y1 / height))
    if right - left <= 0 or bottom - top <= 0:
        return None
    return [round(left, 5), round(top, 5), round(right, 5), round(bottom, 5)]


def _px_roi(roi: Any, width: int, height: int) -> tuple[float, float, float, float] | None:
    """A normalised ROI from the client, back in pixels for the detector."""
    if not isinstance(roi, (list, tuple)) or len(roi) != 4:
        return None
    try:
        left, top, right, bottom = (float(v) for v in roi)
    except (TypeError, ValueError):
        return None
    left, right = sorted((left, right))
    top, bottom = sorted((top, bottom))
    if right - left <= 0 or bottom - top <= 0:
        return None
    return (left * width, top * height, right * width, bottom * height)


@router.post("/v1/blocks")
async def detect_blocks(payload: dict[str, Any], request: Request) -> dict:
    """Run the text-block detector on one image.

    ``imageDataUri`` (required) — the page.
    ``rois`` (optional)         — normalised regions to look in. When Lens
                                  found vertical columns the client already
                                  knows where they are, and cropping to them
                                  makes the detector see them at full
                                  resolution instead of shrunk inside a whole
                                  page. The server decides whether the crops
                                  are worth it and REPORTS that decision.
    """
    # Imported here, not at module scope: a capabilities probe or a text-only
    # deployment must not pay for loading numpy/Pillow/onnxruntime.
    from PIL import Image

    from backend.jobs.pipeline import _CPU_GATE
    from backend.render.textblocks import (
        available as textblocks_available,
        TextBlockBusy,
        detect_text_blocks,
        detect_text_blocks_in_rois,
    )
    from backend.utils.images import b64_to_bytes

    started = time.perf_counter()
    identity = identity_of(payload)
    trace_id = str(
        ((payload.get("context") or {}) if isinstance(payload.get("context"), dict) else {}).get(
            "tp_trace"
        )
        or ""
    )

    if not textblocks_available():
        # Said, not faked. A client that gets an empty list would group the page
        # with geometry rules and never know the model was missing — and the
        # symptom would be "grouping got worse", investigated in the wrong file.
        raise HTTPException(
            status_code=503,
            detail="the text-block model is not loaded on this server",
        )

    data_uri = str(payload.get("imageDataUri") or "")
    if not data_uri:
        raise HTTPException(status_code=400, detail="`imageDataUri` is required")
    try:
        raw = b64_to_bytes(data_uri.split(",", 1)[-1])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"could not decode the image: {exc}") from exc
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"image is {len(raw)} bytes (max {MAX_IMAGE_BYTES})",
        )

    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"not a readable image: {exc}") from exc
    width, height = image.size

    raw_rois = payload.get("rois")
    rois: list = []
    if isinstance(raw_rois, list):
        for roi in raw_rois[:MAX_ROIS]:
            converted = _px_roi(roi, width, height)
            if converted:
                rois.append(converted)

    # The CPU lane, not the Lens lane — same reasoning as `/v1/groups`: this is
    # ~262 ms of compute, and holding a Lens upload slot for it starves the
    # lane whose work is network sleep.
    gate = request.app.state.cpu_admission_gate
    timings: dict = {}
    admission_started = time.perf_counter()
    try:
        async with gate.slot(identity):
            timings["admission_wait_ms"] = round(
                (time.perf_counter() - admission_started) * 1000, 1
            )
            import asyncio

            def _run() -> list:
                with trace.scope(trace_id):
                    _cpu_wait = time.perf_counter()
                    _CPU_GATE.acquire()
                    timings["cpu_gate_wait_ms"] = round(
                        (time.perf_counter() - _cpu_wait) * 1000, 1
                    )
                    try:
                        if rois:
                            return detect_text_blocks_in_rois(
                                image, rois, timings=timings,
                                session_wait_sec=settings.sync_cpu_session_wait_sec,
                            )
                        return detect_text_blocks(
                            image, timings=timings,
                            session_wait_sec=settings.sync_cpu_session_wait_sec,
                        )
                    finally:
                        _CPU_GATE.release()

            boxes = await asyncio.get_running_loop().run_in_executor(
                request.app.state.cpu_executor, _run
            )
    except TextBlockBusy as exc:
        event("v1.blocks.busy", {"identity": identity, "reason": "detector_session", **timings}, ok=False)
        raise HTTPException(
            status_code=503,
            detail={"code": "server_busy", "stage": "onnx",
                    "message": "text-block detector is busy", "retryable": True,
                    "retryAfterMs": int(exc.retry_after_sec * 1000),
                    "generationAttempts": 0},
            headers={"Retry-After": str(exc.retry_after_sec)},
        ) from exc
    except AdmissionRejected as exc:
        event("v1.blocks.busy", {"identity": identity, "reason": "admission"}, ok=False)
        raise HTTPException(
            status_code=503,
            detail={"code": "server_busy", "stage": "onnx",
                    "message": str(exc), "retryable": True,
                    "retryAfterMs": int(exc.retry_after_sec * 1000)},
            headers={"Retry-After": str(exc.retry_after_sec)},
        ) from exc

    normalised = [b for b in (_norm_box(box, width, height) for box in boxes or []) if b]
    dropped = len(boxes or []) - len(normalised)
    total_ms = round((time.perf_counter() - started) * 1000, 1)

    event(
        "v1.blocks",
        {
            "blocks": len(normalised),
            "rois": len(rois),
            "roi_reason": str(timings.get("roi_reason") or ""),
            "admission_wait_ms": timings.get("admission_wait_ms", 0.0),
            "cpu_gate_wait_ms": timings.get("cpu_gate_wait_ms", 0.0),
            "model_load_ms": timings.get("load_ms", 0.0),
            "session_wait_ms": timings.get("lock_ms", 0.0),
            "infer_ms": timings.get("infer_ms", 0.0),
            "total_ms": total_ms,
        },
    )
    trace.write(
        "api",
        "api/routes/blocks_v1.py",
        "detect_blocks",
        "<-",
        {"blocks": len(normalised), "rois": len(rois),
         "admissionWaitMs": timings.get("admission_wait_ms", 0.0),
         "cpuGateWaitMs": timings.get("cpu_gate_wait_ms", 0.0),
         "modelLoadMs": timings.get("load_ms", 0.0),
         "sessionWaitMs": timings.get("lock_ms", 0.0),
         "inferMs": timings.get("infer_ms", 0.0),
         "total_ms": total_ms},
        trace_id=trace_id,
    )

    result = {
        "ok": True,
        "schema": SCHEMA,
        "image": {"width": width, "height": height},
        "blocks": normalised,
        # WHICH detection ran. `detect_text_blocks_in_rois` silently falls back
        # to a full-page pass when the crops are not worth it, and a client that
        # cannot tell the two apart cannot explain a change in its own grouping.
        "roiReason": str(timings.get("roi_reason") or ("full_page" if not rois else "")),
        "roiCalls": int(timings.get("roi_calls") or 0),
        "inferMs": timings.get("infer_ms"),
        "totalMs": total_ms,
    }
    if dropped:
        # A shorter list with no explanation reads as "the model found fewer
        # blocks", which points at the model instead of at the geometry.
        result["warnings"] = [f"dropped {dropped} box(es) with unusable geometry"]
    return result
