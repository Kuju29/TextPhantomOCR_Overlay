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

def image_artifact_candidate(lens: dict[str, Any], width: int, height: int) -> tuple[bool, str]:
    """Conservatively retain bytes only when source geometry may need grouping.

    This is cache admission, not the grouping decision. The extension remains
    authoritative and can always send imageDataUri when no token was retained.
    Any inspection failure therefore keeps the artifact rather than risking a
    false-negative optimization.
    """
    if not isinstance(lens, dict) or not (lens.get("originalParagraphs") or []):
        return False, "no_text"
    try:
        from backend.lens.tree import decode_tree
        from backend.render.region import paragraph_reading_axis

        tree = decode_tree(
            lens.get("originalParagraphs") or [],
            str(lens.get("originalTextFull") or ""),
            "original", int(width), int(height),
        )
        paragraphs = tree.get("paragraphs") if isinstance(tree, dict) else []
        if not paragraphs:
            return False, "no_text"
        if any(paragraph_reading_axis(paragraph.get("items") or []) == "v"
               for paragraph in paragraphs if isinstance(paragraph, dict)):
            return True, "vertical_candidate"
        return False, "horizontal"
    except Exception:  # cache admission must never make Lens fail
        return True, "undetermined"

def optional_image_artifact(
    store: Any, raw: bytes, identity: str, *, lens: dict[str, Any] | None = None,
    width: int = 0, height: int = 0,
) -> tuple[dict | None, str]:
    if lens is not None:
        keep, reason = image_artifact_candidate(lens, width, height)
        if not keep:
            return None, f"skipped_{reason}"
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
