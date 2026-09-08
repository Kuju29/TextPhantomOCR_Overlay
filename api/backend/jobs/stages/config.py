"""Request configuration owned by the job pipeline."""

from __future__ import annotations

from backend.ai.rate_policy import is_local_target
from backend.ai.translation.contracts import AiConfig
from backend.config import settings

def layout_options(payload: dict | None) -> dict[str, bool]:
    request = payload if isinstance(payload, dict) else {}
    layout = request.get("layout") if isinstance(request.get("layout"), dict) else {}

    def flag(key: str, default: bool) -> bool:
        value = layout.get(key, default)
        if value is None:
            value = default
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    render = request.get("render") if isinstance(request.get("render"), dict) else {}
    background_mode = str(render.get("background") or "").strip().lower()
    if background_mode not in {"", "image", "boxes"}:
        raise ValueError(f"render.background must be one of ('image', 'boxes'), got {render.get('background')!r}")
    return {
        "relayout_translated": flag(
            "relayout_translated", bool(getattr(settings, "relayout_translated", True))
        ),
        "client_background": background_mode == "boxes",
        "lens_document": bool(render.get("lensDocument")),
    }

def build_ai_config(payload: dict, mode: str, source: str) -> AiConfig | None:
    ai = payload.get("ai")
    if mode != "lens_text" or source != "ai" or not isinstance(ai, dict):
        return None
    provider = str(ai.get("provider") or "auto").strip() or "auto"
    base_url = str(ai.get("base_url") or "auto").strip() or "auto"
    user_key = str(ai.get("api_key") or "").strip()
    api_key = user_key or ("" if is_local_target(provider, base_url) else settings.ai_api_key)
    prompt_mode = str(ai.get("prompt_mode") or "").strip().lower()
    if prompt_mode != "replace":
        raise ValueError("ai.prompt_mode must be exactly 'replace'")
    prompt = str(ai.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("AI_PROMPT_REQUIRED: AI Style is empty; Reload the built-in prompt and save it")
    return AiConfig(
        api_key=api_key,
        user_key=bool(user_key),
        model=str(ai.get("model") or "auto").strip() or "auto",
        provider=provider,
        base_url=base_url,
        prompt_editable=prompt,
        prompt_mode=prompt_mode,
        glossary=ai.get("glossary") if isinstance(ai.get("glossary"), list) else [],
        characters=ai.get("characters") if isinstance(ai.get("characters"), list) else [],
        char_memory=bool(ai.get("char_memory", True)),
        send_image=(ai.get("send_image").strip().lower() if isinstance(ai.get("send_image"), str) else bool(ai.get("send_image"))),
        thinking=str(ai.get("thinking") or "off").strip().lower() or "off",
        # One image is one billable provider generation.  Do not let a client
        # payload re-enable the legacy second content-repair request.
        repair_enabled=False,
        series_state=str(ai.get("series_state") or "").strip(),
        speakers=ai.get("speakers") if isinstance(ai.get("speakers"), dict) else {},
        prev_context=ai.get("prev_context") if isinstance(ai.get("prev_context"), list) else [],
        context_frozen=bool(ai.get("context_frozen", False)),
    )
