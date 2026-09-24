"""Metadata + warmup endpoints used by the extension's settings UI.

"""

from __future__ import annotations

from fastapi import APIRouter
from starlette.concurrency import run_in_threadpool

import time

from backend.config import settings
from backend.paid_center import center_base_url
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
    """Languages / sources the UI should offer, plus the request-owned cloud-key policy."""
    return {
        "ok": True,
        "languages": UI_LANGUAGES,
        "sources": _SOURCES,
        "has_env_ai_key": False,
        "credential_policy": "user_required",
        "paid": {"available": bool(center_base_url()), "auth": "email_otp"} if center_base_url() else None,
    }

@router.get("/warmup")
async def warmup(lang: str | None = None) -> dict:
    """Pre-fetch the Lens cookie + fonts for ``lang`` (defaults to TP_WARMUP_LANG)."""
    t0 = time.perf_counter()
    result = await run_in_threadpool(run_warmup, lang or settings.warmup_lang)
    return {
        "ok": True,
        "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
        "result": result,
    }
