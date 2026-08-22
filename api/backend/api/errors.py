"""Stable, compact and safe API error contract.

The public shape is additive: existing callers may keep reading ``message``,
``stage`` and route-specific aliases while newer callers key on ``schema`` and
``code``.  This module deliberately accepts only already-sanitised metadata;
raw exception/provider response text must never be passed as ``extra``.
"""

from __future__ import annotations

from typing import Any
import re
import socket

from backend.log import event

ERROR_SCHEMA = "tp.error/1"
_RESERVED = {
    "schema", "code", "message", "userMessage", "origin", "stage",
    "failedStage", "category", "retryable", "httpStatus", "traceId",
    "upstreamStatus",
}


def payload(
    *, code: str, message: str, user_message: str, origin: str, stage: str,
    category: str, retryable: bool, http_status: int, trace_id: str = "",
    upstream_status: int | None = None, extra: dict[str, Any] | None = None,
    correlation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the one public error shape without secret-bearing raw details."""
    out: dict[str, Any] = {
        "schema": ERROR_SCHEMA,
        "code": str(code),
        "message": str(message),
        "userMessage": str(user_message or message),
        "origin": str(origin),
        "stage": str(stage),
        # Alias retained because early builds called this field failedStage.
        "failedStage": str(stage),
        "category": str(category),
        "retryable": bool(retryable),
        "httpStatus": int(http_status),
        "traceId": str(trace_id or ""),
    }
    if upstream_status is not None:
        out["upstreamStatus"] = int(upstream_status)
    if correlation:
        for key in ("requestId", "jobId", "batchId", "imageId", "clientVersion"):
            value = correlation.get(key)
            if value not in (None, ""):
                out[key] = str(value)
    if extra:
        # Canonical fields cannot be overwritten by a legacy alias/metadata
        # dict. In particular `origin` always means failure provenance; `actor`
        # may remain as a legacy alias but can never redefine it.
        out.update({key: value for key, value in extra.items() if key not in _RESERVED})
    return out


def failure_event(route: str, detail: dict[str, Any], **safe_meta: Any) -> None:
    """Emit exactly the fields an operator needs in one short terminal line."""
    event(
        "error.request",
        {
            "route": route,
            "code": detail.get("code", "internal_error"),
            "origin": detail.get("origin", "api"),
            "stage": detail.get("stage", "unknown"),
            "category": detail.get("category", "internal"),
            "status": detail.get("httpStatus", 500),
            "upstreamStatus": detail.get("upstreamStatus"),
            "retryable": detail.get("retryable", False),
            "traceId": detail.get("traceId", ""),
            "requestId": detail.get("requestId"),
            "jobId": detail.get("jobId"),
            "batchId": detail.get("batchId"),
            "imageId": detail.get("imageId"),
            "clientVersion": detail.get("clientVersion"),
            **{key: value for key, value in safe_meta.items() if value not in (None, "")},
        },
        ok=False,
    )


def provider_status(exc: BaseException) -> int | None:
    """Extract an upstream HTTP status from the clients' sanitised messages."""
    import re

    match = re.search(r"\bHTTP\s+(\d{3})\b", str(exc), re.IGNORECASE)
    return int(match.group(1)) if match else None


def provider_http_semantics(status: int | None) -> tuple[str, bool]:
    """Stable code/retry decision for an upstream HTTP response.

    The API keeps its existing outward status.  This only stops permanent 4xx
    responses (notably a too-large image/prompt) being advertised as retryable.
    """
    if status == 413:
        return "provider_payload_too_large", False
    if status in (401, 403):
        return "provider_auth_failed", False
    if status is not None and 400 <= status < 500 and status not in (408, 425, 429):
        return "provider_http", False
    return "provider_http", status in (408, 425, 429, 500, 502, 503, 504)


def origin_for(stage: str, code: str = "") -> str:
    """Infer provenance from the failing pipeline stage before generic code."""
    value = str(stage or "").lower()
    if value.startswith("lens") or "lens_" in value:
        return "upstream_lens"
    if value in {"image_fetch", "image_download", "download_image"}:
        return "upstream_image"
    if any(marker in value for marker in ("provider", "model", "ai_")):
        return "upstream_ai"
    if str(code).startswith("provider_") and not value:
        return "upstream_ai"
    return "api"


def stage_failure_semantics(
    stage: str, *, default_code: str, default_message: str,
    default_retryable: bool, upstream_status: int | None = None,
) -> dict[str, Any]:
    """Map full-pipeline failures by the stage that actually failed.

    A generic HTTP-shaped exception is not necessarily an AI provider error:
    the full pipeline also downloads an image and calls Lens.  Stage therefore
    takes precedence over wording/classification inherited from the AI helper.
    """
    value = str(stage or "").lower()
    permanent_4xx = (upstream_status is not None and 400 <= upstream_status < 500
                     and upstream_status not in (408, 425, 429))
    stage_retryable = False if permanent_4xx else bool(
        default_retryable or upstream_status is None or
        upstream_status in (408, 425, 429, 500, 502, 503, 504)
    )
    if value.startswith("lens") or "lens_" in value:
        return {
            "code": "lens_http_error" if upstream_status else "lens_transport_error",
            "message": "Google Lens could not complete the image request.",
            "origin": "upstream_lens", "category": "upstream_lens",
            "retryable": stage_retryable,
            "httpStatus": 502,
        }
    if value in {"image_fetch", "image_download", "download_image"}:
        return {
            "code": "image_fetch_http_error" if upstream_status else "image_fetch_failed",
            "message": "The source image could not be downloaded.",
            "origin": "upstream_image", "category": "image_fetch",
            "retryable": stage_retryable,
            "httpStatus": 502,
        }
    return {
        "code": str(default_code), "message": str(default_message),
        "origin": origin_for(stage, default_code),
        "category": "upstream" if str(default_code).startswith("provider_") else "internal",
        "retryable": bool(default_retryable),
        "httpStatus": None,
    }


def ai_rate_feedback_allowed(stage: str) -> bool:
    """Only an identified AI/provider stage may tune the AI quota gate."""
    value = str(stage or "").lower()
    return any(marker in value for marker in ("provider", "ai_", "model"))


def future_result_with_stage(future: Any, stage: str) -> Any:
    """Return a worker result, stamping its exception only when still unnamed.

    ConcurrentFuture re-raises the same exception object created in its worker.
    Stamping at the ownership/join boundary identifies the AI provider task
    without overwriting a more specific stage assigned inside that task.
    """
    try:
        return future.result()
    except BaseException as exc:
        if not getattr(exc, "tp_stage", None):
            try:
                exc.tp_stage = str(stage)  # type: ignore[attr-defined]
            except Exception:
                pass
        raise


def safe_cause_class(exc: BaseException) -> str:
    """Coarse, non-secret diagnostic class for an internal exception."""
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, ConnectionError):
        return "connection"
    if isinstance(exc, OSError):
        if getattr(exc, "errno", None) in {
            getattr(socket, "EAI_AGAIN", object()),
            getattr(socket, "EAI_FAIL", object()),
            getattr(socket, "EAI_NONAME", object()),
        }:
            return "dns"
        return "os"
    if isinstance(exc, (UnicodeError, ValueError)):
        return "decode_or_value"
    return "internal"


