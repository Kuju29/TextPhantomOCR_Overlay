"""Public and trace-safe mappings for provider execution failures."""

from __future__ import annotations

from typing import Any, NoReturn
from fastapi import HTTPException

import re, math

from backend import trace
from backend.ai.clients.base import OutputBudgetExhausted, ProviderGenerationCancelled
from backend.ai.clients.provider_error import ProviderAdapterContractError
from backend.ai.errors import ModelOutputContractError
from backend.ai.workload import WorkloadBudgetError
from backend.ai.capabilities import OutputCapabilityChanged
from backend.ai.failure_reason import classify, provider_http_failure, retry_after_sec
from backend.ai.rategate import rate_gate
from backend.api.errors import (
    cancelled_payload, failure_event, payload as error_payload, provider_status,
    safe_validation_reason,
)
from backend.jobs.admission import AdmissionRejected
from backend.security import SecurityError
from backend.application.ai_translation.context import TranslationContext

PUBLIC_MESSAGES = {
    "provider_auth_failed": "API key ถูกปฏิเสธ กรุณาตรวจสอบคีย์และ Provider",
    "provider_quota_exhausted": "โควตาหรือเครดิต AI หมด",
    "billing_required": "Provider ต้องการตั้งค่าการชำระเงิน",
    "provider_rate_limited": "Provider จำกัดความถี่ กรุณารอสักครู่",
    "provider_model_not_found": "ไม่พบโมเดลที่เลือกใน Provider",
    "provider_model_access_denied": "บัญชีนี้ไม่มีสิทธิ์ใช้โมเดลที่เลือก",
    "provider_content_blocked": "Provider ปฏิเสธเนื้อหานี้",
    "provider_payload_too_large": "Prompt หรือข้อความยาวเกินขีดจำกัดของ Provider",
    "provider_timeout": "Provider ตอบช้าเกินเวลา",
    "provider_transport": "ติดต่อ Provider ไม่สำเร็จ",
    "invalid_model_output": "AI ตอบกลับไม่ครบตามรูปแบบที่ต้องใช้",
    "invalid_output_contract": "AI ตอบกลับในรูปแบบที่ระบบอ่านไม่ได้",
    "provider_client_contract_error": "ตัวเชื่อม Provider ภายใน TextPhantom ไม่เข้ากัน กรุณาอัปเดตระบบ",
    "provider_http": "Provider ปฏิเสธคำขอนี้",
    "provider_failed": "Provider ทำคำขอนี้ไม่สำเร็จ โปรดดู Trace ID",
    "internal_error": "TextPhantom เกิดข้อผิดพลาดภายใน โปรดดู Trace ID",
}

def provider_call_counts(exc: BaseException, default: int = 1) -> tuple[int, int]:
    structural = getattr(exc, "structural_details", {})
    structural = structural if isinstance(structural, dict) else {}
    generation = getattr(exc, "generationMeta", {})
    generation = generation if isinstance(generation, dict) else {}
    generated = int(getattr(exc, "generationAttempts", 0)
                    or structural.get("generationAttempts", 0)
                    or generation.get("generationAttempts", 0) or default)
    providers = int(getattr(exc, "providerAttempts", 0)
                    or structural.get("providerAttempts", 0)
                    or generation.get("providerAttempts", 0) or generated)
    return max(0, providers), max(0, generated)

def invalid_detail(ctx: TranslationContext, message: str,
                   stage: str = "request_validation") -> dict[str, Any]:
    detail = error_payload(
        code="invalid_request", message=str(message)[:200], user_message=str(message)[:200],
        origin="client", stage=stage, category="input", retryable=False, http_status=400,
        trace_id=ctx.trace_id, extra={"validation": safe_validation_reason(message)},
        correlation=dict(ctx.correlation),
    )
    failure_event(ctx.requested_route, detail, **ctx.route_identity)
    return detail

def trace_failure(ctx: TranslationContext, stage: str, exc: BaseException,
                  status: int, **details: Any) -> None:
    status_match = re.search(r"\bHTTP\s+(\d{3})\b", str(exc), re.IGNORECASE)
    provider_attempts = int(details.pop("providerAttempts", 0) or 0)
    generation_attempts = int(details.pop("generationAttempts", provider_attempts) or 0)
    trace.write("api", "api/routes/ai_v1.py", "ai_translate_v1", "!!", {
        "stage": stage, "failureKind": classify(exc), "errorType": type(exc).__name__,
        "error": str(exc), "httpStatus": status, "automaticContentRetry": False,
        "automaticTransportRetry": False, "providerAttempts": provider_attempts,
        "generationAttempts": generation_attempts,
        "providerHttpStatuses": [int(status_match.group(1))] if status_match else [],
        "modelFallback": False, "schemaFallback": False, **ctx.route_identity, **details,
    }, trace_id=ctx.trace_id)

