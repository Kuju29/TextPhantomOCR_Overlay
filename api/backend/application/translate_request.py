"""Validation and execution context for synchronous API translation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable
from fastapi import HTTPException

import time
from backend.ai import wire_trace

from backend import cancellation, trace
from backend.ai.rate_policy import is_local_target
from backend.api.errors import (
    cancelled_payload,
    payload as error_payload,
    failure_event,
    merged_request_correlation,
)
from backend.application import translate_context
from backend.config import settings
from backend.jobs.admission import identity_of

@dataclass(frozen=True, slots=True)
class TranslationRequest:
    payload: dict[str, Any]
    requested_route: str
    route_identity: dict[str, Any]
    trace_id: str
    correlation: dict[str, Any]
    lane: str
    mode: str
    source: str
    identity: str
    started: float

def prepare(payload: dict[str, Any], request: Any) -> TranslationRequest:
    requested_route = request.url.path
    canonical_route = "/v2/engine/runsapi/translate"
    route_identity = {
        "engine": "runsapi", "canonicalRoute": canonical_route,
        "requestedRoute": requested_route,
        "compatibilityAlias": requested_route != canonical_route,
    }
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    if cancellation.is_cancelled(payload):
        raise HTTPException(status_code=409, detail=cancelled_payload(
            trace_id=str(context.get("tp_trace") or ""), stage="translate_cancel"))
    trace_id = str(context.get("tp_trace") or "") or f"srv-{time.time_ns():x}"
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    correlation = merged_request_correlation(request, {
        "batchId": metadata.get("batch_id") or payload.get("batch_id"),
        "imageId": metadata.get("image_id") or payload.get("image_id"),
    })
    local_detector = lambda provider, base_url="": is_local_target(provider, base_url)
    if not translate_context.ai_server_execution_configured(
        payload, fallback_api_key=settings.ai_api_key, is_local_target=local_detector,
    ):
        detail = error_payload(
            code="ai_not_configured",
            message="AI is selected but no API key or server-local provider is configured.",
            user_message="AI translation is not configured on this server.",
            origin="client", stage="ai_configuration", category="configuration",
            retryable=False, http_status=400, trace_id=trace_id, correlation=correlation,
        )
        failure_event(requested_route, detail, **route_identity)
        raise HTTPException(status_code=400, detail=detail)
    lane = translate_context.lane_for(
        payload, fallback_api_key=settings.ai_api_key, is_local_target=local_detector,
    )
    mode = str(payload.get("mode") or "")
    source = str(payload.get("source") or "")
    identity = identity_of(payload)
    trace.write(
        "api", "api/routes/translate_v1.py", "translate_sync", "->",
        {**route_identity, "mode": mode, "source": source, "lane": lane,
         "identity": identity, "hasImage": bool(payload.get("imageDataUri")),
         "sourceIdentity": translate_context.safe_source_identity(payload.get("src"))},
        trace_id=trace_id,
    )
    return TranslationRequest(payload, requested_route, route_identity, trace_id,
                              correlation, lane, mode, source, identity, time.perf_counter())

def pipeline_callable(context: TranslationRequest, *, admission_unlimited: bool = False) -> Callable[[], dict[str, Any]]:
    def run() -> dict[str, Any]:
        with trace.scope(context.trace_id):
            from backend.jobs.pipeline import process_payload
            ai = context.payload.get("ai") if isinstance(context.payload.get("ai"), dict) else {}
            metadata = (context.payload.get("metadata")
                        if isinstance(context.payload.get("metadata"), dict) else {})
            token = wire_trace.begin({
                "schema": "tp.ai-wire-trace/1", "engine": "runsapi",
                "traceId": context.trace_id,
                "operationId": str(context.payload.get("idempotency_key") or ""),
                "batchId": str(metadata.get("batch_id") or context.payload.get("batch_id") or ""),
                "imageId": str(metadata.get("image_id") or context.payload.get("image_id") or ""),
                "provider": str(ai.get("provider") or "auto"),
                "model": str(ai.get("model") or "auto"),
                "targetLang": str(context.payload.get("target_lang") or context.payload.get("lang") or ""),
                "providerAttempt": 1, "generationAttempt": 1,
            })
            started = time.perf_counter()
            try:
                result = process_payload(
                    context.payload,
                    admission_identity=context.identity,
                    admission_unlimited=admission_unlimited,
                )
                wire_trace.terminal(state="succeeded", stage="runsapi_pipeline")
                return result
            except BaseException as exc:
                wire_trace.record_error(exc, stage="runsapi_pipeline")
                raise
            finally:
                wire_trace.write_json("09_timing.json", {
                    "pipelineMs": round((time.perf_counter() - started) * 1000, 1)
                })
                wire_trace.end(token)
    return run
