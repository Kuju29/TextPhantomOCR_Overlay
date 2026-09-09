"""Application service for synchronous API-server translation."""

from __future__ import annotations

from typing import Any
from fastapi import HTTPException, Request

import time, asyncio

from backend import cancellation, trace, logfile
from backend.application import translate_failures, translate_request, translate_response
from backend.config import settings
from backend.ai.provider_resolution import resolve_provider
from backend.ai import wire_trace
from backend.ai import local_wire_relay
from backend.ai.rate_policy import is_local_target, manual_rate_policy
from backend.ai.rategate import (
    rate_gate, RateGateCancelled, RateGateRejected, RateGateTimeout,
)
from backend.api.local_client import wants_unlimited
from backend.api.errors import payload as error_payload, failure_event, cancelled_payload
from backend.jobs.admission import AdmissionGate
from backend.log import event

API_VERSION = "2026-08"

# Schemas this build speaks. A client checks these rather than sniffing fields.
SCHEMAS = [
    "tp.erase-boxes/1",
    "tp.lens-document/1",
    "tp.ai.request/1",
    "tp.ai.result/1",
    "tp.ai-wire-trace/1",
]

# The AI provider does not care which of our two engines called it. `/v1/ai/translate`
# paces this key; without the same gate here the API-server engine would spend the
# very quota the extension engine is being held back from.
def _gate(request: Request, lane: str = "lens") -> AdmissionGate:
    if lane == "ai":
        return request.app.state.ai_admission_gate
    return request.app.state.admission_gate

