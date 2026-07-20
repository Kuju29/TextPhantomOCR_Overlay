"""Shared types for AI chat clients.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

Every client exposes a ``generate(api_key, model, system_text, user_parts)``
function returning :class:`ChatResult` — a ``(text, used_model)`` pair.  The
``used_model`` may differ from the requested one (e.g. a Hugging Face router
fallback).
"""

from __future__ import annotations

from typing import NamedTuple


class ChatResult(NamedTuple):
    text: str
    used_model: str
