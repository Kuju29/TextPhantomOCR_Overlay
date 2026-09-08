"""Application orchestration for extension-owned text translation."""
from __future__ import annotations

from typing import Any
from fastapi import HTTPException, Request

import time

from backend import cancellation, trace
from backend.ai import markers, prompts as ai_prompts, wire_trace
from backend.ai.provider_resolution import resolve_provider
from backend.ai.rate_policy import manual_rate_policy
from backend.ai.rategate import RateGateCancelled, RateGateRejected, RateGateTimeout
from backend.ai.translation.invocation import resolve_generation_model
from backend.api.errors import (cancelled_payload, failure_event, merged_request_correlation,
                                payload as error_payload, safe_validation_reason)
from backend.api.local_client import wants_unlimited
from backend.application import ai_request
from backend.application.ai_translation import idempotency_session, provider_execution, rate_admission, response_mapping, telemetry
from backend.application.ai_translation.context import TranslationContext
from backend.application.ai_translation.provider_errors import trace_failure
from backend.application.ai_translation.request_validation import MAX_TOTAL_CHARS, MAX_UNIT_CHARS, MAX_UNITS, build_config
from backend.config import settings
from backend.jobs.admission import identity_of

REQUEST_SCHEMA = "tp.ai.request/1"
RESULT_SCHEMA = "tp.ai.result/1"
CANONICAL_ROUTE = "/v2/engine/runsextension/ai/translate"

def _prepare(request: Request, payload: dict[str, Any]) -> TranslationContext:
    requested_route = request.url.path
    route_identity = {"engine": "runsextension", "canonicalRoute": CANONICAL_ROUTE,
                      "requestedRoute": requested_route,
                      "compatibilityAlias": requested_route != CANONICAL_ROUTE}
    raw_context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    trace_id = str(raw_context.get("tp_trace") or "")
    correlation = merged_request_correlation(request, {
        "requestId": payload.get("operationId"), "jobId": payload.get("operationId"),
        "batchId": payload.get("batchId"), "imageId": payload.get("imageId") or raw_context.get("image_id")})
    def reject(exc: ValueError, stage: str) -> None:
        detail = error_payload(code="invalid_request", message=str(exc)[:200], user_message=str(exc)[:200],
                               origin="client", stage=stage, category="input", retryable=False,
                               http_status=400, trace_id=trace_id,
                               extra={"validation": safe_validation_reason(str(exc))},
                               correlation=correlation)
        failure_event(requested_route, detail, **route_identity)
        raise HTTPException(400, detail=detail) from exc
    try:
        units = ai_request.validate_units(payload.get("units"), max_units=MAX_UNITS,
                                          max_unit_chars=MAX_UNIT_CHARS, max_total_chars=MAX_TOTAL_CHARS)
        target_lang = str(payload.get("targetLang") or "").strip()
        if not target_lang:
            raise ValueError("targetLang is required")
    except ValueError as exc:
        reject(exc, "request_validation")
    try:
        config = build_config(payload)
        resolved_provider = resolve_provider(config.provider, config.api_key)
        if not resolved_provider and config.api_key:
            raise ValueError("AI provider must be selected explicitly for this API key")
    except ValueError as exc:
        reject(exc, "configuration")
    resolved_model = resolve_generation_model(resolved_provider, config.model)
    rate = manual_rate_policy(payload, provider=resolved_provider, base_url=config.base_url)
    return TranslationContext(
        request=request, payload=payload, request_context=raw_context, units=tuple(units),
        target_lang=target_lang, config=config, marked=markers.apply([str(unit["text"]) for unit in units]),
        trace_id=trace_id, correlation=correlation, route_identity=route_identity,
        requested_route=requested_route, resolved_provider=resolved_provider, resolved_model=resolved_model,
        rate=rate, unlimited=wants_unlimited(request),
        identity=identity_of({"ai": {"api_key": config.api_key}, "context": raw_context}),
        prompt_meta=ai_prompts.prompt_trace_metadata(target_lang, str(payload.get("prompt") or "").strip()))

