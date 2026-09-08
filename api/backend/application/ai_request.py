"""Pure request-contract helpers for the extension-owned AI route."""

from __future__ import annotations

from typing import Any

import hashlib, unicodedata, json

def request_fingerprint(payload: dict[str, Any]) -> str:
    provider = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
    semantic = {
        "units": payload.get("units"),
        "sourceLang": payload.get("sourceLang"),
        "targetLang": payload.get("targetLang"),
        "prompt": payload.get("prompt"),
        "provider": {
            key: provider.get(key)
            for key in ("id", "model", "baseUrl", "thinking")
            if key in provider
        },
        "memory": payload.get("memory"),
        "image": payload.get("image"),
        # Repair ownership changes billable generation semantics and therefore
        # must not replay an idempotent result produced under another owner.
        "repair": payload.get("repair"),
    }
    canonical = json.dumps(
        semantic, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

def extension_owns_repair(payload: dict[str, Any]) -> bool:
    """Return true only for the explicit extension repair-owner contract.

    Omitted or malformed policy deliberately returns false so legacy clients
    and runs:API retain the backend's default-on single repair behaviour.
    """
    repair = payload.get("repair") if isinstance(payload.get("repair"), dict) else {}
    return repair.get("owner") == "extension" and repair.get("enabled") is False

def unit_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

def language_neutral_unit(text: str) -> bool:
    visible = [ch for ch in str(text or "") if not ch.isspace()]
    return bool(visible) and all(
        unicodedata.category(ch)[0] in ("N", "P", "S") for ch in visible
    )

def validate_units(
    raw: Any, *, max_units: int, max_unit_chars: int, max_total_chars: int
) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("units must be a non-empty list")
    if len(raw) > max_units:
        raise ValueError(f"too many units ({len(raw)} > {max_units})")
    units: list[dict[str, str]] = []
    total = 0
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"unit {index} is not an object")
        uid = str(item.get("id") or "").strip()
        text = str(item.get("text") or "")
        if not uid:
            raise ValueError(f"unit {index} has no id")
        if uid in seen:
            raise ValueError(f"duplicate unit id {uid!r}")
        seen.add(uid)
        if not text.strip():
            raise ValueError(f"unit {uid} has no text")
        if len(text) > max_unit_chars:
            raise ValueError(f"unit {uid} is {len(text)} chars (max {max_unit_chars})")
        total += len(text)
        if total > max_total_chars:
            raise ValueError(f"request exceeds {max_total_chars} characters")
        units.append({"id": uid, "text": text})
    return units
