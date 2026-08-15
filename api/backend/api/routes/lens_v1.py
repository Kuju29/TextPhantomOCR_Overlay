"""Lens endpoints (v1): decode, and fallback.


``POST /v1/lens/decode``
    The extension fetched Lens itself and sends the RAW response. The server
    decodes the protobuf geometry and returns a ``tp.lens-document/1``.

    Current clients decode in the service worker (`src/shared/lens-tree.js`).
    The route remains a compatibility contract for deployed clients.

    It is NOT a fallback for the local decoder. Both run the same algorithm on
    the same bytes, pinned by `api/tests/fixtures/lens_tree.json`, so a retry
    here would either fail identically or succeed and hide a drift between
    them. When the local decode throws, the extension takes the normal route
    and says so.

``POST /v1/lens/raw``
    THE path this extension uses. The server uploads to Lens and returns what
    Lens said, undecoded. The extension decodes it with its own reader.

    Lens rejects extension-origin uploads, so the API owns this network step.

``POST /v1/lens/fallback``
    Upload AND decode, returning a finished `tp.lens-document/1`.

    Current clients prefer `/v1/lens/raw`. This endpoint remains for deployed
    clients that require server-side decoding.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import time
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from backend import cancellation, trace
from backend.config import settings
from backend.jobs.admission import AdmissionRejected, identity_of
from backend.jobs.image_artifacts import ArtifactError, image_artifacts
from backend.lens import document as lens_document
from backend.lens.languages import normalize as normalize_lang
from backend.lens.tree import decode_tree, flatten_spans, tree_warnings
from backend.log import event
from backend.api.local_client import wants_unlimited
from backend.render import erase_boxes as erase_boxes_mod

router = APIRouter()

# A Lens response for a dense page is tens of KB. A megabyte is not a Lens
# response, and decoding one would pin a worker on something else's data.
MAX_LENS_JSON_BYTES = 2 * 1024 * 1024


def _lens_identity(tab_session: str) -> str:
    """Reuse the normal admission identity without exposing multipart details."""
    return identity_of({"context": {"tp_tab_session": str(tab_session or "")}})


def _optional_image_artifact(store: Any, raw: bytes, identity: str) -> tuple[dict | None, str]:
    """Best-effort optimisation; inability to cache must not fail Lens."""
    try:
        token, ttl = store.put(raw, identity)
    except ArtifactError as exc:
        return None, exc.code
    return {
        "token": token,
        "expiresInSec": ttl,
        "scope": "anonymous" if identity == "anon" else "session",
    }, "stored"


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

    return document, erase_boxes_mod.build(flatten_spans(original_tree))


def _require_size(payload: dict[str, Any]) -> tuple[int, int]:
    """Image size, which the CLIENT must supply.

    Lens returns geometry normalised to the image it was given, so the pixel
    size has to come from whoever holds the picture. Guessing a default here
    would produce a document that renders — at the wrong scale, on every page,
    with nothing to indicate why.
    """
    image = payload.get("image") if isinstance(payload.get("image"), dict) else {}
    try:
        width = int(image.get("width") or 0)
        height = int(image.get("height") or 0)
    except (TypeError, ValueError):
        width = height = 0
    if width <= 0 or height <= 0:
        raise HTTPException(
            status_code=400,
            detail="image.width and image.height are required (Lens geometry is "
            "normalised against them, so they cannot be inferred here)",
        )
    return width, height


@router.post("/v1/lens/decode")
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

    width, height = _require_size(payload)
    target_lang = normalize_lang(str(payload.get("targetLang") or ""))

    try:
        document, erase = _decode(data, width=width, height=height, target_lang=target_lang)
    except Exception as exc:  # noqa: BLE001 - the client needs the reason, not a 500
        # A decode failure means Google changed the geometry encoding. That is
        # a permanent condition for every page until the adapter is updated, so
        # it must be legible rather than look like a transient error.
        event("v1.lens.decode.error", {"error": str(exc)[:300]}, ok=False)
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


@router.post("/v1/lens/raw")
async def lens_raw(
    request: Request,
    image: UploadFile = File(...),
    lang: str = Form("en"),
    tp_trace: str = Form(""),
    batch_id: str = Form(""),
    tp_tab_session: str = Form(""),
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
        raise HTTPException(status_code=409, detail="batch was cancelled")
    identity = _lens_identity(tp_tab_session)
    try:
        # fetch_lens_data is synchronous network I/O. Calling it directly from
        # this async route made the event loop a one-image global mutex: the
        # next upload started only after the previous Lens response completed.
        # A local caller is the only tenant of this server, so the fairness gate
        # has nobody to be fair to. Google Lens is still remote and is still
        # paced by the extension's own lane.
        if wants_unlimited(request):
            width, height, data = await asyncio.to_thread(
                _fetch_raw_sync, raw, target_lang, tp_trace
            )
        else:
            async with request.app.state.admission_gate.slot(identity):
                width, height, data = await asyncio.to_thread(
                    _fetch_raw_sync, raw, target_lang, tp_trace
                )
    except AdmissionRejected as exc:
        event("v1.lens.raw.busy", {"identity": identity}, ok=False)
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after_sec)},
        ) from exc
    except Exception as exc:  # noqa: BLE001
        if (type(exc).__name__ == "LensSessionError"
                and type(exc).__module__ == "backend.lens.client"):
            event("v1.lens.raw.session_unavailable", {"identity": identity}, ok=False)
            raise HTTPException(
                status_code=503,
                detail={"code": "lens_session_unavailable",
                        "message": "Google Lens rejected the refreshed server session.",
                        "retryable": True, "traceId": tp_trace},
                headers={"Retry-After": "30"},
            ) from exc
        event("v1.lens.raw.error", {"error": str(exc)[:300]}, ok=False)
        raise HTTPException(status_code=502, detail=f"Lens upload failed: {exc}") from exc
    if cancellation.is_cancelled(cancel_payload):
        event("v1.lens.raw.cancelled", {"batch_id": batch_id}, ok=False)
        raise HTTPException(status_code=409, detail="batch was cancelled while Lens was running")

    if not isinstance(data, dict):
        # Not coerced to `{}`. An empty object decodes to a page with no text,
        # which is a real and common answer — so it must never be what a broken
        # response looks like.
        raise HTTPException(
            status_code=502,
            detail=f"Lens returned {type(data).__name__}, not an object",
        )

    paragraphs = len(data.get("originalParagraphs") or [])
    artifact_info, artifact_outcome = _optional_image_artifact(
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
        },
    )
    result = {
        "ok": True,
        "lens": data,
        # Required by the caller's decoder, and not derivable from `lens`.
        "image": {"width": width, "height": height},
        # Short-lived, process-local handoff to `/v1/groups`. The random token
        # is bound to the same tab-session identity and is not a public URL.
    }
    if artifact_info is not None:
        result["imageArtifact"] = artifact_info
    return result


@router.post("/v1/lens/fallback")
async def lens_fallback(
    request: Request,
    image: UploadFile = File(...),
    lang: str = Form("en"),
    reason: str = Form(""),
    batch_id: str = Form(""),
    tp_tab_session: str = Form(""),
) -> dict:
    """Do the whole Lens round trip because the client could not.

    ``reason`` is required in spirit: it is the only signal that distinguishes
    "Lens Direct is not viable here" from "Lens Direct broke last Tuesday".
    A blank one is accepted and recorded as blank rather than rejected, because
    refusing the translation over a missing label would be the wrong trade —
    but it is counted, so the gap is visible.
    """
    t0 = time.perf_counter()

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
        raise HTTPException(status_code=409, detail="batch was cancelled")
    identity = _lens_identity(tp_tab_session)
    try:
        async with request.app.state.admission_gate.slot(identity):
            document, _, _ = await asyncio.to_thread(
                _fetch_fallback_sync, raw, target_lang
            )
    except AdmissionRejected as exc:
        event("v1.lens.fallback.busy", {"identity": identity}, ok=False)
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after_sec)},
        ) from exc
    except Exception as exc:  # noqa: BLE001
        if (type(exc).__name__ == "LensSessionError"
                and type(exc).__module__ == "backend.lens.client"):
            event("v1.lens.fallback.session_unavailable", {"identity": identity}, ok=False)
            raise HTTPException(
                status_code=503,
                detail={"code": "lens_session_unavailable",
                        "message": "Google Lens rejected the refreshed server session.",
                        "retryable": True},
                headers={"Retry-After": "30"},
            ) from exc
        event("v1.lens.fallback.error", {"reason": reason[:80], "error": str(exc)[:300]}, ok=False)
        raise HTTPException(status_code=502, detail=f"Lens fallback failed: {exc}") from exc
    if cancellation.is_cancelled(cancel_payload):
        raise HTTPException(status_code=409, detail="batch was cancelled while Lens was running")

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
