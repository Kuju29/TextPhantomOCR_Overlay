"""AI configuration endpoints used by the extension's settings UI.

``/ai/resolve``        — given an API key (and optional provider/model),
                         return the resolved provider + selectable models.
``/ai/prompt/default`` — return the default editable prompt for a language.
``/ai/probe``          — compatibility stub (no provider call), see below.
"""

from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Response
from starlette.concurrency import run_in_threadpool

import time

from backend.ai import resolve as ai_resolve
from backend.log import event
from backend.security import SecurityError

router = APIRouter()

def _refused_base_url(payload: dict[str, Any], exc: SecurityError) -> dict:
    """Report a refused AI endpoint as data, not as a 500.

    These two endpoints only *describe* a configuration; the settings UI calls
    them while the user is still typing. Letting the policy error escape turned
    a legible "this endpoint is not allowed" into an opaque server error that
    the popup could only render as "couldn't reach the API".
    """
    return {
        "ok": False,
        "error": "unsafe_base_url",
        "detail": str(exc)[:400],
        "provider": str(payload.get("provider") or "auto"),
        "model": "",
        "models": [],
        "backend_supported": True,
        "provider_protocol": "",
        "key_status": "unverified",
        "key_source": "none",
        "key_verified": False,
        "models_source": "none",
        "models_verified": False,
        "models_http_status": 0,
        "model_status": "unverified",
        "status": "unsafe_base_url",
        "http_status": 0,
        "cached": False,
    }

@router.post("/ai/probe")
async def probe_compat() -> dict:
    """Compatibility answer for extensions older than 2026.10.4.91.

    The live model probe was removed in .91 (it spent the user's provider
    quota on every popup open). The 2026.9.27.26 popup still calls it after
    every model selection and showed "Provider could not be reached" for the
    404. This answer makes NO provider call and reads nothing from the body
    (the key is never parsed or logged): "not tested" is the truth, and the
    old popup shows no error for it. Real failures still surface from the
    actual translation request.
    """
    return {"ok": False, "status": "not_tested", "model_capabilities": {}}

@router.post("/ai/resolve")
async def resolve(payload: dict[str, Any]) -> dict:
    """Resolve provider / model / model-list from a partial AI config."""
    return await run_in_threadpool(_resolve, payload)


def _resolve(payload: dict[str, Any]) -> dict:
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
    except SecurityError as exc:
        event(
            "ai.resolve.error",
            {
                "provider": str(payload.get("provider") or "auto"),
                "lang": str(payload.get("lang") or ""),
                "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
                "error": "unsafe_base_url",
            },
            ok=False,
        )
        result = _refused_base_url(payload, exc)
        result["lang"] = str(payload.get("lang") or "en")
        return result

@router.get("/ai/prompt/default")
async def prompt_default(
    response: Response, lang: str = "en", want_memo: bool = True
) -> dict:
    """Return the default editable prompt + system text for ``lang``."""
    # "Reset" must mean the API's current policy, not a browser/proxy copy
    # retained from an earlier deployment.
    response.headers["Cache-Control"] = "no-store"
    return ai_resolve.prompt_default(lang, want_memo=want_memo)
