"""Service behind ``/ai/resolve`` and ``/ai/prompt/default``.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

Given a (possibly partial) AI configuration, work out the concrete provider,
model, base URL and the list of models the user can pick from.  Kept out of
the route module so it stays unit-testable.
"""

from __future__ import annotations

from typing import Any, TypedDict

from backend.ai import prompts
from backend.ai.config import (
    GEMINI_FALLBACK_MODELS,
    HF_FALLBACK_MODELS,
    PROVIDER_DEFAULTS,
)
from backend.ai.providers import (
    canonical_provider,
    filter_chat_models,
    is_local_provider,
    detect_provider_from_key,
    gemini_models,
    hf_router_models,
    openai_compat_models,
    pick_hf_fallback_model,
    resolve_base_url,
    resolve_model,
)
from backend.lens.languages import normalize as normalize_lang


class ResolveResult(TypedDict, total=False):
    ok: bool
    error: str
    provider: str
    base_url: str
    default_model: str
    model: str
    models: list[str]
    prompt_editable_default: str
    lang: str
    # Transparency: what the user actually asked for, and whether it was
    # replaced (retired alias or missing from the provider's live list).
    requested_model: str
    model_remapped: bool
    model_remap_reason: str


def _dedupe_sorted(models: list[str]) -> list[str]:
    """Case-insensitively dedupe and sort a model list."""
    return sorted(
        {m.strip() for m in models if isinstance(m, str) and m.strip()},
        key=str.lower,
    )


def resolve(payload: dict[str, Any]) -> ResolveResult:
    """Resolve provider / model / models from a partial AI config payload."""
    api_key = str(payload.get("api_key") or "").strip()
    lang = normalize_lang(str(payload.get("lang") or "en"))
    style_default = prompts.lang_style(lang)

    # Local providers (Ollama / LM Studio / LocalAI) need NO key.  Detect them
    # from the provider name or a localhost base_url so the UI can resolve
    # models without a key.
    prov_hint = canonical_provider(str(payload.get("provider") or "auto"))
    base_hint = str(payload.get("base_url") or "").strip().lower()
    looks_local = (
        is_local_provider(prov_hint)
        or "localhost" in base_hint
        or "127.0.0.1" in base_hint
        or "0.0.0.0" in base_hint
    )

    if not api_key and not looks_local:
        return ResolveResult(
            ok=False,
            error="missing_api_key",
            provider="",
            default_model="",
            model="",
            models=[],
            lang=lang,
            prompt_editable_default=style_default,
        )

    provider = prov_hint
    if provider in ("", "auto"):
        provider = detect_provider_from_key(api_key) if api_key else "ollama"
    if not api_key and looks_local and provider not in PROVIDER_DEFAULTS:
        provider = "ollama"

    preset = PROVIDER_DEFAULTS.get(provider, {})
    requested_model = str(payload.get("model") or "auto").strip() or "auto"
    requested_is_auto = requested_model.lower() in ("", "auto")
    resolved_model = resolve_model(provider, requested_model)
    base_url = resolve_base_url(provider, str(payload.get("base_url") or "auto"))

    # Track WHY a user's explicit choice changed, so the client can tell them
    # instead of silently answering with a different model (e.g. a stored
    # gemini-2.0-flash remapped to 2.5 after Google retired the 2.0 family).
    remap_reason = ""
    if not requested_is_auto and resolved_model != requested_model:
        remap_reason = "retired_alias"

    models = _enumerate_models(provider, api_key, base_url, requested_model)
    if models and resolved_model not in models:
        if requested_is_auto or provider == "huggingface":
            # Auto-resolution landed on a model the endpoint doesn't list —
            # fall back to the first available one.
            resolved_model = models[0]
        else:
            # DYNAMIC self-heal: the user's explicit model is not on the
            # provider's LIVE list (retired/renamed after this build shipped).
            # Prefer the preset default when available, else the first live
            # model — and say so, instead of letting every call 404.
            preset_model = str(preset.get("model", "") or "")
            resolved_model = preset_model if preset_model in models else models[0]
            remap_reason = remap_reason or "not_in_live_list"

    return ResolveResult(
        ok=True,
        provider=provider,
        base_url=base_url,
        default_model=preset.get("model", ""),
        model=resolved_model,
        models=models,
        prompt_editable_default=style_default,
        requested_model=requested_model,
        model_remapped=bool(remap_reason),
        model_remap_reason=remap_reason,
    )


def _enumerate_models(provider: str, api_key: str, base_url: str, requested_model: str) -> list[str]:
    """Best-effort list of selectable models for ``provider``.

    Tries the provider's live ``/models`` endpoint, then falls back to the
    static defaults so the UI always has *something* to show.
    """
    models: list[str] = []

    if provider == "huggingface":
        if base_url:
            models = hf_router_models(api_key, base_url)
        if not models:
            models = list(HF_FALLBACK_MODELS)
    elif provider == "gemini":
        models = gemini_models(api_key) or list(GEMINI_FALLBACK_MODELS)
    elif provider == "anthropic":
        # Anthropic has no public model-list endpoint — use the preset.
        preset_model = PROVIDER_DEFAULTS.get("anthropic", {}).get("model", "")
        models = [preset_model] if preset_model else []
    else:  # openai-compatible (incl. local Ollama / LM Studio / LocalAI)
        # Local servers accept any/no bearer; send a placeholder so the
        # /models enumeration still works without a real key.
        # Local providers get a very short timeout: when the backend runs in
        # the cloud, the user's localhost/LAN URL is unreachable from here and
        # must fail fast instead of hanging the resolve call.
        key_for_list = api_key or ("local" if is_local_provider(provider) else "")
        local = is_local_provider(provider)
        from backend.ai.providers import LIST_TIMEOUT_SEC, LOCAL_LIST_TIMEOUT_SEC
        models = openai_compat_models(
            key_for_list, base_url,
            timeout_sec=LOCAL_LIST_TIMEOUT_SEC if local else LIST_TIMEOUT_SEC,
        )
        # Cloud /models endpoints list speech/embedding/image/moderation models
        # too — hide everything that cannot answer a translation prompt.
        models = filter_chat_models(provider, models)
        if not models:
            preset_model = PROVIDER_DEFAULTS.get(provider, {}).get("model", "")
            models = [preset_model] if preset_model else []

    return _dedupe_sorted(models)


def prompt_default(lang: str) -> dict[str, Any]:
    """Return the default prompt pieces for ``lang`` (for ``/ai/prompt/default``)."""
    code = normalize_lang(lang)
    style = prompts.lang_style(code)
    system_text = prompts.build_system_text(code)
    return {
        "ok": True,
        "lang": code,
        "prompt_editable_default": style,
        "lang_style": style,
        "system_base": prompts.SYSTEM_BASE.strip(),
        "system_text": system_text,
    }
