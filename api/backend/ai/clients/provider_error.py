"""Safe, bounded diagnostics for errors returned by AI providers."""

from __future__ import annotations
from typing import Any

import json, re, httpx, math
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

_MAX_DETAIL = 320
_SECRET_PATTERNS = (
    re.compile(r"(?i)\b(bearer\s+)[^\s,;]+"),
    re.compile(r"\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b", re.IGNORECASE),
    # Prefix-specific bare credentials sometimes appear without a field name.
    re.compile(r"\b(?:hf_|AIza|gsk_|sk-or-v1-)[A-Za-z0-9_-]{8,}\b", re.IGNORECASE),
    re.compile(
        r"(?i)(api[_ -]?key|authorization|access[_ -]?token|secret)"
        r"(\s*[:=]\s*)[^\s,;}]+"
    ),
)

class ProviderFailure(RuntimeError):
    """Safe provider failure carrying only bounded, public diagnostics."""

    def __init__(self, message: str, *, provider: str, model: str,
                 status: int | None = None, provider_code: str = "",
                 provider_type: str = "", provider_message: str = "",
                 retry_after_sec: float = 0.0, upstream_provider: str = "") -> None:
        super().__init__(message)
        self.provider = _scrub(provider)[:64]
        self.model = _scrub(model)[:160]
        self.status = status
        self.upstream_provider = safe_diagnostic_label(upstream_provider)
        self.provider_code = _scrub(provider_code)[:80]
        self.provider_type = _scrub(provider_type)[:80]
        self.provider_message = _scrub(provider_message)
        self.retry_after_sec = max(0.0, min(3600.0, float(retry_after_sec or 0)))

class ProviderHttpError(ProviderFailure):
    """The upstream provider returned a non-success HTTP response."""

class ProviderTransportError(ProviderFailure):
    """The provider could not be reached or timed out."""

class ProviderAdapterContractError(RuntimeError):
    """TextPhantom's provider adapter interface is internally inconsistent."""

def structured_upstream_http_status(exc: BaseException) -> int | None:
    """Only HTTP status metadata, never exception wording."""
    response = getattr(exc, "response", None)
    for value in (getattr(response, "status_code", None),
                  getattr(exc, "status_code", None), getattr(exc, "status", None)):
        if isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599:
            return value
    return None

def upstream_http_status(exc: BaseException) -> int | None:
    """Read status metadata first; legacy clients may only carry safe text.

    Do not inspect response bodies, request URLs or headers. A transport
    timeout without a response has no upstream HTTP status.
    """
    status = structured_upstream_http_status(exc)
    if status is not None:
        return status
    if isinstance(exc, (ProviderTransportError, httpx.RequestError)):
        return None
    match = re.search(r"\bHTTP\s+(\d{3})\b", str(exc), re.IGNORECASE)
    value = int(match.group(1)) if match else None
    return value if value is not None and 100 <= value <= 599 else None

def _scrub(value: Any) -> str:
    text = " ".join(str(value or "").split())
    for pattern in _SECRET_PATTERNS:
        if pattern.groups >= 2:
            text = pattern.sub(r"\1\2[redacted]", text)
        elif pattern.groups:
            text = pattern.sub(r"\1[redacted]", text)
        else:
            text = pattern.sub("[redacted]", text)
    return text[:_MAX_DETAIL]

def safe_diagnostic_label(value: Any) -> str:
    """Bounded identifiers only; never retain raw vendor payloads or prose."""
    text = _scrub(value)
    return text if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_. /:-]{0,79}", text) else ""


def http_error_evidence(exc: ProviderHttpError, *, streamed: bool) -> dict[str, Any]:
    return {
        "status": exc.status, "streamed": streamed, "bodyStored": False,
        "providerCode": safe_diagnostic_label(exc.provider_code),
        "providerType": safe_diagnostic_label(exc.provider_type),
        "upstreamProvider": exc.upstream_provider,
        "retryAfterMs": round(exc.retry_after_sec * 1000) if exc.retry_after_sec > 0 else None,
    }


def _error_fields(data: Any) -> tuple[str, str, str]:
    if not isinstance(data, dict):
        return "", "", ""
    error = data.get("error", data)
    if isinstance(error, str):
        return "", "", _scrub(error)
    if not isinstance(error, dict):
        return "", "", ""
    code = _scrub(error.get("code") or data.get("code"))
    metadata = error.get("metadata") if isinstance(error.get("metadata"), dict) else {}
    kind = _scrub(error.get("type") or error.get("error_type") or metadata.get("error_type") or data.get("type"))
    message = _scrub(error.get("message") or error.get("detail"))
    return code, kind, message

def safe_http_error(provider: str, response: httpx.Response, model: str) -> ProviderHttpError:
    """Build a useful exception without exposing headers or an unbounded body."""
    try:
        data = response.json()
    except (ValueError, json.JSONDecodeError):
        data = None
    code, kind, message = _error_fields(data)
    error = data.get("error") if isinstance(data, dict) else None
    metadata = error.get("metadata") if isinstance(error, dict) else None
    upstream = safe_diagnostic_label(metadata.get("provider_name")) if isinstance(metadata, dict) else ""
    retry_after = 0.0
    if response.status_code == 429:
        raw_wait = str(response.headers.get("retry-after") or "").strip()[:100]
        try:
            retry_after = float(raw_wait)
        except ValueError:
            try:
                retry_after = (parsedate_to_datetime(raw_wait) - datetime.now(timezone.utc)).total_seconds()
            except (ValueError, TypeError, OverflowError):
                pass
        retry_after = min(3600.0, retry_after) if math.isfinite(retry_after) and retry_after > 0 else 0.0
    fields = [f"{provider} HTTP {response.status_code}", f"model={_scrub(model)}", "attempts=1"]
    if code:
        fields.append(f"providerCode={code}")
    if kind and kind != code:
        fields.append(f"providerType={kind}")
    if upstream:
        fields.append(f"upstreamProvider={upstream}")
    if message:
        fields.append(f"detail={message}")
    return ProviderHttpError(
        fields[0] + " (" + ", ".join(fields[1:]) + ")",
        provider=provider, model=model, status=int(response.status_code),
        provider_code=code, provider_type=kind, provider_message=message,
        retry_after_sec=retry_after, upstream_provider=upstream,
    )
