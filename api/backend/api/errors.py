"""Stable, compact and safe API error contract.

The public shape is additive: existing callers may keep reading ``message``,
``stage`` and route-specific aliases while newer callers key on ``schema`` and
``code``.  This module deliberately accepts only already-sanitised metadata;
raw exception/provider response text must never be passed as ``extra``.
"""

from __future__ import annotations

from typing import Any

import hashlib, socket, re

from backend.log import event

ERROR_SCHEMA = "tp.error/1"
_RESERVED = {
    "schema", "code", "message", "userMessage", "origin", "stage",
    "failedStage", "category", "retryable", "httpStatus", "traceId",
    "upstreamStatus",
}

_CORRELATION_KEYS = (
    "traceId", "operationId", "requestId", "jobId", "batchId", "imageId",
    "runId", "taskId", "attemptId", "clientInstanceHash", "userScopeHash",
    "tabSession", "clientVersion",
)

def _bounded(value: Any, limit: int = 160) -> str:
    return str(value or "").strip()[:limit]

def _opaque_tab_session(value: Any) -> str:
    """Keep a joinable browser-session key without logging the raw identifier."""
    raw = _bounded(value, 256)
    return f"tab:{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:20]}" if raw else ""

def _opaque_scope(value: Any, label: str) -> str:
    """Never trust a client claim to already be privacy-safe."""
    raw = _bounded(value, 256)
    return f"{label}:{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:20]}" if raw else ""

def activity_incident_id(*, code: str = "", stage: str = "",
                         correlation: dict[str, Any] | None = None) -> str:
    """Stable, privacy-safe grouping key for attempts of the same failure.

    A stable operation/image is deliberately preferred over requestId (which
    changes on retry) and batchId (which may contain many independent images).
    If no correlation exists, return an empty value instead of merging unrelated
    anonymous HTTP failures into one fictional incident.
    """
    values = correlation or {}
    anchor = _bounded(values.get("operationId") or values.get("imageId")
                      or values.get("jobId") or values.get("traceId")
                      or values.get("batchId"))
    if not anchor:
        return ""
    namespace = _bounded(values.get("userScopeHash") or values.get("clientInstanceHash"), 80)
    material = "|".join((namespace, anchor, _bounded(code, 80), _bounded(stage, 80)))
    return "inc:" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:20]

def activity_fields(*, owner: str, outcome: str, severity: str, stage: str,
                    retryable: bool, scope: str, correlation: dict[str, Any] | None = None,
                    code: str = "", phase: str = "", attempt: int | None = None,
                    final: bool | None = None) -> dict[str, Any]:
    """Additive, compact classification shared by human and machine readers."""
    corr = {key: _bounded(value) for key, value in (correlation or {}).items()
            if key in _CORRELATION_KEYS and _bounded(value)}
    out: dict[str, Any] = {
        "owner": owner, "outcome": outcome, "severity": severity,
        "stage": stage, "retryable": bool(retryable), "scope": scope,
    }
    # Keep flat fields for old readers while giving new readers one complete,
    # unambiguous correlation envelope.
    out["correlation"] = {"scope": scope, **corr}
    out.update(corr)
    incident = activity_incident_id(code=code, stage=stage, correlation=corr)
    if incident:
        out["incidentId"] = incident
    if phase:
        out["phase"] = phase
    if attempt is not None:
        out["attempt"] = max(0, int(attempt))
    if final is not None:
        out["final"] = bool(final)
    return out

