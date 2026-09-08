"""Pure context helpers for the API-server translation route."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

import hashlib

def safe_source_identity(value: Any) -> dict[str, Any] | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    if raw.startswith("data:"):
        media_type = raw[5:].split(";", 1)[0].split(",", 1)[0][:80]
        return {"kind": "data", "mediaType": media_type, "fingerprint": digest}
    try:
        parsed = urlsplit(raw)
        host = (parsed.hostname or "").rstrip(".").lower()
        path = parsed.path or "/"
    except ValueError:
        host, path = "", ""
    return {
        "kind": "url" if host else "opaque",
        "host": host,
        "path": path[:240] if host else "",
        "fingerprint": digest,
    }

def lane_for(payload: dict[str, Any], *, fallback_api_key: str, is_local_target: Any) -> str:
    if str(payload.get("mode") or "") != "lens_text":
        return "lens"
    if str(payload.get("source") or "").strip().lower() != "ai":
        return "lens"
    ai = payload.get("ai") if isinstance(payload.get("ai"), dict) else {}
    has_key = bool(str(ai.get("api_key") or fallback_api_key or "").strip())
    provider = str(ai.get("provider") or "auto").strip().lower()
    base_url = str(ai.get("base_url") or "")
    return "ai" if (has_key or is_local_target(provider, base_url)) else "lens"

def ai_server_execution_configured(
    payload: dict[str, Any], *, fallback_api_key: str, is_local_target: Any
) -> bool:
    if str(payload.get("mode") or "") != "lens_text":
        return True
    if str(payload.get("source") or "").strip().lower() != "ai":
        return True
    return lane_for(
        payload, fallback_api_key=fallback_api_key, is_local_target=is_local_target
    ) == "ai"
