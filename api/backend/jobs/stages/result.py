"""Result metadata and cache-admission helpers for the job pipeline."""

from __future__ import annotations

from typing import Any

from backend.ai.translation.contracts import AiConfig

def result_worth_caching(mode: str, source: str, out: dict[str, Any]) -> bool:
    """Return whether a non-empty pipeline result is safe to cache."""
    if mode == "lens_images":
        return bool(out.get("imageDataUri"))
    if source == "ai":
        ai = out.get("Ai") or {}
        return bool(ai.get("aihtml"))
    has_overlay = bool(
        (out.get("original") or {}).get("originalhtml")
        or (out.get("translated") or {}).get("translatedhtml")
    )
    has_text = bool(
        str(out.get("originalTextFull") or "").strip()
        or out.get("originalParagraphs")
        or out.get("translatedParagraphs")
    )
    return has_overlay and has_text

def attach_ai_performance(perf: dict[str, Any], out: dict[str, Any], ai_cfg: AiConfig) -> None:
    """Attach content-free diagnostics describing the effective AI request."""
    ai_meta = (out.get("Ai") or {}).get("meta") or {}
    perf.update(
        {
            "ai_send_image": str(getattr(ai_cfg, "send_image", False)),
            "ai_vision": bool(ai_meta.get("vision")),
            "ai_thinking": str(getattr(ai_cfg, "thinking", "off")),
            "ai_model": str(ai_meta.get("model") or ""),
            "ai_glossary": len(getattr(ai_cfg, "glossary", None) or []),
            "ai_characters_in": len(getattr(ai_cfg, "characters", None) or []),
            "ai_characters_out": len(ai_meta.get("characters") or []),
            "ai_series_state_chars": len(str(getattr(ai_cfg, "series_state", "") or "")),
            "ai_flow": str(ai_meta.get("ai_flow") or ""),
        }
    )
