from __future__ import annotations

import json

from .wire import apply, normalize_unit_text

def parse_translation_object(raw: str, expected: int) -> tuple[str, str] | None:
    text = str(raw or "").strip()
    if not text or "{" not in text:
        return None
    start, end = text.find("{"), text.rfind("}")
    if end <= start:
        return None
    try:
        obj = json.loads(text[start : end + 1])
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(obj, dict):
        return None
    wanted = {f"P{i}" for i in range(expected)}
    if not wanted.issubset(obj) or not set(obj).issubset(wanted | {"memo"}):
        return None
    values = [obj.get(f"P{i}") for i in range(expected)]
    if any(not isinstance(value, str) for value in values):
        return None
    return apply([normalize_unit_text(value) for value in values]), str(obj.get("memo") or "").strip()

__all__ = ["parse_translation_object"]