def raise_execution_error(ctx: TranslationContext, exc: BaseException, *,
                          rate_wait_ms: float, admission_wait_ms: float,
                          provider_ms: float) -> NoReturn:
    common = {"units": ctx.unit_count, "rateWaitMs": rate_wait_ms,
              "admissionWaitMs": admission_wait_ms, "providerMs": provider_ms}
    if isinstance(exc, AdmissionRejected):
        detail = error_payload(
            code="server_busy", message=str(exc),
            user_message="The AI service is busy. Please try again shortly.", origin="api",
            stage="ai_admission", category="capacity", retryable=True, http_status=503,
            trace_id=ctx.trace_id,
            extra={"retryAfterMs": int(exc.retry_after_sec * 1000), "providerAttempts": 0,
                   "generationAttempts": 0, "automaticContentRetry": False,
                   "automaticTransportRetry": False}, correlation=dict(ctx.correlation),
        )
        failure_event(ctx.requested_route, detail, **ctx.route_identity)
        trace_failure(ctx, "admission_gate", exc, 503, **common,
                      requestedProvider=ctx.config.provider, requestedModel=ctx.config.model,
                      providerAttempts=0)
        raise HTTPException(503, detail=detail,
                            headers={"Retry-After": str(exc.retry_after_sec)}) from exc
    if isinstance(exc, OutputCapabilityChanged):
        detail = error_payload(
            code=exc.code, message=str(exc),
            user_message="ข้อมูลความสามารถโมเดลเปลี่ยน กรุณารีเฟรชรายชื่อโมเดลก่อนแปล ยังไม่ได้เรียก AI",
            origin="api", stage="ai_contract_preflight", category="configuration",
            retryable=False, http_status=409, trace_id=ctx.trace_id,
            extra={"requestDispatched": False, "providerAttempts": 0, "generationAttempts": 0,
                   "automaticContentRetry": False, "automaticTransportRetry": False},
            correlation=dict(ctx.correlation),
        )
        trace_failure(ctx, "ai_contract_preflight", exc, 409, **common,
                      providerAttempts=0, generationAttempts=0)
        failure_event(ctx.requested_route, detail, **ctx.route_identity)
        raise HTTPException(409, detail=detail) from exc
    if isinstance(exc, WorkloadBudgetError):
        detail = error_payload(
            code="ai_workload_budget_insufficient", message=str(exc),
            user_message="Prompt และคำตอบที่ประเมินไว้เกินงบของโมเดล ยังไม่ได้ส่งคำขอให้ Provider",
            origin="api", stage="ai_workload_preflight", category="capacity",
            retryable=False, http_status=400, trace_id=ctx.trace_id,
            extra={"requestDispatched": False, "providerAttempts": 0, "generationAttempts": 0,
                   "automaticContentRetry": False, "automaticTransportRetry": False},
            correlation=dict(ctx.correlation),
        )
        trace_failure(ctx, "ai_workload_preflight", exc, 400, **common,
                      providerAttempts=0, generationAttempts=0)
        failure_event(ctx.requested_route, detail, **ctx.route_identity)
        raise HTTPException(400, detail=detail) from exc
    if isinstance(exc, (SecurityError, ValueError)):
        stage = "provider_security" if isinstance(exc, SecurityError) else "provider_validation"
        trace_failure(ctx, stage, exc, 400, **common,
                      requestedProvider=ctx.config.provider, requestedModel=ctx.config.model,
                      providerAttempts=0)
        raise HTTPException(400, detail=invalid_detail(ctx, str(exc), stage)) from exc
    if isinstance(exc, ProviderGenerationCancelled):
        providers, generations = provider_call_counts(exc)
        trace_failure(ctx, "cancelled", exc, 409, units=ctx.unit_count,
                      providerMs=provider_ms, providerAttempts=providers,
                      generationAttempts=generations)
        detail = cancelled_payload(trace_id=ctx.trace_id, stage="ai_cancel", correlation=dict(ctx.correlation))
        detail.update(providerAttempts=providers, generationAttempts=generations,
                      requestDispatched=getattr(exc, "requestDispatched", False))
        if getattr(exc, "generationMeta", None):
            detail["structuralDetails"] = {"generationMeta": exc.generationMeta}
        raise HTTPException(409, detail=detail) from exc
    if isinstance(exc, ModelOutputContractError):
        structural = dict(getattr(exc, "structural_details", {}) or {})
        providers, generations = provider_call_counts(exc)
        trace_failure(ctx, "model_output_contract", exc, 502, **common,
                      chars=ctx.char_count, pageImage=bool(ctx.config.image_b64),
                      requestedProvider=ctx.config.provider, requestedModel=ctx.config.model,
                      resolvedProvider=structural.get("resolvedProvider", ctx.resolved_provider),
                      resolvedModel=structural.get("resolvedModel", ctx.resolved_model),
                      outputContractRequested="id_markers", structuralDetails=structural,
                      providerAttempts=providers, generationAttempts=generations,
                      providerHttpStatuses=[200])
        budget = isinstance(exc, OutputBudgetExhausted)
        code = ("output_budget_exhausted" if budget else
                "AI_OUTPUT_CONTRACT_MISMATCH" if getattr(exc, "code", "") == "AI_OUTPUT_CONTRACT_MISMATCH"
                else "invalid_model_output")
        detail = error_payload(
            code=code, message=str(exc),
            user_message=("AI used its output limit before completing the translation." if budget
                          else "The AI response was incomplete or unreadable for this image."),
            origin="upstream_ai", stage="model_output_contract", category="upstream_contract",
            retryable=False, http_status=502, trace_id=ctx.trace_id, upstream_status=200,
            extra={"error": code, "structuralDetails": structural,
                   "providerAttempts": providers, "generationAttempts": generations,
                   "automaticContentRetry": False, "automaticTransportRetry": False,
                   "modelFallback": False, "schemaFallback": False},
            correlation=dict(ctx.correlation),
        )
        failure_event(ctx.requested_route, detail, **ctx.route_identity)
        raise HTTPException(502, detail=detail) from exc
    _raise_provider_failure(ctx, exc, rate_wait_ms, admission_wait_ms, provider_ms)

