"""Static font configuration: which TTF/OTF to use per script, and where to

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
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
# RTL scripts. Arabic covers Arabic/Persian/Urdu; Hebrew is its own block.
AR_PATH: Final[str] = "NotoSansArabic-Regular.ttf"
HE_PATH: Final[str] = "NotoSansHebrew-Regular.ttf"

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
AR_URLS: Final[list[str]] = [
    "https://notofonts.github.io/arabic/fonts/NotoSansArabic/hinted/ttf/NotoSansArabic-Regular.ttf",
    "https://raw.githubusercontent.com/notofonts/arabic/main/fonts/NotoSansArabic/hinted/ttf/NotoSansArabic-Regular.ttf",
    "https://cdn.jsdelivr.net/gh/notofonts/arabic/fonts/NotoSansArabic/hinted/ttf/NotoSansArabic-Regular.ttf",
]
HE_URLS: Final[list[str]] = [
    "https://notofonts.github.io/hebrew/fonts/NotoSansHebrew/hinted/ttf/NotoSansHebrew-Regular.ttf",
    "https://raw.githubusercontent.com/notofonts/hebrew/main/fonts/NotoSansHebrew/hinted/ttf/NotoSansHebrew-Regular.ttf",
    "https://cdn.jsdelivr.net/gh/notofonts/hebrew/fonts/NotoSansHebrew/hinted/ttf/NotoSansHebrew-Regular.ttf",
]


def latin_font_for_lang(lang: str) -> tuple[str, list[str]]:
    """Return ``(default_path, download_urls)`` for the *non-Thai* font that
    should be paired with the Thai font when rendering ``lang``.

    For CJK targets we swap in the appropriate Noto CJK face, for RTL targets
    the matching Arabic / Hebrew face; everyone else gets plain Noto Sans.
    """
    code = (lang or "").strip().lower().replace("_", "-")
    if code == "ja":
        return JA_PATH, JA_URLS
    if code in ("zh", "zh-hans", "zh-cn", "zh_cn", "zh_hans"):
        return ZH_SC_PATH, ZH_SC_URLS
    if code in ("zh-hant", "zh-tw", "zh_tw", "zh_hant"):
        return ZH_TC_PATH, ZH_TC_URLS
    # Primary subtag handles regional variants (e.g. ``ar-EG`` -> ``ar``).
    primary = code.split("-", 1)[0]
    # Arabic script also serves Persian (fa) and Urdu (ur).
    if primary in ("ar", "fa", "ur", "ps", "ckb", "ku", "sd", "ug"):
        return AR_PATH, AR_URLS
    # Hebrew block; Lens reports Hebrew as "iw".
    if primary in ("he", "iw", "yi"):
        return HE_PATH, HE_URLS
    return LATIN_PATH, LATIN_URLS
