"""Language list and code normalisation shared across the backend.

The list of UI languages is what the Chrome extension shows in its picker.
``normalize`` is the canonical helper used everywhere a user-supplied code
needs to be coerced into the form Google Lens expects.
"""

from __future__ import annotations

from typing import Final, TypedDict


class LanguageEntry(TypedDict):
    code: str
    name: str


UI_LANGUAGES: Final[list[LanguageEntry]] = [
    {"code": "en", "name": "English"},
    {"code": "th", "name": "Thai"},
    {"code": "ja", "name": "Japanese"},
    {"code": "ko", "name": "Korean"},
    {"code": "zh-CN", "name": "Chinese (Simplified)"},
    {"code": "zh-TW", "name": "Chinese (Traditional)"},
    {"code": "vi", "name": "Vietnamese"},
    {"code": "id", "name": "Indonesian"},
    {"code": "ms", "name": "Malay"},
    {"code": "tl", "name": "Tagalog"},
    {"code": "fil", "name": "Filipino"},
    {"code": "hi", "name": "Hindi"},
    {"code": "bn", "name": "Bengali"},
    {"code": "ur", "name": "Urdu"},
    {"code": "ta", "name": "Tamil"},
    {"code": "te", "name": "Telugu"},
    {"code": "ml", "name": "Malayalam"},
    {"code": "mr", "name": "Marathi"},
    {"code": "gu", "name": "Gujarati"},
    {"code": "kn", "name": "Kannada"},
    {"code": "pa", "name": "Punjabi"},
    {"code": "ne", "name": "Nepali"},
    {"code": "si", "name": "Sinhala"},
    {"code": "my", "name": "Myanmar (Burmese)"},
    {"code": "km", "name": "Khmer"},
    {"code": "lo", "name": "Lao"},
    {"code": "jv", "name": "Javanese"},
    {"code": "su", "name": "Sundanese"},
    {"code": "es", "name": "Spanish"},
    {"code": "fr", "name": "French"},
    {"code": "de", "name": "German"},
    {"code": "it", "name": "Italian"},
    {"code": "pt", "name": "Portuguese"},
    {"code": "nl", "name": "Dutch"},
    {"code": "pl", "name": "Polish"},
    {"code": "ro", "name": "Romanian"},
    {"code": "ru", "name": "Russian"},
    {"code": "uk", "name": "Ukrainian"},
    {"code": "cs", "name": "Czech"},
    {"code": "sk", "name": "Slovak"},
    {"code": "sl", "name": "Slovenian"},
    {"code": "hr", "name": "Croatian"},
    {"code": "sr", "name": "Serbian"},
    {"code": "bs", "name": "Bosnian"},
    {"code": "bg", "name": "Bulgarian"},
    {"code": "mk", "name": "Macedonian"},
    {"code": "el", "name": "Greek"},
    {"code": "tr", "name": "Turkish"},
    {"code": "hu", "name": "Hungarian"},
    {"code": "fi", "name": "Finnish"},
    {"code": "sv", "name": "Swedish"},
    {"code": "da", "name": "Danish"},
    {"code": "no", "name": "Norwegian"},
    {"code": "et", "name": "Estonian"},
    {"code": "lv", "name": "Latvian"},
    {"code": "lt", "name": "Lithuanian"},
    {"code": "is", "name": "Icelandic"},
    {"code": "ga", "name": "Irish"},
    {"code": "cy", "name": "Welsh"},
    {"code": "mt", "name": "Maltese"},
    {"code": "sq", "name": "Albanian"},
    {"code": "hy", "name": "Armenian"},
    {"code": "ka", "name": "Georgian"},
    {"code": "az", "name": "Azerbaijani"},
    {"code": "kk", "name": "Kazakh"},
    {"code": "ky", "name": "Kyrgyz"},
    {"code": "tg", "name": "Tajik"},
    {"code": "uz", "name": "Uzbek"},
    {"code": "tk", "name": "Turkmen"},
    {"code": "mn", "name": "Mongolian"},
    {"code": "ar", "name": "Arabic"},
    {"code": "fa", "name": "Persian"},
    {"code": "iw", "name": "Hebrew"},
    {"code": "ps", "name": "Pashto"},
    {"code": "ug", "name": "Uyghur"},
    {"code": "ku", "name": "Kurdish (Kurmanji)"},
    {"code": "sw", "name": "Swahili"},
    {"code": "am", "name": "Amharic"},
    {"code": "ha", "name": "Hausa"},
    {"code": "ig", "name": "Igbo"},
    {"code": "yo", "name": "Yoruba"},
    {"code": "zu", "name": "Zulu"},
    {"code": "xh", "name": "Xhosa"},
    {"code": "so", "name": "Somali"},
    {"code": "rw", "name": "Kinyarwanda"},
    {"code": "mg", "name": "Malagasy"},
    {"code": "af", "name": "Afrikaans"},
    {"code": "ca", "name": "Catalan"},
    {"code": "eu", "name": "Basque"},
    {"code": "gl", "name": "Galician"},
    {"code": "eo", "name": "Esperanto"},
    {"code": "be", "name": "Belarusian"},
    {"code": "ceb", "name": "Cebuano"},
    {"code": "co", "name": "Corsican"},
    {"code": "fy", "name": "Frisian"},
    {"code": "haw", "name": "Hawaiian"},
    {"code": "hmn", "name": "Hmong"},
    {"code": "ht", "name": "Haitian Creole"},
    {"code": "lb", "name": "Luxembourgish"},
    {"code": "la", "name": "Latin"},
    {"code": "mi", "name": "Maori"},
    {"code": "or", "name": "Odia (Oriya)"},
    {"code": "gd", "name": "Scots Gaelic"},
    {"code": "sm", "name": "Samoan"},
    {"code": "sn", "name": "Shona"},
    {"code": "st", "name": "Sesotho"},
    {"code": "sd", "name": "Sindhi"},
    {"code": "tt", "name": "Tatar"},
    {"code": "yi", "name": "Yiddish"},
    {"code": "ny", "name": "Chichewa"},
]


# Canonical lowercase -> Lens-expected casing.
_LENS_CASE_MAP: Final[dict[str, str]] = {
    "zh-cn": "zh-CN",
    "zh-tw": "zh-TW",
    "zh_hans": "zh-CN",
    "zh-hans": "zh-CN",
    "zh_cn": "zh-CN",
    "zh_hant": "zh-TW",
    "zh-hant": "zh-TW",
    "zh_tw": "zh-TW",
}


def normalize(lang: str | None) -> str:
    """Coerce a user-supplied language code to Lens form.

    - Trims whitespace.
    - Lowercases everything except a small map of locales that Lens expects in
      mixed case (``zh-CN``, ``zh-TW``).
    - Maps common aliases (``zh_hans`` etc.) onto their canonical form.
    - Falls back to ``"en"`` when the input is empty.
    """
    raw = (lang or "").strip()
    if not raw:
        return "en"
    low = raw.lower().replace("_", "-")
    if low in _LENS_CASE_MAP:
        return _LENS_CASE_MAP[low]
    return low


def is_cjk(lang: str) -> bool:
    """True for codes that need CJK fonts (Japanese / Chinese / Korean)."""
    n = normalize(lang)
    return n in {"ja", "ko", "zh", "zh-cn", "zh-tw"}
