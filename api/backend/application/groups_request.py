"""Pure input resolution for paragraph-grouping routes."""

from __future__ import annotations

from typing import Any

def resolve_image_bytes(
    payload: dict, identity: str, store: Any, decode_b64: Any
) -> tuple[bytes, str]:
    token = str(payload.get("imageArtifactToken") or "").strip()
    data_uri = str(payload.get("imageDataUri") or "")
    if token:
        return store.get(token, identity), "hit"
    if data_uri:
        return decode_b64(data_uri.split(",", 1)[-1]), "legacy"
    raise ValueError("`imageArtifactToken` or `imageDataUri` is required")
