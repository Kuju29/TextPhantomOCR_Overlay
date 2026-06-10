"""Static font configuration: which TTF/OTF to use per script, and where to
download them from when they are missing on disk.

The actual loading / caching logic lives in :mod:`backend.render.fonts`.
"""

from __future__ import annotations

from typing import Final

# When True, missing fonts are fetched on demand from the URLs below.
DOWNLOAD_FONTS: Final[bool] = True

# Default font filenames (resolved relative to the working directory).
THAI_PATH: Final[str] = "NotoSansThai-Regular.ttf"
LATIN_PATH: Final[str] = "NotoSans-Regular.ttf"
JA_PATH: Final[str] = "NotoSansCJKjp-Regular.otf"
ZH_SC_PATH: Final[str] = "NotoSansCJKsc-Regular.otf"
ZH_TC_PATH: Final[str] = "NotoSansCJKtc-Regular.otf"

# NOTE: the Google Fonts repo reorganised away from the
# ``ofl/<family>/<family>-Regular.ttf`` naming used by the old API — those
# URLs now 404. We hit the dedicated notofonts.github.io mirrors (hinted TTFs)
# first, falling back to the notofonts GitHub repos, then jsDelivr as a CDN
# of last resort. Each list is tried in order until one returns >10 KB.
THAI_URLS: Final[list[str]] = [
    "https://notofonts.github.io/thai/fonts/NotoSansThai/hinted/ttf/NotoSansThai-Regular.ttf",
    "https://raw.githubusercontent.com/notofonts/thai/main/fonts/NotoSansThai/hinted/ttf/NotoSansThai-Regular.ttf",
    "https://cdn.jsdelivr.net/gh/notofonts/thai/fonts/NotoSansThai/hinted/ttf/NotoSansThai-Regular.ttf",
]
LATIN_URLS: Final[list[str]] = [
    "https://notofonts.github.io/latin-greek-cyrillic/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf",
    "https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/main/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf",
    "https://cdn.jsdelivr.net/gh/notofonts/latin-greek-cyrillic/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf",
]
JA_URLS: Final[list[str]] = [
    "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf",
    "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf",
    "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf",
]
ZH_SC_URLS: Final[list[str]] = [
    "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
    "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
    "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
]
ZH_TC_URLS: Final[list[str]] = [
    "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf",
    "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf",
    "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf",
]


def latin_font_for_lang(lang: str) -> tuple[str, list[str]]:
    """Return ``(default_path, download_urls)`` for the *non-Thai* font that
    should be paired with the Thai font when rendering ``lang``.

    For CJK targets we swap in the appropriate Noto CJK face; everyone else
    gets plain Noto Sans.
    """
    code = (lang or "").strip().lower().replace("_", "-")
    if code == "ja":
        return JA_PATH, JA_URLS
    if code in ("zh", "zh-hans", "zh-cn", "zh_cn", "zh_hans"):
        return ZH_SC_PATH, ZH_SC_URLS
    if code in ("zh-hant", "zh-tw", "zh_tw", "zh_hant"):
        return ZH_TC_PATH, ZH_TC_URLS
    return LATIN_PATH, LATIN_URLS
