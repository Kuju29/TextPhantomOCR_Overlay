from __future__ import annotations

from typing import Final
from backend.lens.languages import UI_LANGUAGES, normalize

_TARGET_NATIVE_NAMES: Final[dict[str, str]] = {
    "th": "ภาษาไทย", "ja": "日本語", "ko": "한국어", "zh-cn": "简体中文",
    "zh-tw": "繁體中文", "zh": "中文", "vi": "Tiếng Việt", "id": "Bahasa Indonesia",
    "ms": "Bahasa Melayu", "hi": "हिन्दी", "bn": "বাংলা", "ta": "தமிழ்",
    "te": "తెలుగు", "ar": "العربية", "fa": "فارسی", "iw": "עברית",
    "he": "עברית", "ru": "Русский", "uk": "Українська", "el": "Ελληνικά",
}

def target_language_priority(lang: str) -> str:
    raw = str(lang or "").strip()
    if not raw:
        return "Translate every source unit into the target language selected by the user."
    normalized = normalize(raw).lower()
    names = {str(item["code"]).lower(): str(item["name"]) for item in UI_LANGUAGES}
    code = normalized
    for candidate, candidate_name in names.items():
        native_name = _TARGET_NATIVE_NAMES.get(candidate) or _TARGET_NATIVE_NAMES.get(candidate.split("-")[0], "")
        aliases = {candidate, candidate_name.lower()}
        if native_name:
            aliases.update({native_name.lower(), f"{candidate_name.lower()} ({native_name.lower()})"})
        if normalized in aliases:
            code = candidate
            break
    name = names.get(code, raw)
    native = _TARGET_NATIVE_NAMES.get(code) or _TARGET_NATIVE_NAMES.get(code.split("-")[0], "")
    label = f"{name} ({native})" if native and native not in name else name
    return f"Translate every source unit into {label}."