async def capability_snapshot(request: Request) -> dict:
    """What this server can do — so the client never has to guess.

    A client that finds ``syncTranslate: true`` skips submit/poll entirely. One
    that does not (an older server, or this one behind a proxy that only
    exposes the legacy routes) uses the job queue and says so in its logs, so
    the slow path is never taken silently.
    """
    stats = _gate(request).stats()
    ai_stats = _gate(request, "ai").stats()
    group_stats = request.app.state.grouping_admission_gate.stats()
    pipeline_stats = request.app.state.pipeline_admission_gate.stats()
    snapshot = {
        "ok": True,
        "apiVersion": API_VERSION,
        "schemas": SCHEMAS,
        "features": {
            "syncTranslate": True,
            # Additive negotiation flag for canonical engine-owned routes.
            "engineRoutesV2": True,
            "clientBackground": True,
            "legacyJobQueue": True,
            "aiTranslate": True,
            # One server-owned switch enables matching raw-wire diagnostics
            # in runs:API and runs:Extension. The extension never guesses.
            "aiWireTrace": wire_trace.enabled(),
            # Direct Local never crosses Python's provider transport. Give the
            # extension a short-lived, process-local capability to relay the
            # same lifecycle artifacts into this API's ai-wire directory.
            "aiWireTraceRelay": local_wire_relay.capability(),
            # The browser fetched Lens itself and only needs the geometry
            # decoded — no image crosses the wire.
            "lensDecode": True,
            # The browser could not reach Lens; the server does the round trip.
            "lensFallback": True,
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
        "capacityAi": {
            **ai_stats.as_dict(),
            "executorWorkers": int(getattr(request.app.state, "ai_executor_workers", ai_stats.limit)),
        },
        "capacityGroups": {
            **group_stats.as_dict(),
            "executorWorkers": int(getattr(request.app.state, "grouping_executor_workers", group_stats.limit)),
            "source": "shared_stage_admission",
        },
        "capacityPipeline": {
            **pipeline_stats.as_dict(),
            "executorWorkers": int(getattr(request.app.state, "pipeline_executor_workers", pipeline_stats.limit)),
            "source": "runsapi_dispatch_only",
        },
        # What each lane is allowed RIGHT NOW and whether it may still move.
        # The extension reads this so both sides agree on how much work fits
        # instead of each guessing behind its own fixed number.
        "adaptive": {
            "enabled": bool(getattr(request.app.state, "adaptive_gates", False)),
            "lens": _gate(request).adaptive_state(),
            "ai": _gate(request, "ai").adaptive_state(),
            "rateGate": rate_gate.enabled() and rate_gate.adaptive_enabled(),
        },
    }
    headers = getattr(request, "headers", {}) or {}
    trace.write("api", "api/routes/translate_v1.py", "capabilities", "..", {
        "trace": snapshot["features"]["trace"],
        "traceSession": snapshot["features"]["traceSession"],
        "aiWireTrace": snapshot["features"]["aiWireTrace"],
        "lensLimit": snapshot["capacity"]["limit"],
        "groupingLimit": snapshot["capacityGroups"]["limit"],
        "aiLimit": snapshot["capacityAi"]["limit"],
        "clientVersion": str(headers.get("x-tp-client-version") or "")[:80],
    }, trace_id=str(headers.get("x-tp-trace-id") or ""))
    return snapshot

async def execute(payload: dict[str, Any], request: Request) -> dict:
    """Run one translation and return its result."""
    prepared = translate_request.prepare(payload, request)
    requested_route = prepared.requested_route
    route_identity = prepared.route_identity
    trace_id = prepared.trace_id
    correlation = prepared.correlation
    lane = prepared.lane
    mode = prepared.mode
    source = prepared.source
    identity = prepared.identity
    # Pace only work that will reach an AI provider.
    unlimited = wants_unlimited(request)
    run_pipeline = translate_request.pipeline_callable(
        prepared, admission_unlimited=unlimited
    )
    ai_cfg = payload.get("ai") if isinstance(payload.get("ai"), dict) else {}
    api_key = str(ai_cfg.get("api_key") or "")
    rate_provider = resolve_provider(str(ai_cfg.get("provider") or "auto"), api_key)
    rate_model = str(ai_cfg.get("model") or "auto")
    rate = manual_rate_policy(
        payload,
        provider=rate_provider,
        base_url=str(ai_cfg.get("base_url") or ""),
    )
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
                cancel_check=lambda: cancellation.is_cancelled(payload),
            )
        except RateGateCancelled as exc:
            detail = cancelled_payload(
                trace_id=trace_id, stage="translate_cancel", correlation=correlation)
            raise HTTPException(status_code=409, detail=detail) from exc
        except (RateGateTimeout, RateGateRejected) as exc:
            detail = error_payload(
                code="rate_gate_busy",
                message="The explicit manual AI request cap has no capacity yet.",
                user_message="The AI service is busy. Please try again shortly.",
                origin="api", stage="ai_rate_gate", category="capacity",
                retryable=True, http_status=429, trace_id=trace_id,
                extra={"retryAfterMs": 5000, "generationAttempts": 0},
                correlation=correlation,
            )
            failure_event(requested_route, detail, mode=mode, source=source, **route_identity)
            raise HTTPException(
                status_code=429,
                detail=detail,
                headers={"Retry-After": "5"},
            ) from exc
        rate_wait_ms = round((time.perf_counter() - rate_started) * 1000, 1)

    try:
        # A local caller is this server's only tenant; the fairness gate has
        # nobody to be fair to. Verified against the peer address, not the header.
        # runs:API dispatch has its own fair transport gate. It is intentionally
        # NOT Lens or AI capacity: the worker may move through all three stages.
        # Stage ownership is enforced inside process_payload by the shared API
        # Lens/Grouping/AI gates used by runs:Extension and legacy as well.
        executor = request.app.state.pipeline_executor
        dispatch_gate = request.app.state.pipeline_admission_gate
        loop = asyncio.get_running_loop()
        admission_started = time.perf_counter()
        admission_wait_ms = 0.0
        if unlimited:
            result = await loop.run_in_executor(executor, run_pipeline)
        else:
            async with dispatch_gate.slot(identity):
                admission_wait_ms = round(
                    (time.perf_counter() - admission_started) * 1000, 1
                )
                result = await loop.run_in_executor(executor, run_pipeline)
    except BaseException as exc:
        translate_failures.raise_mapped(
            exc, prepared=prepared, ai_cfg=ai_cfg, paced=paced,
            rate_provider=rate_provider, rate_model=rate_model, api_key=api_key,
            lane=lane, is_local_target=is_local_target,
        )
    if paced:
        rate_gate.report_success(rate_provider, rate_model, api_key)

    if cancellation.is_cancelled(payload):
        event("v1.translate.cancelled", {"mode": mode, "source": source}, ok=True)
        raise HTTPException(status_code=409, detail=cancelled_payload(
            trace_id=trace_id, stage="translate_cancel", correlation=correlation))

    return translate_response.finalize(
        result, prepared=prepared, api_version=API_VERSION, rate=rate,
        paced=paced, rate_wait_ms=rate_wait_ms,
        admission_wait_ms=admission_wait_ms, rate_provider=rate_provider,
        rate_model=rate_model, api_key=api_key,
    )