def _trace_start(ctx: TranslationContext) -> None:
    repair_owner = "extension" if ai_request.extension_owns_repair(ctx.payload) else "backend"
    trace.write("api", "api/routes/ai_v1.py", "ai_translate_v1", "->", {
        "units": ctx.unit_count, "chars": ctx.char_count, "targetLang": ctx.target_lang,
        "pageImage": bool(ctx.config.image_b64),
        "pageImageBytes": (len(ctx.config.image_b64) * 3) // 4 if ctx.config.image_b64 else 0,
        "thinking": ctx.config.thinking, "requestedProvider": ctx.config.provider,
        "requestedModel": ctx.config.model, "resolvedProvider": ctx.resolved_provider,
        "resolvedModel": ctx.resolved_model, "outputContractRequested": "id_markers",
        "automaticContentRetry": False, "contentRepairOwner": repair_owner,
        "automaticTransportRetry": False, "modelFallback": False, "schemaFallback": False,
        "rateEnabled": ctx.rate["enabled"], "rateRpm": ctx.rate["rpm"],
        "rateBurst": ctx.rate["burst"], "rateMode": ctx.rate["mode"], **ctx.route_identity,
        "memoryEnabled": bool(ctx.config.char_memory), "glossaryItems": len(ctx.config.glossary),
        "characterItems": len(ctx.config.characters), "previousContextItems": len(ctx.config.prev_context),
        "hasSeriesState": bool(ctx.config.series_state), **ctx.prompt_meta}, trace_id=ctx.trace_id)