def _raise_provider_failure(ctx: TranslationContext, exc: BaseException,
                            rate_wait_ms: float, admission_wait_ms: float,
                            provider_ms: float) -> NoReturn:
    if isinstance(exc, TypeError):
        exc = ProviderAdapterContractError(
            "TextPhantom provider adapter rejected the router call signature")
    semantics = provider_http_failure(exc)
    limited = semantics.code == "provider_rate_limited"
    retry_sec = retry_after_sec(exc) if limited else 0.0
    if ctx.rate["enabled"] and not ctx.unlimited and limited:
        rate_gate.report_rate_limited(ctx.resolved_provider, ctx.config.model,
                                     ctx.config.api_key, retry_after_sec=retry_sec)
    upstream = provider_status(exc)
    providers, generated = provider_call_counts(exc)
    generations = 0 if limited or (upstream is not None and 400 <= upstream < 500) else generated
    code, status = semantics.code, int(semantics.status)
    stage = "provider_adapter" if code == "provider_client_contract_error" else "provider_request"
    trace_failure(ctx, stage, exc, status, units=ctx.unit_count, chars=ctx.char_count,
                  pageImage=bool(ctx.config.image_b64),
                  timing={"rateWaitMs": rate_wait_ms, "admissionWaitMs": admission_wait_ms,
                          "providerMs": provider_ms},
                  requested={"provider": ctx.config.provider, "model": ctx.config.model},
                  resolved={"provider": ctx.resolved_provider, "model": ctx.resolved_model},
                  outputContractRequested="id_markers", providerAttempts=providers,
                  generationAttempts=generations)
    internal = code in {"provider_client_contract_error", "internal_error"}
    detail = error_payload(
        code=code, message=semantics.message,
        user_message=PUBLIC_MESSAGES.get(code, PUBLIC_MESSAGES["provider_failed"]),
        origin="api" if internal else "upstream_ai", stage=stage,
        category="internal" if internal else "upstream", retryable=semantics.retryable,
        http_status=status, trace_id=ctx.trace_id, upstream_status=upstream,
        extra={"providerAttempts": providers, "generationAttempts": generations,
               "automaticContentRetry": False, "automaticTransportRetry": False,
               "modelFallback": False, "schemaFallback": False,
               "provider": str(ctx.resolved_provider or "")[:64],
               "model": str(ctx.resolved_model or "")[:160],
               "providerCode": str(getattr(exc, "provider_code", "") or "")[:80],
               "providerType": str(getattr(exc, "provider_type", "") or "")[:80],
               "providerReason": semantics.message, "failureKind": code},
        correlation=dict(ctx.correlation),
    )
    headers = None
    if limited:
        retry_sec = max(1.0, float(retry_sec or 1.0))
        detail["retryAfterMs"] = int(retry_sec * 1000)
        headers = {"Retry-After": str(max(1, math.ceil(retry_sec)))}
    failure_event(ctx.requested_route, detail, **ctx.route_identity)
    raise HTTPException(status, detail=detail, headers=headers) from exc
