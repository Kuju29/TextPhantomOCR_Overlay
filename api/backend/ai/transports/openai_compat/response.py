"""Response decoding helpers for OpenAI-compatible payloads."""
from __future__ import annotations

import json
from decimal import Decimal
from typing import Any


def json_response(response):
    content = getattr(response, "content", None)
    if isinstance(content, (bytes, bytearray)):
        return json.loads(content, parse_float=Decimal)
    response_text = getattr(response, "text", None)
    if isinstance(response_text, str):
        return json.loads(response_text, parse_float=Decimal)
    return response.json()


def response_text(data: dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("AI returned no choices")
    value = ((choices[0].get("message") or {}).get("content") or "").strip()
    if not value:
        raise RuntimeError("AI returned empty text")
    return value
