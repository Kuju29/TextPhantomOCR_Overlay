"""Public HTTP error mapping for synchronous translation execution."""

from __future__ import annotations

from typing import Any
from fastapi import HTTPException

import asyncio

from backend import trace
from backend.ai.clients.base import OutputBudgetExhausted, ProviderGenerationCancelled
from backend.ai.failure_reason import provider_http_failure, retry_after_sec
from backend.ai.rategate import rate_gate
from backend.api.errors import (ai_rate_feedback_allowed, cancelled_payload,
                                payload as error_payload, failure_event, provider_status,
                                stage_failure_semantics)
from backend.jobs.admission import AdmissionRejected
from backend.log import event
from backend.security import SecurityError

def terminal_metadata(exc: BaseException, *, ai_cfg: dict[str, Any], engine: str,
                      is_local_target) -> dict[str, Any]:
    structural = exc.structural_details if hasattr(exc, "structural_details") and isinstance(exc.structural_details, dict) else {}
    generation = structural.get("generationMeta")
    if not isinstance(generation, dict):
        generation = getattr(exc, "generationMeta", {})
    generation = generation if isinstance(generation, dict) else {}
    usage = generation.get("usage") if isinstance(generation.get("usage"), dict) else {}
    accumulated = generation.get("accumulatedUsage")
    if not isinstance(accumulated, dict):
        accumulated = structural.get("accumulatedUsage")
    accumulated = accumulated if isinstance(accumulated, dict) else {}
    provider = str(structural.get("resolvedProvider") or ai_cfg.get("provider") or "auto")
    attempts = getattr(exc, "generationAttempts", 0) or structural.get("generationAttempts", generation.get("generationAttempts", generation.get("generation_attempts", 1)))
    attempts = attempts if isinstance(attempts, int) and attempts > 0 else 1
    provider_attempts = getattr(exc, "providerAttempts", 0) or structural.get("providerAttempts", generation.get("providerAttempts", attempts))
    provider_attempts = provider_attempts if isinstance(provider_attempts, int) and provider_attempts > 0 else attempts
    from backend.ai.usage import aggregate_usage
    canonical_usage = aggregate_usage([accumulated, usage]) if accumulated and accumulated is not usage else usage
    return {"generationAttempts": attempts, "providerAttempts": provider_attempts,
            "provider": provider, "model": str(structural.get("resolvedModel") or ai_cfg.get("model") or "auto"),
            "runtime": "local" if is_local_target(provider, str(ai_cfg.get("base_url") or "")) else "cloud",
            "engine": engine, "usage": canonical_usage,
            "finishReason": generation.get("finish_reason"),
            "providerMs": generation.get("provider_ms") if isinstance(generation.get("provider_ms"), (int, float)) else None,
            "parseMs": generation.get("provider_parse_ms") if isinstance(generation.get("provider_parse_ms"), (int, float)) else None,
            "promptEvalMs": generation.get("prompt_eval_ms") if isinstance(generation.get("prompt_eval_ms"), (int, float)) else None,
            "firstAllIdsMs": generation.get("first_all_ids_ms") if isinstance(generation.get("first_all_ids_ms"), (int, float)) else None,
            "earlyCompletionMs": generation.get("early_completion_ms") if isinstance(generation.get("early_completion_ms"), (int, float)) else None,
            "terminalMs": generation.get("terminal_ms") if isinstance(generation.get("terminal_ms"), (int, float)) else None,
            "terminalCompleted": generation.get("terminal_completed") is True,
            "terminalEvidence": str(generation.get("terminal_evidence") or "none"),
            "completionEvidence": str(generation.get("completion_evidence") or generation.get("terminal_evidence") or "none"),
            "usageStatus": generation.get("usage_status"), "timeoutPolicy": generation.get("timeout_policy"),
            "wrongLanguageIds": list(structural.get("wrongLanguageIds") or [])[:10],
            "languageDiagnostics": list(structural.get("languageDiagnostics") or [])[:10]}

