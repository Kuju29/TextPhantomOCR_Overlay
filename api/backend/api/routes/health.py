"""Liveness / build-info endpoints.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
"""

from __future__ import annotations

from fastapi import APIRouter

from backend.config import settings

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    """Simple liveness probe."""
    return {"ok": True, "build": settings.build_id}


@router.get("/version")
async def version() -> dict:
    """Build identifier — handy for confirming a deploy went out."""
    return {"ok": True, "build": settings.build_id, "core": "backend.rewrite"}
