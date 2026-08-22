"""Stable, compact and safe API error contract.

The public shape is additive: existing callers may keep reading ``message``,
``stage`` and route-specific aliases while newer callers key on ``schema`` and
``code``.  This module deliberately accepts only already-sanitised metadata;
raw exception/provider response text must never be passed as ``extra``.
"""

from __future__ import annotations

from typing import Any

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
        for key in ("requestId", "jobId", "batchId", "imageId"):
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
            **{key: value for key, value in safe_meta.items() if value not in (None, "")},
        },
        ok=False,
    )


def provider_status(exc: BaseException) -> int | None:
    """Extract an upstream HTTP status from the clients' sanitised messages."""
    import re

    match = re.search(r"\bHTTP\s+(\d{3})\b", str(exc), re.IGNORECASE)
    return int(match.group(1)) if match else None
