"""Liveness / compatibility endpoints."""

from __future__ import annotations

from fastapi import APIRouter


router = APIRouter()


@router.get("/health")
async def health() -> dict:
    """Simple liveness probe."""
    return {"ok": True}


@router.get("/version")
async def version() -> dict:
    """Compatibility marker retained for launchers; no release number is tracked."""
    return {"ok": True, "core": "backend.rewrite"}
