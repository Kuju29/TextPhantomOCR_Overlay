"""Service behind ``/ai/resolve`` and ``/ai/prompt/default``.

Given a (possibly partial) AI configuration, work out the concrete provider,
model, base URL and the list of models the user can pick from. Kept out of
the route module so it stays unit-testable.

The settings UI intentionally separates three questions:
1. Is this provider implemented by TextPhantom?
2. Is the supplied key accepted by the provider?
3. Is the selected model present in the provider's live model list?

A static fallback is still useful while no key is present or a provider is
temporarily unreachable, but it is never reported as verified.
"""

from __future__ import annotations

import hashlib
from typing import Any, TypedDict

from backend.ai import prompts
from backend.ai.config import (
    GEMINI_FALLBACK_MODELS,
    HF_FALLBACK_MODELS,
    PROVIDER_DEFAULTS,
    PROVIDER_PROTOCOLS,
)
from backend.ai.providers import (
    anthropic_models_status,
    canonical_provider,
    detect_provider_from_key,
    filter_chat_models,
    gemini_models_status,
    is_local_provider,
    openai_compat_models_status,
    resolve_base_url,
    resolve_model,
)
from backend.config import settings
from backend.lens.languages import normalize as normalize_lang
from backend.security import assert_ai_base_url_allowed


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
    requested_model: str
    model_remapped: bool
    model_remap_reason: str
    backend_supported: bool
    provider_protocol: str
    key_status: str
    key_source: str
    key_verified: bool
    models_source: str
    models_verified: bool
    models_http_status: int
    models_error: str
    model_status: str


class EnumerationResult(TypedDict):
    models: list[str]
    source: str
    verified: bool
    status: str
    http_status: int
    error: str


def _dedupe_sorted(models: list[str]) -> list[str]:
    """Case-insensitively dedupe and sort a model list."""
    return sorted(
        {m.strip() for m in models if isinstance(m, str) and m.strip()},
        key=str.lower,
    )


def _fallback_models(provider: str) -> list[str]:
    if provider == "gemini":
        return list(GEMINI_FALLBACK_MODELS)
    if provider == "huggingface":
        return list(HF_FALLBACK_MODELS)
    preset_model = str(PROVIDER_DEFAULTS.get(provider, {}).get("model", "") or "")
    return [preset_model] if preset_model else []


def _enumerate_models_detailed(provider: str, api_key: str, base_url: str) -> EnumerationResult:
    """Return a live model list plus authentication/network status.

    Static models are supplied only when a live list is unavailable. The
    caller can therefore keep the picker useful without mistaking fallback
    data for a verified credential/model list.
    """
    local = is_local_provider(provider)

    if provider == "gemini":
        live = gemini_models_status(api_key)
    elif provider == "anthropic":
        live = anthropic_models_status(api_key)
    else:
        # Every other provider in PROVIDER_PROTOCOLS uses the OpenAI-compatible
        # /models + /chat/completions dialect. Local servers accept no key, so
        # a harmless placeholder is used only for the Authorization header.
        key_for_list = api_key or ("local" if local else "")
        from backend.ai.providers import LIST_TIMEOUT_SEC, LOCAL_LIST_TIMEOUT_SEC

        live = openai_compat_models_status(
            key_for_list,
            base_url,
            timeout_sec=LOCAL_LIST_TIMEOUT_SEC if local else LIST_TIMEOUT_SEC,
        )
        if live["status"] == "valid":
            live["models"] = filter_chat_models(provider, live["models"])

    usable_live = _dedupe_sorted(live["models"])
    if usable_live:
        return EnumerationResult(
            models=usable_live,
            source="live",
            verified=True,
            status=live["status"],
            http_status=live["http_status"],
            error=live["error"],
        )

    return EnumerationResult(
        models=_dedupe_sorted(_fallback_models(provider)),
        source="fallback",
        verified=False,
        status=live["status"],
        http_status=live["http_status"],
        error=live["error"],
    )


