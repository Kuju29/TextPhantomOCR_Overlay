"""Public and trace-safe mappings for provider execution failures."""

from __future__ import annotations

from typing import Any, NoReturn
from fastapi import HTTPException

import math

from backend import trace
from backend.ai.clients.base import OutputBudgetExhausted, ProviderGenerationCancelled
from backend.ai.clients.provider_error import (ProviderAdapterContractError,
                                               structured_upstream_http_status)
from backend.ai.errors import ModelOutputContractError
from backend.ai.workload import WorkloadBudgetError
from backend.ai.capabilities import OutputCapabilityChanged
from backend.ai.cloud_reasoning import CloudReasoningPreferenceUnavailable
from backend.ai.translation_paths.store import ConversationError
from backend.ai.failure_reason import classify, provider_http_failure, retry_after_sec
from backend.ai.rategate import rate_gate
from backend.ai.rate_policy import rate_bucket_identity
from backend.api.errors import (
    cancelled_payload, failure_event, payload as error_payload, provider_status,
    safe_validation_reason,
)
from backend.jobs.admission import AdmissionRejected
from backend.security import SecurityError
from backend.application.ai_translation.context import TranslationContext

PUBLIC_MESSAGES = {
    "paid_database_unavailable": "ฐานข้อมูล Center ขัดข้อง ยังยืนยันสถานะคำขอ Paid ไม่ได้ กรุณาตรวจคำขอเดิมและประวัติเครดิตก่อนเริ่มใหม่",
    "paid_login_required": "session ของบัญชี Paid หมดอายุหรือถูกยกเลิก กรุณาเข้าสู่ระบบอีกครั้ง",
    "paid_provider_route": "โมเดล Paid นี้ไม่พร้อมใช้งาน กรุณาติดต่อฝ่ายสนับสนุนพร้อมรหัสอ้างอิง",
    "paid_provider_auth": "บริการ Paid ไม่พร้อมใช้งาน กรุณาติดต่อฝ่ายสนับสนุน",
    "paid_provider_balance": "บริการ Paid ไม่พร้อมรับคำขอขณะนี้ ยอดเครดิตของคุณไม่ได้เป็นสาเหตุ",
    "paid_provider_forbidden": "บริการ Paid ไม่สามารถทำคำขอนี้ได้ กรุณาติดต่อฝ่ายสนับสนุนพร้อมรหัสอ้างอิง",
    "paid_provider_request": "บริการ Paid ไม่รับคำขอนี้ กรุณาติดต่อฝ่ายสนับสนุนพร้อมรหัสอ้างอิง",
    "paid_provider_limited": "ผู้ให้บริการ AI จำกัดคำขอ Paid ชั่วคราว ตรวจคำขอเดิมก่อนลองใหม่",
    "paid_provider_capacity": "บริการ AI มีงานเต็มชั่วคราว กรุณาลองใหม่ภายหลัง ยอด TP ของคุณไม่ใช่สาเหตุ",
    "paid_provider_failed": "บริการ Paid ทำคำขอนี้ไม่สำเร็จ กรุณาตรวจคำขอเดิมหรือติดต่อฝ่ายสนับสนุน",
    "provider_auth_failed": "API key ถูกปฏิเสธ กรุณาตรวจสอบคีย์และ Provider",
    "provider_quota_exhausted": "โควตาหรือเครดิต AI หมด",
    "billing_required": "Provider ต้องการตั้งค่าการชำระเงิน",
    "provider_rate_limited": "Provider จำกัดอัตราหรือโควตาตามเวลา (ไม่ใช่ max_tokens ของคำขอเดียว)",
    "provider_model_not_found": "ไม่พบโมเดลที่เลือกใน Provider",
    "provider_model_access_denied": "บัญชีนี้ไม่มีสิทธิ์ใช้โมเดลที่เลือก",
    "provider_region_unsupported": "Provider ไม่ให้บริการในภูมิภาคของบัญชีนี้",
    "provider_content_blocked": "Provider ปฏิเสธเนื้อหานี้",
    "provider_payload_too_large": "Prompt หรือข้อความยาวเกินขีดจำกัดของ Provider",
    "provider_timeout": "Provider ตอบช้าเกินเวลา",
    "ai_provider_stalled": "ผู้ให้บริการ AI หยุดตอบกลับ (ไม่มีการคิดหรือข้อความ) จึงหยุดคำขอนี้",
    "ai_thinking_too_long": "AI คิดนานเกินงบเวลาโดยยังไม่เริ่มตอบ ลองลดระดับการคิดหรือเลือกโมเดลที่เร็วกว่า",
    "ai_output_no_progress": "AI เขียนต่อเนื่องแต่ไม่มีบรรทัดแปลใหม่เสร็จ จึงหยุดคำขอนี้ บรรทัดที่เสร็จแล้วยังถูกเก็บไว้",
    "ai_stream_ceiling": "คำตอบของ AI ใช้เวลาเกินเพดานความปลอดภัย จึงหยุดคำขอนี้",
    "provider_transport": "ติดต่อ Provider ไม่สำเร็จ",
    "invalid_model_output": "AI ตอบกลับไม่ครบตามรูปแบบที่ต้องใช้",
    "invalid_output_contract": "AI ตอบกลับในรูปแบบที่ระบบอ่านไม่ได้",
    "provider_client_contract_error": "ตัวเชื่อม Provider ภายใน TextPhantom ไม่เข้ากัน กรุณาอัปเดตระบบ",
    "provider_http": "Provider ปฏิเสธคำขอนี้",
    "provider_failed": "Provider ทำคำขอนี้ไม่สำเร็จ โปรดดู Trace ID",
    "internal_error": "TextPhantom เกิดข้อผิดพลาดภายใน โปรดดู Trace ID",
}

