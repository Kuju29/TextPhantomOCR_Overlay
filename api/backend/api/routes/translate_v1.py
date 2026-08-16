"""Synchronous translate endpoint (v1) + capability advertisement.


``POST /v1/translate`` runs the pipeline and returns the result in the same
response. No job id, no server-side result store, no polling.

That is only reasonable because the response got small: with
``render.background: "boxes"`` the reply is trees plus a few hundred boxes
rather than a re-encoded page image as base64. Holding one of those in memory
for the duration of one request costs nothing; holding thousands of the old
ones until a client polled for them was the memory profile that forced
``JOB_TTL_SEC``, ``TP_MAX_JOBS_TRACKED`` and the result-cache eviction rules.

Backpressure moved with it. There is no queue to fill, so a saturated server
answers 503 with ``Retry-After`` and the extension keeps the work it has not
submitted. See :mod:`backend.jobs.admission`.

The legacy ``/translate`` + ``/translate/{id}`` + ``/translate/poll`` endpoints
are untouched: an extension that has not updated yet keeps working exactly as
before, and ``GET /v1/capabilities`` is how a client finds out which of the two
it is talking to.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from backend import cancellation, trace, logfile
from backend.config import settings
from backend.ai.failure_reason import retry_after_sec as _ai_retry_after_sec
from backend.ai.failure_reason import provider_http_failure as _provider_http_failure
from backend.ai.providers import resolve_provider
from backend.ai.rategate import rate_gate, RateGateRejected, RateGateTimeout
from backend.api.local_client import wants_unlimited
from backend.jobs.admission import AdmissionGate, AdmissionRejected, identity_of
from backend.log import event
from backend.security import SecurityError


def _process_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Import the pipeline on first use.

    Kept lazy so this module — the routing, admission and error mapping — can
    be imported and tested without numpy/OpenCV/Pillow present, and so a
    capabilities probe never pays for loading the image stack.
    """
    from backend.jobs.pipeline import process_payload

    return process_payload(payload)

router = APIRouter()

API_VERSION = "2026-08"

# Schemas this build speaks. A client checks these rather than sniffing fields.
SCHEMAS = [
    "tp.erase-boxes/1",
    "tp.lens-document/1",
    "tp.ai.request/1",
    "tp.ai.result/1",
]


def _lane_for(payload: dict[str, Any]) -> str:
    """Which admission lane this request belongs to.

    `ai` when the job will call an AI provider, `lens` otherwise. The two are
    separated because they are limited by different things: the Lens lane by
    this server's capacity, the AI lane by a provider's rate limit. Sharing one
    pool would let a job waiting on a provider occupy capacity needed by Lens.
    """
    if str(payload.get("mode") or "") != "lens_text":
        return "lens"
    if str(payload.get("source") or "").strip().lower() != "ai":
        return "lens"
    # `source: ai` with no key never reaches a provider — the pipeline skips the
    # AI layer entirely. Putting it in the AI lane would let a keyless batch
    # spend the lane that real AI jobs need.
    ai = payload.get("ai") if isinstance(payload.get("ai"), dict) else {}
    has_key = bool(str(ai.get("api_key") or "").strip())
    local = bool(ai.get("on_device")) or "localhost" in str(ai.get("base_url") or "").lower()
    return "ai" if (has_key or local) else "lens"



