"""Small wire helpers used explicitly by provider-owned probe methods."""

from __future__ import annotations

from typing import Any

import re
import httpx

from backend.ai.provider_contract import ProbeRequest, ProbeResponse

_SECRET = re.compile(r"Bearer\s+[A-Za-z0-9._\-]{4,}|(?:sk-|hf_|gsk_|AIza)[A-Za-z0-9._\-]{8,}", re.I)
_SECRET_FIELD = re.compile(
    r"([\"']?(?:api[_-]?key|authorization|access[_-]?token|token|secret)[\"']?\s*[:=]\s*)"
    r"(?:\"[^\"]*\"|'[^']*'|[^\s,;}&]+)", re.I,
)

def _safe_error(value: Any, api_key: str = "") -> str:
    text = " ".join(str(value or "").split())
    if api_key:
        text = text.replace(api_key, "[redacted]")
    text = _SECRET.sub("[redacted]", text)
    return _SECRET_FIELD.sub(lambda match: match.group(1) + "[redacted]", text)[:240]

def response_error_details(response: httpx.Response, *, api_key: str = "") -> dict[str, str]:
    """Allowlisted, bounded diagnostics, never raw provider metadata/requests.

    Gateways often put the useful cause inside metadata.raw (JSON). Extract
    only its error fields and discard headers, prompts and arbitrary keys.
    The caller's exact credential is scrubbed even for unfamiliar key formats.
    """
    import json
    try:
        data = response.json()
    except ValueError:
        return {"message": _safe_error(response.text, api_key)}
    error = data.get("error") if isinstance(data, dict) else None
    if not isinstance(error, dict):
        return {"message": _safe_error(error or response.text, api_key)}
    details = {key: error.get(key) for key in ("message", "code", "type", "param")}
    metadata = error.get("metadata")
    if isinstance(metadata, dict):
        for key in ("error_type", "provider_code", "provider_name"):
            details[key] = metadata.get(key)
        raw = metadata.get("raw")
        if isinstance(raw, str) and len(raw) <= 16_384:
            try:
                raw = json.loads(raw)
            except ValueError:
                raw = None
        nested = raw.get("error", raw) if isinstance(raw, dict) else None
        if isinstance(nested, dict):
            details["provider_message"] = nested.get("message")
            for key in ("code", "type", "param"):
                details.setdefault("provider_" + key, nested.get(key))
                if not details.get("provider_" + key):
                    details["provider_" + key] = nested.get(key)
    return {key: _safe_error(value, api_key) for key, value in details.items()
            if isinstance(value, (str, int, float)) and not isinstance(value, bool) and str(value)}

def response_error(response: httpx.Response, *, api_key: str = "") -> str:
    details = response_error_details(response, api_key=api_key)
    message = details.get("message") or details.get("type") or "Provider test failed"
    cause = details.get("provider_message") or details.get("error_type") or details.get("provider_code")
    return _safe_error(f"{message}; {cause}" if cause and cause != message else message, api_key)

def openai_chat_probe(
    request: ProbeRequest,
    *,
    headers: dict[str, str] | None = None,
    payload_extra: dict[str, Any] | None = None,
    include_bearer: bool = True,
) -> ProbeResponse:
    request_headers = {"Content-Type": "application/json", **(headers or {})}
    if include_bearer and request.api_key and "Authorization" not in request_headers:
        request_headers["Authorization"] = f"Bearer {request.api_key}"
    payload: dict[str, Any] = {
        "model": request.model,
        "messages": [{"role": "user", "content": "Reply only OK."}],
        "max_tokens": 128,
        **(payload_extra or {}),
    }
    if "max_completion_tokens" in payload:
        payload.pop("max_tokens", None)
    with httpx.Client(timeout=request.timeout_sec) as client:
        response = client.post(
            request.base_url.rstrip("/") + "/chat/completions",
            headers=request_headers,
            json=payload,
        )
    if not response.is_success:
        return ProbeResponse(False, response.status_code,
            error=response_error(response, api_key=request.api_key),
            error_details=response_error_details(response, api_key=request.api_key))
    try:
        data = response.json()
        choices = data.get("choices") if isinstance(data, dict) else None
        message = choices[0].get("message") if isinstance(choices, list) and choices else None
        text = message.get("content") if isinstance(message, dict) else ""
        if isinstance(text, list):
            text = "".join(str(item.get("text") or "") for item in text if isinstance(item, dict))
        if not isinstance(text, str) or not text.strip():
            raise ValueError("empty completion")
    except (ValueError, IndexError, TypeError, AttributeError) as exc:
        return ProbeResponse(False, response.status_code, "invalid_model_output", str(exc))
    return ProbeResponse(True, response.status_code)

__all__ = ["openai_chat_probe", "response_error", "response_error_details"]
