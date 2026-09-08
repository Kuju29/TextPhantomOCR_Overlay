from __future__ import annotations
from typing import Final

import hashlib, hmac, os

from backend.lens.languages import normalize as _normalize_lang
from .styles import PROMPT_POLICY_VERSION, normalize_prompt_mode, select_style

_PROMPT_TRACE_SESSION_KEY: Final[bytes] = os.urandom(32)

def prompt_metadata(
    lang: str, prompt_override: str = "", prompt_mode: str = "replace"
) -> dict[str, str | int]:
    """Describe the effective editable style without exposing its contents."""
    code = _normalize_lang(lang)
    style, source = select_style(code, prompt_override, prompt_mode)
    digest = hashlib.sha256(style.encode("utf-8")).hexdigest()
    version = PROMPT_POLICY_VERSION.get(code, f"{code}-style-1")
    if source == "saved_custom_replace":
        version = "custom"
    elif source == "built_in_plus_series_notes":
        version = version + "+notes"
    return {
        "promptVersion": version,
        "promptHash": digest,
        "promptChars": len(style),
        "promptSource": source,
    }

def prompt_trace_metadata(
    lang: str,
    prompt_override: str = "",
    *,
    prompt_mode: str = "replace",
    effective_system_text: str = "",
) -> dict[str, str | int | bool]:
    """Privacy-safe runtime prompt audit scoped to this server process.

    Unlike the public default-prompt content hash, this fingerprint cannot be
    correlated across server restarts and never exposes custom prompt text.
    """
    code = _normalize_lang(lang)
    style, source = select_style(code, prompt_override, prompt_mode)
    override = (prompt_override or "").strip()
    effective = str(effective_system_text or style)
    style_fingerprint = hmac.new(
        _PROMPT_TRACE_SESSION_KEY, style.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    fingerprint = hmac.new(
        _PROMPT_TRACE_SESSION_KEY, effective.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    version = PROMPT_POLICY_VERSION.get(code, f"{code}-style-1")
    if source == "saved_custom_replace":
        version = "custom"
    elif source == "built_in_plus_series_notes":
        version += "+notes"
    return {
        "targetLang": code,
        "promptVersion": version,
        "promptSource": source,
        "promptMode": normalize_prompt_mode(prompt_mode),
        "userPromptPresent": bool(override),
        "userPromptChars": len(override),
        "effectiveStyleChars": len(style),
        "effectiveStyleFingerprint": style_fingerprint,
        "effectiveSystemPromptChars": len(effective),
        "effectiveSystemPromptFingerprint": fingerprint,
    }
