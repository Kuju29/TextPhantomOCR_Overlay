"""AI configuration endpoints used by the extension's settings UI.


``/ai/resolve``        — given an API key (and optional provider/model),
                         return the resolved provider + selectable models.
``/ai/prompt/default`` — return the default editable prompt for a language.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Response

from backend.ai import probe as ai_probe
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


@router.post("/ai/probe")
async def probe(payload: dict[str, Any]) -> dict:
    """Run one tiny real provider call for the selected model (cached)."""
    t0 = time.perf_counter()
    try:
        result = dict(ai_probe.probe(payload))
    except SecurityError as exc:
        event(
            "ai.probe.error",
            {
                "provider": str(payload.get("provider") or "auto"),
                "model": str(payload.get("model") or ""),
                "status": "unsafe_base_url",
                "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
            },
            ok=False,
        )
        return _refused_base_url(payload, exc)
    event(
        "ai.probe" if result.get("ok") else "ai.probe.error",
        {
            "provider": result.get("provider") or str(payload.get("provider") or "auto"),
            "model": result.get("model") or str(payload.get("model") or ""),
            "status": result.get("status") or "unknown",
            "http_status": int(result.get("http_status") or 0),
            "cached": bool(result.get("cached")),
            "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
        },
        ok=bool(result.get("ok")),
    )
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
