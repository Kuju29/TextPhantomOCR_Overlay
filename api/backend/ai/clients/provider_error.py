"""Safe, bounded diagnostics for errors returned by AI providers."""

from __future__ import annotations
from typing import Any

import json, re, httpx

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
                 provider_type: str = "", provider_message: str = "") -> None:
        super().__init__(message)
        self.provider = _scrub(provider)[:64]
        self.model = _scrub(model)[:160]
        self.status = status
        self.provider_code = _scrub(provider_code)[:80]
        self.provider_type = _scrub(provider_type)[:80]
        self.provider_message = _scrub(provider_message)

class ProviderHttpError(ProviderFailure):
    """The upstream provider returned a non-success HTTP response."""

class ProviderTransportError(ProviderFailure):
    """The provider could not be reached or timed out."""

class ProviderAdapterContractError(RuntimeError):
    """TextPhantom's provider adapter interface is internally inconsistent."""

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

def _error_fields(data: Any) -> tuple[str, str, str]:
    if not isinstance(data, dict):
        return "", "", ""
    error = data.get("error", data)
    if isinstance(error, str):
        return "", "", _scrub(error)
    if not isinstance(error, dict):
        return "", "", ""
    code = _scrub(error.get("code") or data.get("code"))
    kind = _scrub(error.get("type") or error.get("error_type") or data.get("type"))
    message = _scrub(error.get("message") or error.get("detail"))
    return code, kind, message

def safe_http_error(provider: str, response: httpx.Response, model: str) -> ProviderHttpError:
    """Build a useful exception without exposing headers or an unbounded body."""
    try:
        data = response.json()
    except (ValueError, json.JSONDecodeError):
        data = None
    code, kind, message = _error_fields(data)
    fields = [f"{provider} HTTP {response.status_code}", f"model={_scrub(model)}", "attempts=1"]
    if code:
        fields.append(f"providerCode={code}")
    if kind and kind != code:
        fields.append(f"providerType={kind}")
    if message:
        fields.append(f"detail={message}")
    return ProviderHttpError(
        fields[0] + " (" + ", ".join(fields[1:]) + ")",
        provider=provider, model=model, status=int(response.status_code),
        provider_code=code, provider_type=kind, provider_message=message,
    )