def safe_validation_reason(detail: Any) -> dict[str, str]:
    """Return bounded validation metadata without rejected input values."""
    if isinstance(detail, list) and detail and isinstance(detail[0], dict):
        first = detail[0]
        loc = first.get("loc") if isinstance(first.get("loc"), (list, tuple)) else ()
        field = ".".join(str(part) for part in loc if part not in ("body",))[:120]
        return {"field": field, "reason": str(first.get("type") or "invalid")[:80]}
    text = re.sub(r"\s+", " ", str(detail or "invalid request")).strip().lower()
    field_match = re.search(r"`([a-zA-Z0-9_.-]{1,80})`", text)
    reason = (
        "required" if "required" in text else
        "unsupported" if "unsupported" in text or "not supported" in text else
        "too_large" if "too large" in text or "maximum" in text else
        "invalid_type" if "must be" in text or "expected" in text else
        "invalid"
    )
    return {"field": field_match.group(1) if field_match else "", "reason": reason}


def validation_error_payload(
    errors: Any, *, trace_id: str = "",
    correlation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Canonical 422 response containing no rejected input or Pydantic context."""
    safe_errors: list[dict[str, Any]] = []
    if isinstance(errors, list):
        for item in errors[:20]:
            if not isinstance(item, dict):
                continue
            loc = item.get("loc") if isinstance(item.get("loc"), (list, tuple)) else ()
            safe_errors.append({
                "loc": [str(part)[:80] for part in loc],
                "type": str(item.get("type") or "invalid")[:80],
            })
    return payload(
        code="invalid_request", message="Request validation failed.",
        user_message="The request data is invalid.", origin="client",
        stage="request_validation", category="input", retryable=False,
        http_status=422, trace_id=trace_id,
        extra={"validation": safe_validation_reason(errors), "validationErrors": safe_errors},
        correlation=correlation,
    )


def request_correlation(request: Any) -> dict[str, str]:
    """Correlation available without consuming or logging a request body."""
    headers = getattr(request, "headers", {})
    query = getattr(request, "query_params", {})
    pairs = {
        "requestId": headers.get("x-tp-request-id") or headers.get("x-request-id"),
        "jobId": headers.get("x-tp-job-id"),
        "batchId": headers.get("x-tp-batch-id") or query.get("batch_id"),
        "imageId": headers.get("x-tp-image-id") or query.get("image_id"),
        "clientVersion": headers.get("x-tp-client-version") or headers.get("x-client-version"),
    }
    return {key: str(value)[:160] for key, value in pairs.items() if value not in (None, "")}


def merged_request_correlation(
    request: Any, fallback: dict[str, Any] | None = None,
) -> dict[str, str]:
    """Merge legacy body IDs with authoritative per-request HTTP headers.

    Older clients do not send the optional ``X-TP-*`` headers, so route/body
    values remain useful fallbacks.  New clients mint a distinct request ID
    for every HTTP attempt; those headers must win over operation/idempotency
    IDs that describe a wider unit of work.
    """
    merged = {
        key: str(value)[:160]
        for key, value in (fallback or {}).items()
        if key in {"requestId", "jobId", "batchId", "imageId", "clientVersion"}
        and value not in (None, "")
    }
    merged.update(request_correlation(request))
    return merged


def cancelled_payload(*, trace_id: str = "", stage: str = "cancel",
                      correlation: dict[str, Any] | None = None) -> dict[str, Any]:
    """Canonical lifecycle outcome; callers must not emit it as an error event."""
    return payload(
        code="cancelled", message="The request was cancelled.",
        user_message="The request was cancelled.", origin="client", stage=stage,
        category="lifecycle", retryable=False, http_status=409,
        trace_id=trace_id, correlation=correlation,
    )