# The AI provider does not care which of our two engines called it. `/v1/ai/translate`
# paces this key; without the same gate here the API-server engine would spend the
# very quota the extension engine is being held back from.
def _rate_options(payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get("rate") if isinstance(payload.get("rate"), dict) else {}
    enabled = raw.get("enabled")
    enabled = bool(getattr(settings, "rate_gate_enabled", True)) if enabled is None else bool(enabled)

    def num(key: str) -> float:
        try:
            return max(0.0, float(raw.get(key) or 0.0))
        except (TypeError, ValueError):
            return 0.0

    return {"enabled": enabled, "rpm": num("rpm"), "burst": int(num("burst"))}


def _gate(request: Request, lane: str = "lens") -> AdmissionGate:
    if lane == "ai":
        return request.app.state.ai_admission_gate
    return request.app.state.admission_gate


@router.get("/v1/capabilities")
async def capabilities(request: Request) -> dict:
    """What this server can do — so the client never has to guess.

    A client that finds ``syncTranslate: true`` skips submit/poll entirely. One
    that does not (an older server, or this one behind a proxy that only
    exposes the legacy routes) uses the job queue and says so in its logs, so
    the slow path is never taken silently.
    """
    stats = _gate(request).stats()
    ai_stats = _gate(request, "ai").stats()
    return {
        "ok": True,
        "apiVersion": API_VERSION,
        "schemas": SCHEMAS,
        "features": {
            "syncTranslate": True,
            "clientBackground": True,
            "legacyJobQueue": True,
            "aiTranslate": True,
            # The browser fetched Lens itself and only needs the geometry
            # decoded — no image crosses the wire.
            "lensDecode": True,
            # The browser could not reach Lens; the server does the round trip.
            "lensFallback": True,
            # ONNX text-block detection, callable on its own. The extension
            # decides IF it needs blocks (only vertical pages do) and does the
            # grouping and layout itself with the answer — the model runs here
            # only because a 6 MB onnxruntime graph cannot run in a content script.
            "textBlocks": True,
            # ONE switch for both sides. The extension does not carry its own
            # tracing setting: it asks here, and starts or stops shipping to
            # `/v1/trace` to match. Two switches would mean a run with half a
            # trace, which is worse than none — the missing half reads as
            # "that function was never called".
            "trace": trace.enabled(),
            # `trace` remains the boolean understood by existing clients.
            # New clients can show whether the server records compact stage
            # notes or the expensive function-by-function diagnostic.
            "traceDetail": trace.mode(),
            # Additive fields: old extensions ignore them; new ones can show
            # the exact run/file and recover trace shipping after API restart.
            "traceSession": trace.session_id() if trace.enabled() else "",
            "traceFile": trace.file_name() if trace.enabled() else "",
            "traceStartedAt": trace.started_at() if trace.enabled() else "",
            # One human-readable preset for new clients. The old trace fields
            # remain unchanged for mixed-version installations.
            "diagnostics": settings.diagnostics_profile,
            "consoleLevel": (
                "debug" if settings.diagnostics_profile == "deep"
                else "info" if settings.diagnostics_profile == "activity"
                else "warn"
            ),
            # Lets a new extension avoid even one doomed /v1/logs request when
            # diagnostic files are off. Older extensions ignore the field.
            "logFile": logfile.is_enabled(),
        },
        # Both lanes, because "the server is busy" now has two answers and a
        # client that cannot tell them apart will back off the wrong one.
        "capacity": stats.as_dict(),
        "capacityAi": ai_stats.as_dict(),
        # What each lane is allowed RIGHT NOW and whether it may still move.
        # The extension reads this so both sides agree on how much work fits
        # instead of each guessing behind its own fixed number.
        "adaptive": {
            "enabled": bool(getattr(request.app.state, "adaptive_gates", False)),
            "lens": _gate(request).adaptive_state(),
            "ai": _gate(request, "ai").adaptive_state(),
            "onnx": request.app.state.cpu_admission_gate.adaptive_state(),
            "rateGate": rate_gate.enabled() and rate_gate.adaptive_enabled(),
        },
    }


@router.post("/v1/translate")
async def translate_sync(payload: dict[str, Any], request: Request) -> dict:
    """Run one translation and return its result."""
    if cancellation.is_cancelled(payload):
        raise HTTPException(status_code=409, detail="batch was cancelled")
    lane = _lane_for(payload)
    gate = _gate(request, lane)
    mode = str(payload.get("mode") or "")
    source = str(payload.get("source") or "")
    t0 = time.perf_counter()

    # Capacity is shared between people, so the gate has to be told who this
    # is. See `identity_of`: the AI key when there is one, else the tab
    # session — "different person or different key", which is exactly the
    # boundary a provider's rate limit follows.
    identity = identity_of(payload)

    # The trace id is minted by the extension when the user clicks, and travels
    # in the payload. Echoing it here is what makes one image's browser lines
    # and server lines the same story instead of two files to align by hand.
    trace_id = str(((payload.get("context") or {}) if isinstance(payload.get("context"), dict) else {})
                   .get("tp_trace") or "")
    if not trace_id:
        trace_id = f"srv-{time.time_ns():x}"
    trace.write("api", "api/routes/translate_v1.py", "translate_sync", "->",
                {"mode": mode, "source": source, "lane": lane, "identity": identity,
                 "hasImage": bool(payload.get("imageDataUri")), "src": payload.get("src")},
                trace_id=trace_id)

    def _run() -> dict[str, Any]:
        # Runs on a worker thread, so it must adopt the trace id itself — the
        # thread-local does not cross `to_thread`.
        with trace.scope(trace_id):
            return _process_payload(payload)

    # Pace this key exactly as `/v1/ai/translate` does, but only for a job that
    # will really reach a provider — `_lane_for` already made that judgement.
    unlimited = wants_unlimited(request)
    rate = _rate_options(payload)
    ai_cfg = payload.get("ai") if isinstance(payload.get("ai"), dict) else {}
    api_key = str(ai_cfg.get("api_key") or "")
    rate_provider = resolve_provider(str(ai_cfg.get("provider") or "auto"), api_key)
    rate_model = str(ai_cfg.get("model") or "auto")
    paced = lane == "ai" and rate["enabled"] and not unlimited
    rate_wait_ms = 0.0
    if paced:
        rate_started = time.perf_counter()
        try:
            await rate_gate.acquire(
                rate_provider, rate_model, api_key,
                session=str(((payload.get("context") or {}) if isinstance(payload.get("context"), dict) else {})
                            .get("tp_tab_session") or trace_id),
                job_id=str(payload.get("idempotency_key") or trace_id or f"v1-{time.time_ns()}"),
                deadline_sec=settings.rate_max_wait_sec,
                max_waiters=settings.rate_max_waiters_per_bucket,
                rpm_override=rate["rpm"] or None,
                burst_override=rate["burst"] or None,
            )
        except (RateGateTimeout, RateGateRejected) as exc:
            event("v1.translate.rate_limited", {"mode": mode, "source": source}, ok=False)
            raise HTTPException(
                status_code=429,
                detail={"code": "local_rate_gate_busy",
                        "message": "Local provider pacing has no capacity yet.",
                        "retryable": True, "traceId": trace_id},
                headers={"Retry-After": "5"},
            ) from exc
        rate_wait_ms = round((time.perf_counter() - rate_started) * 1000, 1)

    try:
        # A local caller is this server's only tenant; the fairness gate has
        # nobody to be fair to. Verified against the peer address, not the header.
        if wants_unlimited(request):
            result = await asyncio.to_thread(_run)
        else:
            async with gate.slot(identity):
                result = await asyncio.to_thread(_run)
    except asyncio.CancelledError as exc:
        event("v1.translate.cancelled", {"mode": mode, "source": source}, ok=False)
        trace.write(
            "api", "api/routes/translate_v1.py", "translate_sync", "!!",
            {"failureKind": "cancelled", "httpStatus": 409}, trace_id=trace_id,
        )
        raise HTTPException(
            status_code=409,
            detail={"code": "cancelled", "message": "Translation was cancelled.",
                    "traceId": trace_id},
        ) from exc
    except AdmissionRejected as exc:
        # No backlog: the client keeps the work and comes back. This is the
        # whole point of the gate — an honest "not now" instead of an accepted
        # job that sits behind two thousand others.
        event(
            "v1.translate.busy",
            {"mode": mode, "source": source, "lane": lane, **gate.stats().as_dict()},
            ok=False,
        )
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after_sec)},
        ) from exc
    except SecurityError as exc:
        # A rejected base_url / image URL is the caller's problem to fix, not a
        # server fault, and must not read as a transient failure worth retrying.
        event("v1.translate.refused", {"mode": mode, "error": str(exc)[:200]}, ok=False)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        if (type(exc).__name__ == "LensSessionError"
                and type(exc).__module__ == "backend.lens.client"):
            # Upstream session exhaustion is neither a provider failure nor an
            # internal bug. Keep the rejected cookie details server-side.
            trace.write(
                "api", "api/routes/translate_v1.py", "translate_sync", "!!",
                {"failureKind": "lens_session_unavailable", "httpStatus": 503,
                 "errorType": type(exc).__name__, "retryable": True},
                trace_id=trace_id,
            )
            raise HTTPException(
                status_code=503,
                detail={"code": "lens_session_unavailable",
                        "message": "Google Lens rejected the refreshed server session.",
                        "retryable": True, "traceId": trace_id},
                headers={"Retry-After": "30"},
            ) from exc
        mapped = _provider_http_failure(exc)
        # Teach the gate once at this boundary. Never also report success for
        # a failed provider request.
        if paced and mapped.status == 429:
            rate_gate.report_rate_limited(
                rate_provider, rate_model, api_key,
                retry_after_sec=_ai_retry_after_sec(exc),
            )
        # WHERE it broke, not just that it broke. A bare RuntimeError here could
        # be the download, the Lens upload or the decode, and the trace could not
        # tell them apart.
        failed_stage = str(getattr(exc, "tp_stage", "") or "")
        trace.write(
            "api", "api/routes/translate_v1.py", "translate_sync", "!!",
            {"failureKind": mapped.code, "httpStatus": mapped.status,
             "errorType": type(exc).__name__, "retryable": mapped.retryable,
             "failedStage": failed_stage or "unknown"},
            trace_id=trace_id,
        )
        event(
            "v1.translate.failed",
            {"mode": mode, "source": source, "failureKind": mapped.code,
             "status": mapped.status, "failedStage": failed_stage or "unknown",
             "traceId": trace_id}, ok=False,
        )
        headers = ({"Retry-After": str(mapped.retry_after)}
                   if mapped.retry_after else None)
        raise HTTPException(
            status_code=mapped.status,
            detail={"code": mapped.code, "message": mapped.message,
                    "retryable": mapped.retryable, "traceId": trace_id,
                    "failedStage": failed_stage or "unknown"},
            headers=headers,
        ) from exc
    if paced:
        rate_gate.report_success(rate_provider, rate_model, api_key)

    if cancellation.is_cancelled(payload):
        event("v1.translate.cancelled", {"mode": mode, "source": source}, ok=False)
        raise HTTPException(status_code=409, detail="batch was cancelled while running")

    result["apiVersion"] = API_VERSION
    perf = result.get("perf") if isinstance(result.get("perf"), dict) else {}
    # What is actually going back, named. This is the line that answers "did
    # the server send geometry, markup, a background, or all three" without
    # anyone having to dump a 269 KB response.
    trace.write("api", "api/routes/translate_v1.py", "translate_sync", "<-",
                {"pipeline": result.get("pipelinePath"),
                 "rateWaitMs": rate_wait_ms,
                 "paced": paced,
                 "rate": rate_gate.snapshot(rate_provider, rate_model, api_key) if paced else None,
                 "aiMeta": {k: v for k, v in ((result.get("Ai") or {}).get("meta") or {}).items()
                            if k in ("units", "missing_units", "passthrough_units", "skipped_reason")},
                 "backgroundMode": result.get("backgroundMode"),
                 "hasLensDocument": bool(result.get("lensDocument")),
                 "docParagraphs": len((result.get("lensDocument") or {}).get("paragraphs") or []),
                 "hasEraseBoxes": bool(result.get("eraseBoxes")),
                 "hasImageDataUri": bool(result.get("imageDataUri")),
                 "hasOriginalHtml": bool((result.get("original") or {}).get("originalhtml")),
                 "hasTranslatedHtml": bool((result.get("translated") or {}).get("translatedhtml")),
                 "hasAiHtml": bool((result.get("Ai") or {}).get("aihtml")),
                 "perf": perf},
                trace_id=trace_id)
    # One image finished: put its lines on disk now. Buffering is what keeps
    # tracing cheap, but a buffer that only drains on a timer means the file is
    # missing the end of the story exactly when someone goes to read it.
    trace.flush()
    event(
        "v1.translate",
        {
            "mode": mode,
            "source": source,
            "lang": str(payload.get("lang") or ""),
            "total_ms": round((time.perf_counter() - t0) * 1000, 1),
            "cache": perf.get("cache", ""),
            "background": result.get("backgroundMode", ""),
        },
    )
    return result
