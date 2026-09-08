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
# RTL scripts. Arabic covers Arabic/Persian/Urdu; Hebrew is its own block.
AR_PATH: Final[str] = "NotoSansArabic-Regular.ttf"
HE_PATH: Final[str] = "NotoSansHebrew-Regular.ttf"

_NOTO_ARCHIVE_COMMIT: Final[str] = "bf20559450ec75aec7a646b208343540a4496262"
_NOTO_CJK_COMMIT: Final[str] = "f8d157532fbfaeda587e826d4cd5b21a49186f7c"

def _noto_urls(family: str) -> list[str]:
    filename = f"{family}-Regular.ttf"
    artifact = f"phaseIII_only/hinted/ttf/{family}/{filename}"
    return [
        f"https://raw.githubusercontent.com/notofonts/noto-fonts/{_NOTO_ARCHIVE_COMMIT}/{artifact}",
        f"https://github.com/notofonts/noto-fonts/raw/{_NOTO_ARCHIVE_COMMIT}/{artifact}",
        f"https://cdn.jsdelivr.net/gh/notofonts/noto-fonts@{_NOTO_ARCHIVE_COMMIT}/{artifact}",
    ]

def _cjk_urls(region: str, filename: str) -> list[str]:
    artifact = f"Sans/OTF/{region}/{filename}"
    return [
        f"https://raw.githubusercontent.com/notofonts/noto-cjk/{_NOTO_CJK_COMMIT}/{artifact}",
        f"https://github.com/notofonts/noto-cjk/raw/{_NOTO_CJK_COMMIT}/{artifact}",
        f"https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@{_NOTO_CJK_COMMIT}/{artifact}",
    ]

# Keep a version-pinned upstream first.  The old notofonts.github.io Latin
# artifact path returned 404, and ``main`` URLs can change underneath a
# deployed build.  Each list is tried in order until a valid font is found.
THAI_URLS: Final[list[str]] = _noto_urls("NotoSansThai")
LATIN_URLS: Final[list[str]] = _noto_urls("NotoSans")
JA_URLS: Final[list[str]] = _cjk_urls("Japanese", JA_PATH)
ZH_SC_URLS: Final[list[str]] = _cjk_urls("SimplifiedChinese", ZH_SC_PATH)
ZH_TC_URLS: Final[list[str]] = _cjk_urls("TraditionalChinese", ZH_TC_PATH)
AR_URLS: Final[list[str]] = _noto_urls("NotoSansArabic")
HE_URLS: Final[list[str]] = _noto_urls("NotoSansHebrew")

_SCRIPT_FAMILIES: Final[dict[str, str]] = {
    "hangul": "NotoSansCJKkr-Regular.otf",
    "devanagari": "NotoSansDevanagari-Regular.ttf",
    "bengali": "NotoSansBengali-Regular.ttf",
    "tamil": "NotoSansTamil-Regular.ttf",
    "telugu": "NotoSansTelugu-Regular.ttf",
    "malayalam": "NotoSansMalayalam-Regular.ttf",
    "gujarati": "NotoSansGujarati-Regular.ttf",
    "gurmukhi": "NotoSansGurmukhi-Regular.ttf",
    "kannada": "NotoSansKannada-Regular.ttf",
    "sinhala": "NotoSansSinhala-Regular.ttf",
    "myanmar": "NotoSansMyanmar-Regular.ttf",
    "khmer": "NotoSansKhmer-Regular.ttf",
    "lao": "NotoSansLao-Regular.ttf",
    "armenian": "NotoSansArmenian-Regular.ttf",
    "georgian": "NotoSansGeorgian-Regular.ttf",
    "ethiopic": "NotoSansEthiopic-Regular.ttf",
    "odia": "NotoSansOriya-Regular.ttf",
}

SCRIPT_FONT_CONFIG: Final[dict[str, tuple[str, list[str]]]] = {
    "latin": (LATIN_PATH, LATIN_URLS),
    "thai": (THAI_PATH, THAI_URLS),
    "cjk-ja": (JA_PATH, JA_URLS),
    "cjk-sc": (ZH_SC_PATH, ZH_SC_URLS),
    "cjk-tc": (ZH_TC_PATH, ZH_TC_URLS),
    "arabic": (AR_PATH, AR_URLS),
    "hebrew": (HE_PATH, HE_URLS),
}
for _script, _filename in _SCRIPT_FAMILIES.items():
    if _script == "hangul":
        SCRIPT_FONT_CONFIG[_script] = (_filename, _cjk_urls("Korean", _filename))
    else:
        SCRIPT_FONT_CONFIG[_script] = (_filename, _noto_urls(_filename.removesuffix("-Regular.ttf")))

_LANGUAGE_SCRIPTS: Final[dict[str, str]] = {
    "th": "thai", "ja": "cjk-ja", "ko": "hangul",
    "zh": "cjk-sc", "zh-cn": "cjk-sc", "zh-tw": "cjk-tc",
    "ar": "arabic", "fa": "arabic", "ur": "arabic", "ps": "arabic",
    "ug": "arabic", "sd": "arabic", "ckb": "arabic",
    "iw": "hebrew", "he": "hebrew", "yi": "hebrew",
    "hi": "devanagari", "mr": "devanagari", "ne": "devanagari",
    "bn": "bengali", "ta": "tamil", "te": "telugu", "ml": "malayalam",
    "gu": "gujarati", "pa": "gurmukhi", "kn": "kannada", "si": "sinhala",
    "my": "myanmar", "km": "khmer", "lo": "lao", "hy": "armenian",
    "ka": "georgian", "am": "ethiopic", "or": "odia",
}

def script_for_lang(lang: str) -> str:
    code = (lang or "").strip().lower().replace("_", "-")
    return _LANGUAGE_SCRIPTS.get(code, "latin")

def latin_font_for_lang(lang: str) -> tuple[str, list[str]]:
    """Return ``(default_path, download_urls)`` for the *non-Thai* font that
    should be paired with the Thai font when rendering ``lang``.

    For CJK targets we swap in the appropriate Noto CJK face, for RTL targets
    the matching Arabic / Hebrew face; everyone else gets plain Noto Sans.
    """
    code = (lang or "").strip().lower().replace("_", "-")
    # Thai is always loaded in the dedicated first slot of ``font_pair``.
    # The second slot must remain the Latin fallback for mixed strings such as
    # "ทดสอบ AI 123"; returning Noto Sans Thai here makes the U+0041 warmup
    # probe fail even though Thai rendering itself is healthy.
    if code == "th":
        return SCRIPT_FONT_CONFIG["latin"]
    aliases = {"zh-hans": "zh-cn", "zh-hant": "zh-tw"}
    script = script_for_lang(aliases.get(code, code).split("-", 1)[0] if code not in ("zh-cn", "zh-tw") else code)
    return SCRIPT_FONT_CONFIG[script]
