"""Google Lens upload, decode, and explicit recovery-route workflows."""

from __future__ import annotations


from typing import Any
from fastapi import File, Form, HTTPException, Request, UploadFile

import asyncio, os, tempfile, time

from backend import cancellation, trace
from backend.application import lens_request
from backend.config import settings
from backend.jobs.admission import AdmissionRejected, identity_of
from backend.jobs.image_artifacts import ArtifactError, image_artifacts
from backend.lens import document as lens_document
from backend.lens.languages import normalize as normalize_lang
from backend.lens.tree import decode_tree, tree_warnings
from backend.log import event
from backend.api.local_client import wants_unlimited
from backend.api.errors import (
    payload as error_payload, failure_event, provider_status, cancelled_payload,
    safe_cause_class, merged_request_correlation,
)
from backend.render import erase_boxes as erase_boxes_mod

# A Lens response for a dense page is tens of KB. A megabyte is not a Lens
# response, and decoding one would pin a worker on something else's data.
MAX_LENS_JSON_BYTES = 2 * 1024 * 1024
LENS_RAW_CANONICAL_ROUTE = "/v2/engine/runsextension/lens/raw"

def _fetch_raw_sync(raw: bytes, target_lang: str, trace_id: str) -> tuple[int, int, dict]:
    """Blocking image inspection + Google round trip, always off the event loop."""
    from backend.lens import client as lens_client
    from PIL import Image

    with tempfile.NamedTemporaryFile(delete=False, suffix=".img") as handle:
        handle.write(raw)
        path = handle.name
    try:
        with trace.scope(trace_id):
            with Image.open(path) as img:
                width, height = img.size
            data = lens_client.fetch_lens_data(path, target_lang, settings.firebase_url)
        return width, height, data
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

def _fetch_fallback_sync(raw: bytes, target_lang: str) -> tuple[dict, int, int]:
    """Compatibility route worker: Lens plus the legacy server-side decode."""
    width, height, data = _fetch_raw_sync(raw, target_lang, "")
    document, _ = _decode(data, width=width, height=height, target_lang=target_lang)
    return document, width, height

