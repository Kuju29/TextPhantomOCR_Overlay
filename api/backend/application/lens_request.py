"""Request preparation shared by Lens route adapters."""

from __future__ import annotations

from typing import Any
from fastapi import HTTPException

from backend.jobs.admission import identity_of
from backend.jobs.image_artifacts import ArtifactError

def route_meta(request: Any, canonical_route: str) -> dict[str, Any]:
    requested_route = request.url.path
    return {
        "engine": "runsextension",
        "canonicalRoute": canonical_route,
        "requestedRoute": requested_route,
        "compatibilityAlias": requested_route != canonical_route,
    }

def lens_identity(tab_session: str) -> str:
    return identity_of({"context": {"tp_tab_session": str(tab_session or "")}})

def optional_image_artifact(store: Any, raw: bytes, identity: str) -> tuple[dict | None, str]:
    try:
        token, ttl = store.put(raw, identity)
    except ArtifactError as exc:
        return None, exc.code
    return {
        "token": token,
        "expiresInSec": ttl,
        "scope": "anonymous" if identity == "anon" else "session",
    }, "stored"

def require_size(payload: dict[str, Any]) -> tuple[int, int]:
    image = payload.get("image") if isinstance(payload.get("image"), dict) else {}
    try:
        width = int(image.get("width") or 0)
        height = int(image.get("height") or 0)
    except (TypeError, ValueError):
        width = height = 0
    if width <= 0 or height <= 0:
        raise HTTPException(
            status_code=400,
            detail="image.width and image.height are required (Lens geometry is "
            "normalised against them, so they cannot be inferred here)",
        )
    return width, height