def _owned_paid_replay_meta(exc: BaseException) -> dict[str, Any] | None:
    structural = getattr(exc, "structural_details", {})
    structural = structural if isinstance(structural, dict) else {}
    meta = getattr(exc, "generationMeta", None)
    if not isinstance(meta, dict):
        meta = structural.get("generationMeta")
    if not isinstance(meta, dict):
        return None
    usage = meta.get("usage")
    if (meta.get("provider") == "paid" and meta.get("centerOperationReplayed") is True
            and meta.get("requestDispatched") is False
            and type(meta.get("generationAttempts")) is int and meta["generationAttempts"] == 0
            and type(meta.get("providerAttempts")) is int and meta["providerAttempts"] == 0
            and isinstance(usage, dict) and usage.get("centerOperationReplayed") is True):
        return meta
    return None


def provider_call_counts(exc: BaseException, default: int = 1, *,
                         allow_paid_replay: bool = False) -> tuple[int, int]:
    if allow_paid_replay and _owned_paid_replay_meta(exc) is not None:
        return 0, 0
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
    from backend.ai.login.login_provider_contract import LoginError
    upstream = getattr(exc, 'upstream_status', None) if isinstance(exc, LoginError) else provider_status(exc)
    provider_attempts = int(details.pop("providerAttempts", 0) or 0)
    generation_attempts = int(details.pop("generationAttempts", provider_attempts) or 0)
    trace.write("api", "api/routes/ai_v1.py", "ai_translate_v1", "!!", {
        "stage": stage, "failureKind": classify(exc), "errorType": type(exc).__name__,
        "error": str(exc), "httpStatus": status, "automaticContentRetry": False,
        "automaticTransportRetry": False, "providerAttempts": provider_attempts,
        "generationAttempts": generation_attempts,
        "providerHttpStatuses": [upstream] if upstream is not None else [],
        "upstreamStatus": upstream,
        "modelFallback": False, "schemaFallback": False, **ctx.route_identity, **details,
    }, trace_id=ctx.trace_id)