def resolve(payload: dict[str, Any]) -> ResolveResult:
    """Resolve provider/model while keeping support/auth/list status explicit."""
    supplied_key = str(payload.get("api_key") or "").strip()
    server_key = str(settings.ai_api_key or "").strip()
    candidate_key = supplied_key or server_key
    key_source = "user" if supplied_key else ("env" if candidate_key else "none")
    lang = normalize_lang(str(payload.get("lang") or "en"))
    style_default = prompts.lang_style(lang)

    prov_hint = canonical_provider(str(payload.get("provider") or "auto"))
    base_hint = str(payload.get("base_url") or "").strip().lower()
    looks_local = (
        is_local_provider(prov_hint)
        or "localhost" in base_hint
        or "127.0.0.1" in base_hint
        or "0.0.0.0" in base_hint
    )

    provider = prov_hint
    if provider in ("", "auto"):
        if candidate_key:
            provider = detect_provider_from_key(candidate_key)
        elif looks_local:
            provider = "ollama"
        else:
            return ResolveResult(
                ok=False,
                error="missing_api_key",
                provider="",
                default_model="",
                model="",
                models=[],
                lang=lang,
                prompt_editable_default=style_default,
                backend_supported=False,
                provider_protocol="",
                key_status="missing",
                key_source=key_source,
                key_verified=False,
                models_source="none",
                models_verified=False,
                model_status="unverified",
            )

    if not candidate_key and looks_local and provider not in PROVIDER_DEFAULTS:
        provider = "ollama"

    # Never send a server-owned cloud key to a local/self-hosted endpoint.
    # Local providers use no credential (the model-list helper supplies only a
    # harmless placeholder header when required by an OpenAI-compatible server).
    local = is_local_provider(provider)
    api_key = supplied_key or ("" if local else server_key)
    key_source = "user" if supplied_key else ("env" if api_key else "none")

    protocol = str(PROVIDER_PROTOCOLS.get(provider) or "")
    backend_supported = bool(provider in PROVIDER_DEFAULTS and protocol)
    if not backend_supported:
        return ResolveResult(
            ok=False,
            error="unsupported_provider",
            provider=provider,
            default_model="",
            model="",
            models=[],
            lang=lang,
            prompt_editable_default=style_default,
            backend_supported=False,
            provider_protocol="",
            key_status="not_required" if is_local_provider(provider) else ("missing" if not api_key else "unverified"),
            key_source=key_source,
            key_verified=False,
            models_source="none",
            models_verified=False,
            model_status="unsupported",
        )

    preset = PROVIDER_DEFAULTS.get(provider, {})
    requested_model = str(payload.get("model") or "auto").strip() or "auto"
    requested_is_auto = requested_model.lower() in ("", "auto")
    resolved_model = resolve_model(provider, requested_model)
    base_url = resolve_base_url(provider, str(payload.get("base_url") or "auto"))
    # This guard exists to stop the SERVER-OWNED key from being posted to an
    # arbitrary host. It must therefore fire only when that key is what would
    # actually be sent. A user-supplied key, a local provider, or a server with
    # no AI_API_KEY at all are none of them cases the guard protects — refusing
    # those turned plain settings discovery ("pick a provider, list its models
    # before typing a key") into an unhandled exception.
    uses_server_key = bool(server_key) and not supplied_key and not local
    assert_ai_base_url_allowed(provider, base_url, user_key=not uses_server_key)

    remap_reason = ""
    if not requested_is_auto and resolved_model != requested_model:
        remap_reason = "retired_alias"

    enumeration = _enumerate_models_detailed(provider, api_key, base_url)
    models = enumeration["models"]
    live_verified = enumeration["verified"]

    list_status = enumeration["status"]
    if local:
        key_status = "not_required"
        key_verified = True
    elif not api_key:
        key_status = "missing"
        key_verified = False
    elif list_status == "valid":
        key_status = "valid"
        key_verified = True
    elif list_status == "invalid_key":
        key_status = "invalid"
        key_verified = False
    else:
        key_status = "unverified"
        key_verified = False

    # Only a LIVE provider list is authoritative enough to replace an explicit
    # stored model. Fallback/known models must never reset a user's pinned id.
    if live_verified and models and resolved_model not in models:
        if requested_is_auto:
            preset_model = str(preset.get("model", "") or "")
            resolved_model = preset_model if preset_model in models else models[0]
        else:
            preset_model = str(preset.get("model", "") or "")
            resolved_model = preset_model if preset_model in models else models[0]
            remap_reason = remap_reason or "not_in_live_list"

    if live_verified:
        model_status = "available" if resolved_model in models else "unavailable"
    else:
        model_status = "unverified"

    # Authentication failure is a real failure even though we still return the
    # fallback list for UI continuity. This is the key change that prevents a
    # 401/403 from looking like a successful resolution.
    ok = key_status != "invalid"
    error = "invalid_api_key" if key_status == "invalid" else ""

    return ResolveResult(
        ok=ok,
        **({"error": error} if error else {}),
        provider=provider,
        base_url=base_url,
        default_model=str(preset.get("model", "") or ""),
        model=resolved_model,
        models=models,
        prompt_editable_default=style_default,
        lang=lang,
        requested_model=requested_model,
        model_remapped=bool(remap_reason),
        model_remap_reason=remap_reason,
        backend_supported=backend_supported,
        provider_protocol=protocol,
        key_status=key_status,
        key_source=key_source,
        key_verified=key_verified,
        models_source=enumeration["source"],
        models_verified=live_verified,
        models_http_status=enumeration["http_status"],
        models_error=enumeration["error"],
        model_status=model_status,
    )


def prompt_default(lang: str, *, want_memo: bool = True) -> dict[str, Any]:
    """Return the default prompt pieces for ``lang`` (for ``/ai/prompt/default``)."""
    code = normalize_lang(lang)
    style = prompts.lang_style(code)
    system_text = prompts.build_system_text(code, want_memo=want_memo)
    metadata = prompts.prompt_metadata(code)
    return {
        "ok": True,
        "lang": code,
        "prompt_editable_default": style,
        "lang_style": style,
        "system_base": prompts.SYSTEM_BASE.strip(),
        "system_text": system_text,
        "want_memo": bool(want_memo),
        **metadata,
        "systemPromptHash": hashlib.sha256(system_text.encode("utf-8")).hexdigest(),
        "systemPromptChars": len(system_text),
    }
