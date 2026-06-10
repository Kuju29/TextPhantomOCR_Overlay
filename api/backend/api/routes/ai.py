"""AI configuration endpoints used by the extension's settings UI.

``/ai/resolve``        — given an API key (and optional provider/model),
                         return the resolved provider + selectable models.
``/ai/prompt/default`` — return the default editable prompt for a language.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter

from backend.ai import resolve as ai_resolve
from backend.log import event

router = APIRouter()


@router.post("/ai/resolve")
async def resolve(payload: dict[str, Any]) -> dict:
    """Resolve provider / model / model-list from a partial AI config."""
    t0 = time.perf_counter()
    try:
        result = dict(ai_resolve.resolve(payload))
        ok = bool(result.get("ok"))
        event(
            "ai.resolve" if ok else "ai.resolve.error",
            {
                "provider": result.get("provider") or str(payload.get("provider") or "auto"),
                "model": result.get("model") or "",
                "models": len(result.get("models") or []),
                "lang": result.get("lang") or str(payload.get("lang") or ""),
                "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
                **({"error": result.get("error") or "resolve_failed"} if not ok else {}),
            },
            ok=ok,
        )
        return result
    except Exception as exc:
        event(
            "ai.resolve.error",
            {
                "provider": str(payload.get("provider") or "auto"),
                "lang": str(payload.get("lang") or ""),
                "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
                "error": str(exc)[:240],
            },
            ok=False,
        )
        raise


@router.get("/ai/prompt/default")
async def prompt_default(lang: str = "en") -> dict:
    """Return the default editable prompt + system text for ``lang``."""
    return ai_resolve.prompt_default(lang)
