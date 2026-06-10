"""Metadata + warmup endpoints used by the extension's settings UI."""

from __future__ import annotations

import time

from fastapi import APIRouter

from backend.config import settings
from backend.lens.languages import UI_LANGUAGES
from backend.warmup import warmup as run_warmup

router = APIRouter()

# The three render layers the extension can show.
_SOURCES = [
    {"id": "original", "name": "Original"},
    {"id": "translated", "name": "Translated"},
    {"id": "ai", "name": "Ai"},
]


@router.get("/meta")
async def meta() -> dict:
    """Languages / sources the UI should offer, plus whether a server AI key exists."""
    return {
        "ok": True,
        "languages": UI_LANGUAGES,
        "sources": _SOURCES,
        "has_env_ai_key": bool(settings.ai_api_key),
    }


@router.get("/warmup")
async def warmup(lang: str | None = None) -> dict:
    """Pre-fetch the Lens cookie + fonts for ``lang`` (defaults to TP_WARMUP_LANG)."""
    t0 = time.perf_counter()
    result = run_warmup(lang or settings.warmup_lang)
    return {
        "ok": True,
        "build": settings.build_id,
        "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
        "result": result,
    }