async def execute(request: Request, payload: dict[str, Any], idempotency_key: str | None = None) -> dict:
    """Validate, admit, invoke and map exactly one translation request."""
    started = time.perf_counter()
    ctx = _prepare(request, payload)
    wire_identity = {
        "schema": "tp.ai-wire-trace/1", "engine": "runsextension", "traceId": ctx.trace_id,
        "operationId": str(payload.get("operationId") or ""),
        "batchId": str(payload.get("batchId") or ""),
        "imageId": str(payload.get("imageId") or ""),
        "provider": ctx.resolved_provider, "model": ctx.resolved_model,
        "targetLang": ctx.target_lang, "providerAttempt": 1, "generationAttempt": 1,
    }
    # Start before admission, prompt assembly and HTTP.  A configuration,
    # cancellation or queue failure must leave the same durable evidence as a
    # provider/validator failure.
    wire_token = wire_trace.begin(wire_identity)
    if cancellation.is_cancelled(payload):
        exc = RuntimeError("batch was cancelled before AI started")
        trace_failure(ctx, "cancelled", exc, 409)
        wire_trace.record_error(exc, stage="cancelled_before_ai")
        wire_trace.end(wire_token)
        raise HTTPException(409, detail=cancelled_payload(trace_id=ctx.trace_id, stage="ai_cancel",
                                                          correlation=dict(ctx.correlation))) from exc
    _trace_start(ctx)
    try:
        reservation = await idempotency_session.reserve(request, payload, idempotency_key)
    except idempotency_session.IdempotencyConflict as exc:
        detail = error_payload(code="idempotency_conflict", message=str(exc), user_message=str(exc),
                               origin="client", stage="idempotency", category="input", retryable=False,
                               http_status=409, trace_id=ctx.trace_id, correlation=dict(ctx.correlation))
        failure_event(ctx.requested_route, detail, **ctx.route_identity)
        wire_trace.record_error(exc, stage="idempotency")
        wire_trace.end(wire_token)
        raise HTTPException(409, detail=detail) from exc
    if reservation.replay is not None:
        trace.write("api", "api/routes/ai_v1.py", "ai_translate_v1", "<-",
                    {"replayed": True, "providerAttempts": 0, "generationAttempts": 0,
                     "httpAttempts": 0, "automaticContentRetry": False,
                     "automaticTransportRetry": False}, trace_id=ctx.trace_id)
        wire_trace.terminal(state="replayed", stage="idempotency")
        wire_trace.end(wire_token)
        return reservation.replay
    try:
        rate_entry, rate_wait_ms = await rate_admission.acquire(
            rate=dict(ctx.rate), unlimited=ctx.unlimited, provider=ctx.resolved_provider,
            config=ctx.config, context=dict(ctx.request_context), payload=payload,
            idempotency_key=idempotency_key)
    except RateGateCancelled as exc:
        trace_failure(ctx, "cancelled", exc, 409, units=ctx.unit_count, providerAttempts=0)
        wire_trace.record_error(exc, stage="rate_gate_cancelled")
        wire_trace.end(wire_token)
        raise HTTPException(409, detail=cancelled_payload(trace_id=ctx.trace_id, stage="ai_cancel",
                                                          correlation=dict(ctx.correlation))) from exc
    except (RateGateTimeout, RateGateRejected) as exc:
        detail = error_payload(code="api_rate_gate_timeout", message=str(exc),
            user_message="Server request pacing queue is full or timed out.", origin="api",
            stage="rate_gate", category="capacity", retryable=True, http_status=429,
            trace_id=ctx.trace_id, extra={"rateMode": ctx.rate["mode"], "rateRpm": ctx.rate["rpm"],
                "rateBurst": ctx.rate["burst"], "providerAttempts": 0, "generationAttempts": 0},
            correlation=dict(ctx.correlation))
        failure_event(ctx.requested_route, detail, **ctx.route_identity)
        wire_trace.record_error(exc, stage="rate_gate")
        wire_trace.end(wire_token)
        raise HTTPException(429, detail=detail, headers={"Retry-After": "1"}) from exc
    try:
        execution = await provider_execution.run(ctx, rate_wait_ms=rate_wait_ms)
        wire_trace.write_json("09_timing.json", {
            "providerMs": execution.provider_ms,
            "admissionWaitMs": execution.admission_wait_ms,
            "rateWaitMs": rate_wait_ms,
        })
        body, missing, declined, passthrough = response_mapping.map_result(
            result=execution.result, units=list(ctx.units), payload=payload, target_lang=ctx.target_lang,
            started=started, parse_started=time.perf_counter(), rate_wait_ms=rate_wait_ms,
            admission_wait_ms=execution.admission_wait_ms, provider_ms=execution.provider_ms,
            route_identity=dict(ctx.route_identity), rate=dict(ctx.rate), unlimited=ctx.unlimited,
            resolved_provider=ctx.resolved_provider, config=ctx.config, prompt_meta=dict(ctx.prompt_meta))
        wire_trace.terminal(state="succeeded", stage="response_mapping",
                            translated=len(body.get("translations") or []),
                            missingIds=list(missing or []), declinedIds=list(declined or []))
    except BaseException as exc:
        wire_trace.record_error(exc, stage="runsextension_ai")
        wire_trace.write_json("09_timing.json", {
            "totalMs": round((time.perf_counter() - started) * 1000, 1),
            "rateWaitMs": rate_wait_ms,
        })
        raise
    finally:
        wire_trace.end(wire_token)
    idempotency_session.store(reservation, body)
    telemetry.emit_success(body=body, missing=missing, declined=declined, passthrough=passthrough,
                           route_identity=dict(ctx.route_identity), rate_entry=rate_entry, trace_id=ctx.trace_id)
    return body

async def ai_schema() -> dict:
    return {"ok": True, "request": REQUEST_SCHEMA, "result": RESULT_SCHEMA,
            "limits": {"maxUnits": MAX_UNITS, "maxUnitChars": MAX_UNIT_CHARS,
                       "maxTotalChars": MAX_TOTAL_CHARS}, "hasServerKey": bool(settings.ai_api_key)}

__all__ = ["execute", "ai_schema"]
