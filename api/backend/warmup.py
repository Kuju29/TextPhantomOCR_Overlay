"""Warm caches so the first real request is fast.

Primes three things: the Lens session cookie, the font files for ``lang``,
and the in-memory font-pair cache at a couple of common sizes.
"""

from __future__ import annotations

from typing import Any

import threading, sys

from backend.config import settings
from backend.jobs.fonts import resolve_font_pair
from backend.lens import cookie
from backend.lens.languages import normalize as normalize_lang
from backend.render.fonts import font_pair
from backend.render.fonts import UnsupportedFontError

_warning_lock = threading.Lock()
_reported_font_warnings: set[tuple[str, str, str, str]] = set()

def _report_font_warning_once(code: str, thai_font: str, latin_font: str, warning: str) -> bool:
    """Print one identical degradation once while still probing every warmup.

    Successful recovery clears prior warnings for the language so a later,
    genuinely new degradation remains observable.
    """
    key = (code, str(thai_font or ""), str(latin_font or ""), warning)
    with _warning_lock:
        if key in _reported_font_warnings:
            return False
        _reported_font_warnings.add(key)
    print(f"[warmup] WARNING: {warning}", file=sys.stderr)
    return True

def _clear_font_warnings(code: str) -> None:
    with _warning_lock:
        _reported_font_warnings.difference_update(
            {key for key in _reported_font_warnings if key[0] == code}
        )

def _is_non_actionable_prewarm_failure(code: str, exc: UnsupportedFontError) -> bool:
    """True when a synthetic warmup probe failed outside the target script.

    Thai rendering uses the dedicated Thai face.  ``font_pair`` also probes a
    Latin ``A`` to prime mixed-text metrics, but absence of that optional face
    is not evidence that the requested Thai page cannot render.  The renderer
    still raises ``UnsupportedFontError`` if real page text later needs Latin,
    so suppressing this startup warning does not hide an actionable failure.
    """
    return code == "th" and exc.script == "latin" and exc.text == "A"

def warmup(lang: str = "th") -> dict[str, Any]:
    """Pre-fetch the Lens cookie and the fonts for ``lang``."""
    code = normalize_lang(lang)

    cookie_ok = False
    try:
        cookie.get(settings.firebase_url)
        cookie_ok = True
    except Exception:
        cookie_ok = False

    thai_font, latin_font = resolve_font_pair(code)
    # Prime the font-pair cache at the sizes the renderer uses most.
    fonts_ok = True
    font_warning = ""
    optional_latin_ready = True
    try:
        font_pair(thai_font or "", latin_font or "", 22)
        font_pair(thai_font or "", latin_font or "", 28)
        _clear_font_warnings(code)
    except UnsupportedFontError as exc:
        warning_reported = False
        if _is_non_actionable_prewarm_failure(code, exc):
            # The requested Thai face is usable; only font_pair's synthetic
            # mixed-Latin cache probe failed.  Do not publish this as degraded
            # startup state or main.py will turn it back into a warning-like
            # ``font_reason`` in the structured warmup.boot event.
            optional_latin_ready = False
            _clear_font_warnings(code)
        else:
            fonts_ok = False
            font_warning = (
                f"font prewarm degraded ({exc}); geometry-only layout fallback "
                "will be used for unsupported text"
            )
            warning_reported = _report_font_warning_once(
                code, thai_font or "", latin_font or "", font_warning
            )
    else:
        warning_reported = False

    return {
        "ok": True,
        "lang": code,
        "thai_font": thai_font or "",
        "latin_font": latin_font or "",
        "fonts_ok": fonts_ok,
        "optional_latin_ready": optional_latin_ready,
        "font_warning": font_warning,
        "font_warning_reported": warning_reported,
        "cookie_ok": cookie_ok,
    }
