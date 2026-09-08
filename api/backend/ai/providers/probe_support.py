"""Small wire helpers used explicitly by provider-owned probe methods."""

from __future__ import annotations

from typing import Any

import httpx

from backend.ai.provider_contract import ProbeRequest, ProbeResponse

def response_error(response: httpx.Response) -> str:
    try:
        data = response.json()
        if isinstance(data, dict):
            error = data.get("error")
            if isinstance(error, dict):
                return str(error.get("message") or error.get("type") or "")[:240]
            if error:
                return str(error)[:240]
    except ValueError:
        pass
    return str(response.text or "")[:240]

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
        return ProbeResponse(False, response.status_code, error=response_error(response))
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

__all__ = ["openai_chat_probe", "response_error"]
