"""Resolve the (thai_font, latin_font) path pair for a target language.

The renderer always pairs a Thai face with a "latin" face — for CJK targets
the latin slot is swapped for the matching Noto CJK font.  When
``DOWNLOAD_FONTS`` is on, missing files are fetched on demand.
"""

from __future__ import annotations

from backend.lens.languages import normalize as normalize_lang
from backend.render import font_config
from backend.render.fonts import ensure_font


def resolve_font_pair(lang: str) -> tuple[str, str]:
    """Return ``(thai_font_path, latin_font_path)`` for ``lang``."""
    code = normalize_lang(lang)

    thai_path = font_config.THAI_PATH
    latin_path, latin_urls = font_config.latin_font_for_lang(code)

    if font_config.DOWNLOAD_FONTS:
        thai_path = ensure_font(thai_path, font_config.THAI_URLS) or thai_path
        latin_path = ensure_font(latin_path, latin_urls) or latin_path

    return thai_path, latin_path
