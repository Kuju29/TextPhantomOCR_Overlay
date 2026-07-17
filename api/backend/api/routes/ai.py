"""AI configuration endpoints used by the extension's settings UI.

``/ai/resolve``        — given an API key (and optional provider/model),
                         return the resolved provider + selectable models.
``/ai/prompt/default`` — return the default editable prompt for a language.
``/ai/brief``          — read the whole chapter ONCE and return the frozen
                         series context (read-then-translate batches).
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter

from backend.ai import brief as ai_brief
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


@router.post("/ai/brief")
def chapter_brief(payload: dict[str, Any]) -> dict:
    """Run the chapter brief: ONE AI call that reads the whole chapter.

    Body: ``{"lang", "pages": [{"index", "text"}], "memory": {...}, "ai": {...}}``.
    Returns ``{"ok": True, "bible", "characters", "speakers", "terms", "meta"}``
    or ``{"ok": False, "error"}`` — the extension falls back to the per-page
    flow (with an on-page toast) when this call fails.

    Plain ``def`` (not ``async``): the provider round-trip is blocking, so
    FastAPI runs it in the threadpool instead of stalling the event loop.
    """
    t0 = time.perf_counter()
    pages = payload.get("pages") if isinstance(payload.get("pages"), list) else []
    lang = str(payload.get("lang") or "en")
    try:
        ctx = ai_brief.run_chapter_brief(
            pages,
            payload.get("memory") if isinstance(payload.get("memory"), dict) else None,
            payload.get("ai") if isinstance(payload.get("ai"), dict) else None,
            lang,
        )
        event(
            "ai.brief",
            {
                "lang": lang,
                "pages": len(pages),
                "characters": len(ctx.get("characters") or []),
                "speaker_pages": len(ctx.get("speakers") or {}),
                "terms": len(ctx.get("terms") or []),
                "bible_chars": len(ctx.get("bible") or ""),
                "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
            },
        )
        return {"ok": True, **ctx}
    except Exception as exc:
        event(
            "ai.brief.error",
            {
                "lang": lang,
                "pages": len(pages),
                "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
                "error": str(exc)[:240],
            },
            ok=False,
        )
        return {"ok": False, "error": str(exc)[:240]}
