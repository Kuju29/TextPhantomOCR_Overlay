"""Safe, bounded diagnostics for errors returned by AI providers."""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

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


def safe_http_error(provider: str, response: httpx.Response, model: str) -> RuntimeError:
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
    return RuntimeError(fields[0] + " (" + ", ".join(fields[1:]) + ")")
