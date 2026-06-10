"""Anthropic (api.anthropic.com) chat client."""

from __future__ import annotations

import httpx

from backend.ai import config as ai_config
from backend.ai.clients.base import ChatResult

_ENDPOINT = "https://api.anthropic.com/v1/messages"
_API_VERSION = "2023-06-01"


def generate(api_key: str, model: str, system_text: str, user_parts: list[str]) -> ChatResult:
    """Call Anthropic's Messages API and return the concatenated text reply."""
    messages = [{"role": "user", "content": p} for p in user_parts if (p or "").strip()]
    payload = {
        "model": model,
        "max_tokens": ai_config.MAX_TOKENS,
        "temperature": ai_config.TEMPERATURE,
        "system": system_text,
        "messages": messages,
    }
    headers = {
        "x-api-key": api_key,
        "anthropic-version": _API_VERSION,
        "content-type": "application/json",
    }

    with httpx.Client(timeout=ai_config.TIMEOUT_SEC) as client:
        r = client.post(_ENDPOINT, json=payload, headers=headers)
        try:
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"Anthropic HTTP {r.status_code}: {r.text}") from e
        data = r.json()

    content = data.get("content") or []
    text = "".join(
        c.get("text") or ""
        for c in content
        if isinstance(c, dict) and c.get("type") == "text"
    ).strip()
    if not text:
        raise RuntimeError("Anthropic returned empty text")
    return ChatResult(text=text, used_model=model)