def raise_execution_error(ctx: TranslationContext, exc: BaseException, *,
                          rate_wait_ms: float, admission_wait_ms: float,
                          provider_ms: float) -> NoReturn:
    common = {"units": ctx.unit_count, "rateWaitMs": rate_wait_ms,
              "admissionWaitMs": admission_wait_ms, "providerMs": provider_ms}
    from backend.ai.login.login_provider_registry import LoginError
    if isinstance(exc, LoginError):
        dispatched = exc.requestDispatched is True
        from backend.ai.login.endpoint.login_endpoint_http import ENDPOINT_STEPS
        login_metadata = {}
        if getattr(exc, 'endpoint_step', '') in ENDPOINT_STEPS:
            login_metadata['endpointStep'] = exc.endpoint_step
        from backend.ai.login.login_http import PROVIDER_REASONS
        reason = getattr(exc, 'provider_reason', '')
        if isinstance(reason, str) and reason in PROVIDER_REASONS:
            login_metadata['providerReason'] = reason
        if getattr(exc, 'identity_verified', None) is True:
            login_metadata['identityVerified'] = True
        delay = getattr(exc, 'retry_after_ms', None)
        if type(delay) is int and 0 <= delay <= 300000:
            login_metadata['retryAfterMs'] = delay
        # A page stopped because an earlier sent page of the same run failed
        # sent nothing itself, but reports that page's provider outcome; it is
        # not an authorization/configuration fault of TextPhantom.
        earlier = getattr(exc, 'earlier_page_failed', False) is True
        if earlier:
            login_metadata['earlierPageFailed'] = True
        provider_side = dispatched or earlier or exc.code == 'login_provider_temporarily_unavailable'
        detail = error_payload(code=exc.code, message=str(exc), user_message=str(exc),
            origin="upstream_ai" if provider_side else "api",
            stage="login_provider" if dispatched else "login_run_stopped" if earlier else
                "login_provider_validation" if provider_side else "login_authorization",
            category="policy" if exc.code in {'login_content_refused', 'login_endpoint_challenge_required',
                'login_endpoint_native_preparation_required'} else ("upstream" if provider_side else "configuration"),
            retryable=getattr(exc, 'retryable', False) is True,
            http_status=exc.status, trace_id=ctx.trace_id, upstream_status=getattr(exc, 'upstream_status', None),
            extra={"requestDispatched": dispatched, "providerAttempts": int(dispatched), "generationAttempts": int(dispatched),
                "automaticContentRetry": False, "automaticTransportRetry": False, "billingAuthority": "own_login_account", **login_metadata},
            correlation=dict(ctx.correlation))
        trace_failure(ctx, detail["stage"], exc, exc.status, **common, providerAttempts=int(dispatched), generationAttempts=int(dispatched))
        failure_event(ctx.requested_route, detail, **ctx.route_identity)
        raise HTTPException(exc.status, detail=detail) from exc
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
    if isinstance(exc, CloudReasoningPreferenceUnavailable):
        detail = error_payload(
            code=exc.code, message=str(exc),
            user_message=(
                "ยังยืนยันไม่ได้ว่าโมเดลนี้ปิด Thinking ได้ เลือกโมเดลที่ยืนยันว่า Off ใช้งานได้ หรือ Lowest available เมื่อรองรับ"
                if exc.requested == "off" else
                "ยังยืนยันโหมด Thinking ต่ำสุดของโมเดลนี้ไม่ได้ เลือกโมเดลที่รองรับการตั้งค่า Thinking"
                if exc.requested == "minimum" else
                f"ยังยืนยันไม่ได้ว่าโมเดลนี้รองรับ Thinking {exc.requested} เลือกโมเดลที่รองรับโหมดนี้"
            ),
            origin="api", stage="ai_reasoning_preflight", category="configuration",
            retryable=False, http_status=409, trace_id=ctx.trace_id,
            extra={"requestDispatched": False, "providerAttempts": 0,
                   "generationAttempts": 0, "automaticContentRetry": False,
                   "automaticTransportRetry": False},
            correlation=dict(ctx.correlation),
        )
        trace_failure(ctx, "ai_reasoning_preflight", exc, 409, **common,
                      providerAttempts=0, generationAttempts=0)
        failure_event(ctx.requested_route, detail, **ctx.route_identity)
        raise HTTPException(409, detail=detail) from exc
    if isinstance(exc, ConversationError) and getattr(exc, "code", "") in {
            "ai_local_thinking_unsupported", "ai_conversation_cursor_missing"}:
        preflight_stage = ("ai_conversation_preflight" if exc.code == "ai_conversation_cursor_missing"
                           else "ai_reasoning_preflight")
        detail = error_payload(
            code=exc.code, message=str(exc),
            user_message=("ประวัติ LM Studio ไม่มีรหัสเชื่อมบทสนทนาที่ผ่านการตรวจ กรุณาเริ่มบทสนทนาใหม่"
                if exc.code == "ai_conversation_cursor_missing" else
                "โมเดล Local AI นี้ยังยืนยันโหมด Thinking ที่เลือกไม่ได้ กรุณาโหลดโมเดลที่รองรับและรีเฟรชข้อมูลโมเดล"),
            origin="api", stage=preflight_stage, category="configuration",
            retryable=False, http_status=409, trace_id=ctx.trace_id,
            extra={"requestDispatched":False, "providerAttempts":0, "generationAttempts":0,
                   "automaticContentRetry":False, "automaticTransportRetry":False},
            correlation=dict(ctx.correlation),
        )
        trace_failure(ctx, preflight_stage, exc, 409, **common,
                      providerAttempts=0, generationAttempts=0)
        failure_event(ctx.requested_route, detail, **ctx.route_identity)
        raise HTTPException(409, detail=detail) from exc
    if isinstance(exc, WorkloadBudgetError):
        detail = error_payload(
            code="ai_workload_budget_insufficient", message=str(exc),
            user_message="Prompt และคำตอบที่ประเมินไว้เกินงบต่อคำขอ ยังไม่ได้ส่ง AI ไม่ใช่การแย่งโทเค็นกับภาพอื่น",
            origin="api", stage="ai_workload_preflight", category="capacity",
            retryable=False, http_status=400, trace_id=ctx.trace_id,
            extra={"constraintScope":"per_request", "budgetDiagnostic":getattr(exc,"diagnostics",{}), "requestDispatched": False, "providerAttempts": 0, "generationAttempts": 0,
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
        providers, generations = ((0, 0) if getattr(exc, "preDispatchCancelled", False)
                                 else provider_call_counts(exc))
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
        browser_webchat = ctx.config.provider == "login" and str(ctx.config.model).endswith("/web-current")
        retained_paid = ctx.config.provider == "paid" and _owned_paid_replay_meta(exc) is not None
        providers, generations = provider_call_counts(exc, allow_paid_replay=retained_paid)
        trace_failure(ctx, "model_output_contract", exc, 502, **common,
                      chars=ctx.char_count, pageImage=bool(ctx.config.image_b64),
                      requestedProvider=ctx.config.provider, requestedModel=ctx.config.model,
                      resolvedProvider=structural.get("resolvedProvider", ctx.resolved_provider),
                      resolvedModel=structural.get("resolvedModel", ctx.resolved_model),
                      outputContractRequested="id_markers", structuralDetails=structural,
                      providerAttempts=providers, generationAttempts=generations,
                      providerHttpStatuses=[] if browser_webchat else [200])
        budget = isinstance(exc, OutputBudgetExhausted)
        code = ("output_budget_exhausted" if budget else
                "AI_OUTPUT_CONTRACT_MISMATCH" if getattr(exc, "code", "") == "AI_OUTPUT_CONTRACT_MISMATCH"
                else exc.code if getattr(exc, "code", "") in {
                    "ai_conversation_native_transcript_invalid", "ai_conversation_cursor_missing",
                    "ai_local_thinking_violated"}
                else "invalid_model_output")
        detail = error_payload(
            code=code, message=str(exc),
            user_message=("คำขอนี้ชนเพดานคำตอบก่อนแปลครบ (รวม reasoning ถ้ามี) ไม่ใช่เพดานรวมภาพขนาน" if budget
                          else "LM Studio ตอบกลับในรูปแบบที่เก็บเป็นบทสนทนาต่อไม่ได้ กรุณาลองส่งคำขอนี้ใหม่" if code == "ai_conversation_native_transcript_invalid"
                          else "LM Studio ไม่ส่งรหัสเชื่อมบทสนทนา จึงยังรับคำแปลรอบนี้ไม่ได้" if code == "ai_conversation_cursor_missing"
                          else "Local AI ส่ง Thinking กลับมาแม้เลือก Off กรุณาตรวจการตั้งค่าโมเดล" if code == "ai_local_thinking_violated"
                          else "AI ตอบ ID ไม่ครบหรือรูปแบบผิด ยังไม่มีหลักฐานว่าชนเพดานโทเค็น"),
            origin="upstream_ai", stage="model_output_contract", category="upstream_contract",
            retryable=False, http_status=502, trace_id=ctx.trace_id, upstream_status=None if browser_webchat else 200,
            extra={"error": code, "constraintScope":"per_request" if budget else "output_contract", "structuralDetails": structural,
                   "requestDispatched":not retained_paid,
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
    if (getattr(exc, "provider", "") == "paid"
            and getattr(exc, "centerAdmissionRejected", False) is True):
        # A typed Center admission refusal proves no AI dispatch for this
        # operation. Unknown/upstream HTTP errors deliberately keep the
        # ordinary provider/uncertain classification below.
        stage = "paid_admission"
        trace_failure(ctx, stage, exc, semantics.status, units=ctx.unit_count,
                      timing={"rateWaitMs": rate_wait_ms,
                              "admissionWaitMs": admission_wait_ms,
                              "providerMs": provider_ms},
                      providerAttempts=0, generationAttempts=0,
                      centerRequestDispatched=True, requestDispatched=False,
                      providerHttpStatuses=[], upstreamStatus=None,
                      centerHttpStatus=semantics.status)
        detail = error_payload(
            code=semantics.code, message=semantics.message,
            user_message=PUBLIC_MESSAGES.get(semantics.code, semantics.message),
            origin="control_center", stage=stage, category="admission",
            retryable=False, http_status=semantics.status, trace_id=ctx.trace_id,
            extra={"requestDispatched": False, "centerRequestDispatched": True,
                   "creditReserved": False, "providerAttempts": 0,
                   "generationAttempts": 0, "providerHttpStatuses": [],
                   "automaticContentRetry": False, "automaticTransportRetry": False,
                   "modelFallback": False, "schemaFallback": False,
                   "constraintScope": "account_admission"},
            correlation=dict(ctx.correlation),
        )
        failure_event(ctx.requested_route, detail, **ctx.route_identity)
        raise HTTPException(semantics.status, detail=detail) from exc
    if getattr(exc, "provider", "") == "paid" and getattr(exc, "provider_code", "") == "DATABASE_UNAVAILABLE":
        # A database error can precede reservation OR follow a billed provider
        # response. It proves neither zero calls nor one actual generation.
        evidence = {"centerRequestDispatched": True, "centerHttpStatus": provider_status(exc),
                    "centerRequestId": str(getattr(exc, "centerRequestId", ""))[:80],
                    "providerDispatchEvidence": "unconfirmed", "requestDispatched": None,
                    "providerAttempts": None, "generationAttempts": None,
                    "creditState": "unconfirmed", "automaticContentRetry": False,
                    "automaticTransportRetry": False, "modelFallback": False, "schemaFallback": False}
        stage = "paid_database"
        trace.write("api", "api/routes/ai_v1.py", "ai_translate_v1", "!!", {
            "stage": stage, "failureKind": semantics.code, "errorType": type(exc).__name__,
            "error": str(exc), "httpStatus": semantics.status, "origin": "control_center",
            "units": ctx.unit_count, "timing": {"providerMs": provider_ms,
                "rateWaitMs": rate_wait_ms, "admissionWaitMs": admission_wait_ms},
            **ctx.route_identity, **evidence}, trace_id=ctx.trace_id)
        detail = error_payload(code=semantics.code, message=semantics.message,
            user_message=PUBLIC_MESSAGES[semantics.code], origin="control_center", stage=stage,
            category="database", retryable=False, http_status=semantics.status, trace_id=ctx.trace_id,
            extra={**evidence, "provider": "paid", "model": ctx.resolved_model,
                   "centerErrorCode": "DATABASE_UNAVAILABLE"}, correlation=dict(ctx.correlation))
        failure_event(ctx.requested_route, detail, **ctx.route_identity)
        raise HTTPException(semantics.status, detail=detail) from exc
    limited = semantics.code == "provider_rate_limited"
    retry_sec = retry_after_sec(exc) if limited else 0.0
    if ctx.rate["enabled"] and not ctx.unlimited and limited:
        rate_gate.report_rate_limited(ctx.resolved_provider, ctx.config.model,
                                     rate_bucket_identity(ctx.rate, base_url=ctx.config.base_url,
                                                          api_key=ctx.config.api_key),
                                     retry_after_sec=retry_sec)
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
    http_evidence = ({"providerFailureKind": "http_status", "requestDispatched": True}
                     if structured_upstream_http_status(exc) is not None else {})
    detail = error_payload(
        code=code, message=semantics.message,
        user_message=PUBLIC_MESSAGES.get(code, PUBLIC_MESSAGES["provider_failed"]),
        origin="api" if internal else "upstream_ai", stage=stage,
        category="internal" if internal else "upstream", retryable=semantics.retryable,
        http_status=status, trace_id=ctx.trace_id, upstream_status=upstream,
        extra={"constraintScope":getattr(exc, 'provider_limit_scope', 'unknown'),
               "creditState":getattr(exc, 'center_credit_state', None),
               "upstreamProvider": str(getattr(exc, "upstream_provider", "") or "")[:80],
               "retryAfterSource": "provider_header" if retry_sec > 0 else "local_default" if limited else "not_applicable",
               "quotaKind":"not_reported", "providerAttempts": providers, "generationAttempts": generations,
               "automaticContentRetry": False, "automaticTransportRetry": False,
               "modelFallback": False, "schemaFallback": False,
               "provider": str(ctx.resolved_provider or "")[:64],
               "model": str(ctx.resolved_model or "")[:160],
               "providerCode": str(getattr(exc, "provider_code", "") or "")[:80],
               "providerType": str(getattr(exc, "provider_type", "") or "")[:80],
               "providerReason": semantics.message, "failureKind": code, **http_evidence,
               **({"streamStop": dict(exc.stream_stop), "requestDispatched": True}
                  if isinstance(getattr(exc, "stream_stop", None), dict) else {})},
        correlation=dict(ctx.correlation),
    )
    headers = None
    if limited:
        retry_sec = max(1.0, float(retry_sec or 1.0))
        detail["retryAfterMs"] = int(retry_sec * 1000)
        headers = {"Retry-After": str(max(1, math.ceil(retry_sec)))}
    failure_event(ctx.requested_route, detail, **ctx.route_identity)
    raise HTTPException(status, detail=detail, headers=headers) from exc