def classify_failure(detail: dict[str, Any], *, route: str = "") -> dict[str, Any]:
    """Classify proven ownership only; provider boundary is not root-cause blame."""
    origin = _bounded(detail.get("origin"), 80)
    category = _bounded(detail.get("category"), 80)
    stage = _bounded(detail.get("stage") or "unknown", 80)
    code = _bounded(detail.get("code") or "internal_error", 80)
    if category == "lifecycle" or code == "cancelled":
        owner, outcome, severity = "cancelled", "cancelled", "info"
    elif origin == "client" and category in {"configuration", "input"}:
        owner, outcome, severity = "user_config", "failed", "warning"
    elif origin == "upstream_image":
        owner, outcome, severity = "site_input", "failed", "warning"
    elif origin.startswith("upstream_"):
        owner, outcome, severity = "provider", "failed", "warning"
    elif origin == "api":
        owner, outcome, severity = "textphantom", "failed", "error"
    else:
        owner, outcome, severity = "unknown", "failed", "warning"
    correlation = {key: detail.get(key) for key in _CORRELATION_KEYS}
    scope = "image" if detail.get("imageId") else "batch" if detail.get("batchId") else "request"
    phase = "repair" if "/repair-runs/" in route else "initial"
    raw_attempt = detail.get("generationAttempts", detail.get("providerAttempts"))
    try:
        attempt = int(raw_attempt) if raw_attempt is not None else None
    except (TypeError, ValueError):
        attempt = None
    return activity_fields(
        owner=owner, outcome=outcome, severity=severity, stage=stage,
        retryable=bool(detail.get("retryable", False)), scope=scope,
        correlation=correlation, code=code, phase=phase, attempt=attempt,
        # This line describes one API/provider boundary attempt. The caller may
        # still run transport or content repair, so it is not a batch verdict.
        final=False,
    )

def payload_correlation(payload_data: dict[str, Any] | None, *, job_id: str = "") -> dict[str, str]:
    """Extract safe queue correlation without retaining payload content."""
    data = payload_data or {}
    metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    context = data.get("context") if isinstance(data.get("context"), dict) else {}
    return {key: value for key, value in {
        "traceId": _bounded(context.get("tp_trace") or data.get("traceId")),
        "operationId": _bounded(data.get("operationId") or metadata.get("operation_id")
                                or data.get("idempotency_key")),
        "requestId": _bounded(data.get("requestId") or data.get("request_id")),
        "jobId": _bounded(job_id or data.get("jobId") or data.get("job_id")),
        "batchId": _bounded(data.get("batchId") or data.get("batch_id")
                            or metadata.get("batch_id") or context.get("batch_id")),
        "imageId": _bounded(data.get("imageId") or data.get("image_id")
                            or metadata.get("image_id") or context.get("image_id")),
        "tabSession": _opaque_tab_session(data.get("tp_tab_session") or data.get("session")
                                          or context.get("tp_tab_session")),
        "clientVersion": _bounded(data.get("clientVersion") or data.get("client_version")
                                  or metadata.get("client_version")),
        "runId": _bounded(data.get("runId") or data.get("run_id") or metadata.get("run_id")),
        "taskId": _bounded(data.get("taskId") or data.get("task_id") or metadata.get("task_id")),
        "clientInstanceHash": _opaque_scope(data.get("clientInstanceHash") or context.get("client_instance_hash"), "client"),
        "userScopeHash": _opaque_scope(data.get("userScopeHash") or context.get("user_scope_hash"), "user"),
    }.items() if value}

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
            **{key: detail.get(key) for key in (
                "provider", "model", "providerReason", "providerAttempts",
                "generationAttempts", "requestDispatched",
            ) if detail.get(key) not in (None, "")},
            **classify_failure(detail, route=route),
            **{key: value for key, value in safe_meta.items() if value not in (None, "")},
        },
        ok=False,
    )

def provider_status(exc: BaseException) -> int | None:
    """Extract an upstream HTTP status from the clients' sanitised messages."""
    typed = getattr(exc, "status", None)
    if isinstance(typed, int) and 100 <= typed <= 599:
        return typed
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
        "operationId": headers.get("idempotency-key") or headers.get("x-tp-operation-id"),
        "jobId": headers.get("x-tp-job-id"),
        "batchId": headers.get("x-tp-batch-id") or query.get("batch_id"),
        "imageId": headers.get("x-tp-image-id") or query.get("image_id"),
        "clientVersion": headers.get("x-tp-client-version") or headers.get("x-client-version"),
        "runId": headers.get("x-tp-run-id"),
        "taskId": headers.get("x-tp-task-id"),
        # Values are generated as opaque hashes by the client; raw account or
        # browser identifiers are never accepted into diagnostics.
        "clientInstanceHash": _opaque_scope(headers.get("x-tp-client-instance-hash"), "client"),
        "userScopeHash": _opaque_scope(headers.get("x-tp-user-scope-hash"), "user"),
        "tabSession": _opaque_tab_session(headers.get("x-tp-tab-session")),
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
