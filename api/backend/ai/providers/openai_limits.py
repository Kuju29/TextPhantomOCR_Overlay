"""Documented native OpenAI limits; /models still owns account availability.

Verified 2026-09-28 against https://developers.openai.com/api/docs/models/
(gpt-4.1, gpt-4.1-mini, gpt-4.1-nano). Do not infer limits for arbitrary dates,
fine-tunes, compatible providers, or models merely sharing a name prefix.
"""
from __future__ import annotations

_MODELS = frozenset({
    "gpt-4.1", "gpt-4.1-2025-04-14",
    "gpt-4.1-mini", "gpt-4.1-mini-2025-04-14",
    "gpt-4.1-nano", "gpt-4.1-nano-2025-04-14",
})

def documented_limits(model: str) -> dict:
    if str(model or "").strip().lower() not in _MODELS:
        return {}
    return {"contextTokens": 1047576, "maxOutputTokens": 32768,
            "source": "openai_documented_model_card", "scope": "model"}