def _decode(
    data: dict[str, Any], *, width: int, height: int, target_lang: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Turn a raw Lens response into ``(document, eraseBoxes)``.

    Both come out of the same decode. Returning the boxes here is what lets the
    client paint its own background on the Lens-Direct path: it never uploaded
    the image, so the server has nothing to erase and no picture to send back.
    """
    original_tree = decode_tree(
        data.get("originalParagraphs") or [],
        str(data.get("originalTextFull") or ""),
        "original",
        width,
        height,
    )
    translated_tree = decode_tree(
        data.get("translatedParagraphs") or [],
        str(data.get("translatedTextFull") or ""),
        "translated",
        width,
        height,
    )
    document = lens_document.build(
        original_tree,
        translated_tree,
        width=width,
        height=height,
        source_lang=str(data.get("originalContentLanguage") or ""),
        target_lang=target_lang,
    )

    # What the DECODE threw away, carried out to the client.
    #
    # `build` already reports the items it could not use. It cannot report the
    # ones that never reached it: a paragraph whose geometry Lens sent
    # malformed is skipped inside `decode_tree`, and without this the document
    # simply has fewer paragraphs than the page has bubbles — which reads as a
    # renderer bug or an AI that lost a line, in two files that are both fine.
    decode_warnings = [
        f"{layer}: {line}"
        for layer, tree in (("original", original_tree), ("translated", translated_tree))
        for line in tree_warnings(tree)
    ]
    if decode_warnings:
        document.setdefault("warnings", []).extend(decode_warnings)

    return document, erase_boxes_mod.build_for_tree(original_tree)

async def lens_decode(payload: dict[str, Any]) -> dict:
    """Decode a Lens response the CLIENT fetched. No image involved."""
    t0 = time.perf_counter()

    data = payload.get("lens")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="`lens` must be the raw Lens response object")

    # Cheap guard before touching the protobuf decoder.
    approx_size = len(str(data))
    if approx_size > MAX_LENS_JSON_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"lens response is {approx_size} bytes (max {MAX_LENS_JSON_BYTES})",
        )

    width, height = lens_request.require_size(payload)
    target_lang = normalize_lang(str(payload.get("targetLang") or ""))

    try:
        document, erase = _decode(data, width=width, height=height, target_lang=target_lang)
    except Exception as exc:  # noqa: BLE001 - the client needs the reason, not a 500
        # A decode failure means Google changed the geometry encoding. That is
        # a permanent condition for every page until the adapter is updated, so
        # it must be legible rather than look like a transient error.
        raise HTTPException(
            status_code=422,
            detail=f"could not decode the Lens geometry: {exc}",
        ) from exc

    paragraphs = len(document.get("paragraphs") or [])
    event(
        "v1.lens.decode",
        {
            "paragraphs": paragraphs,
            "warnings": len(document.get("warnings") or []),
            "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
        },
    )
    return {"ok": True, "document": document, "eraseBoxes": erase}

async def lens_raw(
    request: Request,
    image: UploadFile = File(...),
    lang: str = Form("en"),
    tp_trace: str = Form(""),
    batch_id: str = Form(""),
    tp_tab_session: str = Form(""),
    image_id: str = Form(""),
    request_id: str = Form(""),
    job_id: str = Form(""),
    client_version: str = Form(""),
) -> dict:
    """Service 1: upload to Lens and hand back what Lens said. Nothing else.

    The fallback DECODES: it returns a `tp.lens-document/1`, so the protobuf
    reader that runs is the Python one. The extension has its own reader now
    (`src/shared/lens-tree.js`), and it cannot use it unless something gives it
    the undecoded bytes.

    No decode, no geometry, no erase boxes, no grouping. `originalParagraphs`
    goes out exactly as Google sent it: base64 protobuf. The image size travels
    with it because Lens normalises its geometry against the picture it was
    given, and the caller cannot infer that from the response.
    """
    t0 = time.perf_counter()
    route_meta = lens_request.route_meta(request, LENS_RAW_CANONICAL_ROUTE)
    correlation = merged_request_correlation(request, {
        "requestId": request_id,
        "jobId": job_id,
        "batchId": batch_id,
        "imageId": image_id,
        "clientVersion": client_version,
    })
    trace.write(
        "api", "api/routes/lens_v1.py", "lens_raw", "->",
        {"lang": lang, "contentType": image.content_type},
        trace_id=tp_trace,
    )

    if not settings.firebase_url:
        # Loud, not empty. A Lens call with no cookie source returns "no text",
        # which is indistinguishable from an image that has none.
        raise HTTPException(
            status_code=503,
            detail="FIREBASE_URL is not configured; the server cannot reach Lens",
        )

    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="image is empty")
    if len(raw) > settings.max_image_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"image is {len(raw)} bytes (max {settings.max_image_bytes})",
        )
    content_type = (image.content_type or "").split(";")[0].strip().lower()
    if content_type and not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail=f"expected an image, got {content_type}")

    target_lang = normalize_lang(lang)
    cancel_payload = {"batch_id": batch_id}
    if cancellation.is_cancelled(cancel_payload):
        raise HTTPException(status_code=409, detail=cancelled_payload(
            trace_id=tp_trace, stage="lens_cancel", correlation=correlation))
    identity = lens_request.lens_identity(tp_tab_session)
    try:
        # fetch_lens_data is synchronous network I/O. Calling it directly from
        # this async route made the event loop a one-image global mutex: the
        # next upload started only after the previous Lens response completed.
        # A local caller is the only tenant of this server, so the fairness gate
        # has nobody to be fair to. Google Lens is still remote and is still
        # paced by the extension's own lane.
        if wants_unlimited(request):
            loop = asyncio.get_running_loop()
            width, height, data = await loop.run_in_executor(
                request.app.state.lens_executor, _fetch_raw_sync, raw, target_lang, tp_trace
            )
        else:
            async with request.app.state.admission_gate.slot(identity):
                loop = asyncio.get_running_loop()
                width, height, data = await loop.run_in_executor(
                    request.app.state.lens_executor, _fetch_raw_sync, raw, target_lang, tp_trace
                )
    except AdmissionRejected as exc:
        detail = error_payload(
            code="server_busy", message=str(exc),
            user_message="The server is busy. Please try this image again shortly.",
            origin="api", stage="lens_admission", category="capacity",
            retryable=True, http_status=503, trace_id=tp_trace,
            extra={"retryAfterMs": int(exc.retry_after_sec * 1000)},
            correlation=correlation,
        )
        failure_event(request.url.path, detail, **route_meta)
        raise HTTPException(
            status_code=503,
            detail=detail,
            headers={"Retry-After": str(exc.retry_after_sec)},
        ) from exc
    except Exception as exc:  # noqa: BLE001
        if (type(exc).__name__ == "LensSessionError"
                and type(exc).__module__ == "backend.lens.client"):
            detail = error_payload(
                code="lens_session_unavailable",
                message="Google Lens rejected the refreshed server session.",
                user_message="Google Lens is temporarily unavailable. Please try again later.",
                origin="upstream_lens", stage="lens_session", category="upstream_session",
                retryable=True, http_status=503, trace_id=tp_trace,
                extra={"retryAfterMs": 30000},
                correlation=correlation,
            )
            failure_event(request.url.path, detail, **route_meta)
            raise HTTPException(
                status_code=503,
                detail=detail,
                headers={"Retry-After": "30"},
            ) from exc
        upstream_status = provider_status(exc)
        detail = error_payload(
            code="lens_http_error" if upstream_status else "lens_transport_error",
            message="Google Lens could not complete the image request.",
            user_message="Could not read this image with Google Lens. Please try again.",
            origin="upstream_lens", stage="lens_upload", category="upstream",
            retryable=True, http_status=502, trace_id=tp_trace,
            upstream_status=upstream_status,
            extra={"errorType": type(exc).__name__},
            correlation=correlation,
        )
        failure_event(request.url.path, detail, **route_meta)
        raise HTTPException(status_code=502, detail=detail) from exc
    if cancellation.is_cancelled(cancel_payload):
        event(
            "v1.lens.raw.cancelled",
            {"batch_id": batch_id, **route_meta},
            ok=True,
        )
        raise HTTPException(status_code=409, detail=cancelled_payload(
            trace_id=tp_trace, stage="lens_cancel", correlation=correlation))

    if not isinstance(data, dict):
        # Not coerced to `{}`. An empty object decodes to a page with no text,
        # which is a real and common answer — so it must never be what a broken
        # response looks like.
        detail = error_payload(
            code="lens_invalid_response", message="Google Lens returned an invalid response.",
            user_message="Google Lens returned an unreadable result. Please try again.",
            origin="upstream_lens", stage="lens_response", category="upstream_contract",
            retryable=True, http_status=502, trace_id=tp_trace,
            extra={"responseType": type(data).__name__},
            correlation=correlation,
        )
        failure_event(request.url.path, detail, **route_meta)
        raise HTTPException(status_code=502, detail=detail)

    paragraphs = len(data.get("originalParagraphs") or [])
    artifact_info, artifact_outcome = lens_request.optional_image_artifact(
        image_artifacts, raw, identity
    )
    trace.write(
        "api", "api/routes/lens_v1.py", "lens_raw", "<-",
        {"paragraphs": paragraphs, "width": width, "height": height,
         "imageArtifact": artifact_outcome, "artifactMetrics": image_artifacts.stats(),
         "dt_ms": round((time.perf_counter() - t0) * 1000, 1)},
        trace_id=tp_trace,
    )
    event(
        "v1.lens.raw",
        {
            "paragraphs": paragraphs,
            "lang": target_lang,
            "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
            **route_meta,
        },
    )
    result = {
        "ok": True,
        "lens": data,
        # Required by the caller's decoder, and not derivable from `lens`.
        "image": {"width": width, "height": height},
        # Short-lived, process-local handoff to the canonical Lens graph
        # grouping route. The random token
        # is bound to the same tab-session identity and is not a public URL.
    }
    if artifact_info is not None:
        result["imageArtifact"] = artifact_info
    return result

async def lens_fallback(
    request: Request,
    image: UploadFile = File(...),
    lang: str = Form("en"),
    reason: str = Form(""),
    batch_id: str = Form(""),
    tp_tab_session: str = Form(""),
    image_id: str = Form(""),
    request_id: str = Form(""),
    job_id: str = Form(""),
    client_version: str = Form(""),
) -> dict:
    """Do the whole Lens round trip because the client could not.

    ``reason`` is required in spirit: it is the only signal that distinguishes
    "Lens Direct is not viable here" from "Lens Direct broke last Tuesday".
    A blank one is accepted and recorded as blank rather than rejected, because
    refusing the translation over a missing label would be the wrong trade —
    but it is counted, so the gap is visible.
    """
    t0 = time.perf_counter()
    correlation = merged_request_correlation(request, {
        "requestId": request_id,
        "jobId": job_id,
        "batchId": batch_id,
        "imageId": image_id,
        "clientVersion": client_version,
    })

    if not settings.firebase_url:
        # Failing loudly: without a cookie source this endpoint cannot work at
        # all, and a Lens call that returns "no text" would look like an image
        # with no text in it.
        raise HTTPException(
            status_code=503,
            detail="FIREBASE_URL is not configured; the server cannot reach Lens either",
        )

    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="image is empty")
    if len(raw) > settings.max_image_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"image is {len(raw)} bytes (max {settings.max_image_bytes})",
        )

    content_type = (image.content_type or "").split(";")[0].strip().lower()
    if content_type and not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail=f"expected an image, got {content_type}")

    target_lang = normalize_lang(lang)
    cancel_payload = {"batch_id": batch_id}
    if cancellation.is_cancelled(cancel_payload):
        raise HTTPException(status_code=409, detail=cancelled_payload(
            stage="lens_cancel", correlation=correlation))
    identity = lens_request.lens_identity(tp_tab_session)
    try:
        async with request.app.state.admission_gate.slot(identity):
            loop = asyncio.get_running_loop()
            document, _, _ = await loop.run_in_executor(
                request.app.state.lens_executor, _fetch_fallback_sync, raw, target_lang
            )
    except AdmissionRejected as exc:
        detail = error_payload(
            code="server_busy", message=str(exc),
            user_message="The server is busy. Please try again shortly.",
            origin="api", stage="lens", category="capacity", retryable=True,
            http_status=503,
            extra={"retryAfterMs": int(exc.retry_after_sec * 1000)},
            correlation=correlation,
        )
        failure_event("/v1/lens/fallback", detail, reason="admission")
        raise HTTPException(
            status_code=503,
            detail=detail,
            headers={"Retry-After": str(exc.retry_after_sec)},
        ) from exc
    except Exception as exc:  # noqa: BLE001
        if (type(exc).__name__ == "LensSessionError"
                and type(exc).__module__ == "backend.lens.client"):
            detail = error_payload(
                code="lens_session_unavailable",
                message="Google Lens rejected the refreshed server session.",
                user_message="Google Lens is temporarily unavailable. Please try again.",
                origin="upstream_lens", stage="lens_fallback",
                category="upstream_lens", retryable=True, http_status=503,
                extra={"retryAfterMs": 30000}, correlation=correlation,
            )
            failure_event("/v1/lens/fallback", detail, reason="session_unavailable")
            raise HTTPException(
                status_code=503,
                detail=detail,
                headers={"Retry-After": "30"},
            ) from exc
        upstream_status = provider_status(exc)
        detail = error_payload(
            code="lens_http_error" if upstream_status else "lens_transport_error",
            message="Google Lens fallback could not complete the image request.",
            user_message="Could not read this image with Google Lens. Please try again.",
            origin="upstream_lens", stage="lens_fallback", category="upstream",
            retryable=True, http_status=502, upstream_status=upstream_status,
            extra={"errorType": type(exc).__name__, "causeClass": safe_cause_class(exc)},
            correlation=correlation,
        )
        failure_event("/v1/lens/fallback", detail, fallbackReason=reason[:80])
        raise HTTPException(status_code=502, detail=detail) from exc
    if cancellation.is_cancelled(cancel_payload):
        raise HTTPException(status_code=409, detail=cancelled_payload(
            stage="lens_cancel", correlation=correlation))

    event(
        "v1.lens.fallback",
        {
            # The reason the client could not do this itself. Watch the
            # distribution of these: a shift means Lens Direct changed
            # behaviour, and this endpoint is where the cost lands.
            "reason": reason[:80] or "(unstated)",
            "kb": round(len(raw) / 1024),
            "paragraphs": len(document.get("paragraphs") or []),
            "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
        },
    )
    return {"ok": True, "document": document, "fallbackReason": reason}
