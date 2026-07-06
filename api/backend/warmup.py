"""Warm caches so the first real request is fast.

Primes three things: the Lens session cookie, the font files for ``lang``,
and the in-memory font-pair cache at a couple of common sizes.
"""

from __future__ import annotations

from typing import Any

from backend.config import settings
from backend.jobs.fonts import resolve_font_pair
from backend.lens import cookie
from backend.lens.languages import normalize as normalize_lang
from backend.render.fonts import font_pair


def warmup(lang: str = "th") -> dict[str, Any]:
    """Pre-fetch the Lens cookie and the fonts for ``lang``."""
    code = normalize_lang(lang)

    cookie_ok = False
    try:
        cookie.get(settings.firebase_url)
        cookie_ok = True
    except Exception:
        cookie_ok = False

    # Text-block detector model (optional). Do NOT warm it by default because
    # only lens_text.ai uses self-built blocks. Lens-direct modes
    # (lens_images / lens_text.translated / lens_text.original) must start fast
    # on Hugging Face CPU and should not pay ONNX boot/session cost.
    if settings.textblock_warmup:
        try:
            from backend.render.textblocks import ensure_model

            ensure_model()
        except Exception:
            pass

    thai_font, latin_font = resolve_font_pair(code)
    # Prime the font-pair cache at the sizes the renderer uses most.
    font_pair(thai_font or "", latin_font or "", 22)
    font_pair(thai_font or "", latin_font or "", 28)

    return {
        "ok": True,
        "lang": code,
        "thai_font": thai_font or "",
        "latin_font": latin_font or "",
        "cookie_ok": cookie_ok,
    }