def raise_mapped(exc: BaseException, *, prepared, ai_cfg, paced, rate_provider,
                 rate_model, api_key, lane, is_local_target) -> None:
    route, trace_id = prepared.requested_route, prepared.trace_id
    common = dict(mode=prepared.mode, source=prepared.source, **prepared.route_identity)
    if isinstance(exc, (asyncio.CancelledError, ProviderGenerationCancelled)):
        event("v1.translate.cancelled", {"mode": prepared.mode, "source": prepared.source}, ok=True)
        trace.write("api", "api/routes/translate_v1.py", "translate_sync", "!!",
                    {"failureKind": "cancelled", "httpStatus": 409}, trace_id=trace_id)
        raise HTTPException(409, detail={"code": "cancelled", "message": "Translation was cancelled.", "traceId": trace_id,
            **(terminal_metadata(exc, ai_cfg=ai_cfg, engine="runsapi", is_local_target=is_local_target) if getattr(exc,"requestDispatched",False) else {})}) from exc
    if isinstance(exc, AdmissionRejected):
        admission_stage = str(getattr(exc, "tp_stage", "") or f"{lane}_admission")
        detail = error_payload(code="server_busy", message=str(exc), user_message="The server is busy. Please try this image again shortly.",
            origin="api", stage=admission_stage, category="capacity", retryable=True, http_status=503, trace_id=trace_id,
            extra={"retryAfterMs": int(exc.retry_after_sec * 1000), "generationAttempts": 0}, correlation=prepared.correlation)
        failure_event(route, detail, lane=lane, **common)
        raise HTTPException(503, detail=detail, headers={"Retry-After": str(exc.retry_after_sec)}) from exc
    if isinstance(exc, SecurityError):
        detail = error_payload(code="invalid_request", message=str(exc)[:200], user_message=str(exc)[:200], origin="client",
            stage="request_validation", category="input", retryable=False, http_status=400, trace_id=trace_id, correlation=prepared.correlation)
        failure_event(route, detail, **common)
        raise HTTPException(400, detail=detail) from exc
    if isinstance(exc, OutputBudgetExhausted):
        structural = dict(getattr(exc, "structural_details", {}) or {})
        terminal = terminal_metadata(exc, ai_cfg=ai_cfg, engine="runsapi", is_local_target=is_local_target)
        detail = error_payload(code="output_budget_exhausted", message=str(exc), user_message="AI used its output limit before completing the translation.",
            origin="upstream_ai", stage="model_output_contract", category="upstream_contract", retryable=False, http_status=502,
            trace_id=trace_id, extra={"structuralDetails": structural, **terminal, "automaticContentRetry": False}, correlation=prepared.correlation)
        failure_event(route, detail, **common)
        raise HTTPException(502, detail=detail) from exc
    if isinstance(exc, ValueError) and not getattr(exc, "requestDispatched", False):
        raise HTTPException(400, detail=str(exc)) from exc
    if type(exc).__name__ == "LensSessionError" and type(exc).__module__ == "backend.lens.client":
        trace.write("api", "api/routes/translate_v1.py", "translate_sync", "!!",
                    {"failureKind": "lens_session_unavailable", "httpStatus": 503,
                     "errorType": type(exc).__name__, "retryable": True},
                    trace_id=trace_id)
        raise HTTPException(503, detail={"code": "lens_session_unavailable", "message": "Google Lens rejected the refreshed server session.",
            "retryable": True, "retryAfterMs": 30000, "generationAttempts": 0, "traceId": trace_id}, headers={"Retry-After": "30"}) from exc
    failed_stage = str(getattr(exc, "tp_stage", "") or "")
    mapped, upstream = provider_http_failure(exc), provider_status(exc)
    semantics = stage_failure_semantics(failed_stage, default_code=mapped.code, default_message=mapped.message,
        default_retryable=mapped.retryable, upstream_status=upstream)
    status = int(semantics.get("httpStatus") or mapped.status)
    if paced and mapped.status == 429 and ai_rate_feedback_allowed(failed_stage):
        rate_gate.report_rate_limited(rate_provider, rate_model, api_key, retry_after_sec=retry_after_sec(exc))
    trace.write("api", "api/routes/translate_v1.py", "translate_sync", "!!",
                {"failureKind": semantics["code"], "httpStatus": status,
                 "upstreamStatus": upstream, "errorType": type(exc).__name__,
                 "retryable": semantics["retryable"],
                 "failedStage": failed_stage or "unknown"}, trace_id=trace_id)
    extra = {"generationAttempts": 0 if mapped.code == "provider_rate_limited" or upstream is not None and 400 <= upstream < 500 else 1}
    if hasattr(exc, "structural_details"):
        extra = terminal_metadata(exc, ai_cfg=ai_cfg, engine="runsapi", is_local_target=is_local_target)
    detail = error_payload(code=semantics["code"], message=semantics["message"], user_message=semantics["message"],
        origin=semantics["origin"], stage=failed_stage or "unknown", category=semantics["category"], retryable=semantics["retryable"],
        http_status=status, trace_id=trace_id, upstream_status=upstream, extra=extra, correlation=prepared.correlation)
    failure_event(route, detail, **common)
    raise HTTPException(status, detail=detail, headers={"Retry-After": str(mapped.retry_after)} if mapped.retry_after else None) from exc
