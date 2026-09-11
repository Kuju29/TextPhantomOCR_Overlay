"""Service behind ``/ai/resolve`` and ``/ai/prompt/default``.

Given a (possibly partial) AI configuration, work out the concrete provider,
model, base URL and the list of models the user can pick from. Kept out of
the route module so it stays unit-testable.

The settings UI intentionally separates three questions:
1. Is this provider implemented by TextPhantom?
2. Is the supplied key accepted by the provider?
3. Is the selected model present in the provider's live model list?

The selectable model list is live-only: if the provider/key cannot enumerate a
model, the popup must not promise that model will work.
"""

from __future__ import annotations

from typing import Any, TypedDict

import hashlib

from backend.ai import prompts
# from backend.ai import providers as _provider_modules  # noqa: F401
from backend.ai.provider_registry import provider_registry
from backend.ai.provider_resolution import (
    canonical_provider,
    detect_provider_from_key,
    default_local_provider,
    is_local_provider,
    provider_key_mismatch,
    resolve_base_url,
    resolve_model,
)
from backend.ai.rate_policy import is_local_target
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
    model_capabilities: dict[str, Any]
    model_candidates: list[dict[str, Any]]

class EnumerationResult(TypedDict):
    models: list[str]
    source: str
    verified: bool
    status: str
    http_status: int
    error: str
    capabilities: dict[str, dict[str, Any]]
    candidates: dict[str, dict[str, Any]]

def _dedupe_sorted(models: list[str]) -> list[str]:
    """Case-insensitively dedupe and sort a model list."""
    return sorted(
        {m.strip() for m in models if isinstance(m, str) and m.strip()},
        key=str.lower,
    )

def _enumerate_models_detailed(provider: str, api_key: str, base_url: str) -> EnumerationResult:
    """Return only a live model list plus authentication/network status.

    Static/fallback IDs are intentionally excluded from the selectable list.
    """
    local = is_local_target(provider, base_url)

    spec = provider_registry.require(provider)
    listed = spec.adapter.list_models(api_key="" if local else api_key, base_url=base_url)
    from backend.ai.provider_resolution import (
        forget_model_capabilities, remember_model_capabilities, retain_model_promotions,
    )
    if listed.status == "valid":
        remember_model_capabilities(provider, base_url, api_key, dict(listed.capabilities))
        retain_model_promotions(provider, base_url, api_key, list(listed.models))
    else:
        forget_model_capabilities(provider, base_url, api_key)
    live = {"models": list(listed.models), "status": listed.status,
            "http_status": listed.http_status, "error": listed.error,
            "capabilities": dict(listed.capabilities),
            "candidates": dict(getattr(listed, "candidates", {}) or {})}

    usable_live = _dedupe_sorted(live["models"])
    from backend import trace
    candidate_values = list(live["candidates"].values())
    counts = {state: sum(1 for item in candidate_values
                         if isinstance(item, dict) and item.get("eligibility") == state)
              for state in ("usable", "unknown", "blocked")}
    unspecified = max(0, len(usable_live) - sum(counts.values()))
    trace.note("model_catalogue_completed", {
        "provider": provider, "status": live["status"],
        "httpStatus": live["http_status"], "modelCount": len(usable_live),
        "usableCount": counts["usable"], "unknownCount": counts["unknown"] + unspecified,
        "blockedCount": counts["blocked"], "accountScope": hashlib.sha256(api_key.encode()).hexdigest()[:12],
    }, file="ai/resolve.py")
    if live["status"] == "valid":
        # A successful provider catalogue is authoritative even when filtering
        # leaves zero translation-compatible models. Do not turn an empty valid
        # list into an "unverified" state and then resurrect static guesses.
        return EnumerationResult(
            models=usable_live,
            source="live",
            verified=True,
            status=live["status"],
            http_status=live["http_status"],
            error=live["error"],
            capabilities=dict(live.get("capabilities") or {}),
            candidates=dict(live.get("candidates") or {}),
        )

    # Do not put guessed/static models in the picker. A cloud model appears only
    # after the selected provider/key (or server-owned key) returned it live.
    return EnumerationResult(
        models=[],
        source="none",
        verified=False,
        status=live["status"],
        http_status=live["http_status"],
        error=live["error"],
        capabilities={},
        candidates={},
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
    base_hint = str(payload.get("base_url") or "").strip()
    looks_local = is_local_target(prov_hint, base_hint)

    provider = prov_hint
    if provider in ("", "auto"):
        if candidate_key:
            provider = detect_provider_from_key(candidate_key)
            if not provider:
                return ResolveResult(
                    ok=False,
                    error="ambiguous_provider",
                    provider="",
                    default_model="",
                    model="",
                    models=[],
                    lang=lang,
                    prompt_editable_default=style_default,
                    backend_supported=False,
                    provider_protocol="",
                    key_status="unverified",
                    key_source=key_source,
                    key_verified=False,
                    models_source="none",
                    models_verified=False,
                    model_status="unverified",
                )
        elif looks_local:
            provider = default_local_provider()
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

    if not candidate_key and looks_local and provider not in provider_registry:
        provider = default_local_provider()

    # Never send a server-owned cloud key to a local/self-hosted endpoint.
    # Local providers use no credential (the model-list helper supplies only a
    # harmless placeholder header when required by an OpenAI-compatible server).
    local = is_local_target(provider, base_hint)
    api_key = "" if local else (supplied_key or server_key)
    key_source = "none" if local else ("user" if supplied_key else ("env" if api_key else "none"))

    mismatched_provider = provider_key_mismatch(provider, api_key) if api_key else ""
    if mismatched_provider:
        return ResolveResult(
            ok=False,
            error="provider_key_mismatch",
            provider=provider,
            default_model="",
            model="",
            models=[],
            lang=lang,
            prompt_editable_default=style_default,
            backend_supported=True,
            provider_protocol=(provider_registry.get(provider).protocol if provider_registry.get(provider) else ""),
            key_status="mismatch",
            key_source=key_source,
            key_verified=False,
            models_source="none",
            models_verified=False,
            models_error=f"key belongs to {mismatched_provider}",
            model_status="unverified",
        )

    spec = provider_registry.get(provider)
    protocol = spec.protocol if spec else ""
    backend_supported = bool(spec and spec.adapter and protocol)
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

    preset = {"model": spec.default_model, "base_url": spec.default_base_url} if spec else {}
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
    assert_ai_base_url_allowed(
        provider, base_url,
        user_key=not uses_server_key,
        key_present=bool(api_key),
    )

    remap_reason = ""
    if not requested_is_auto and resolved_model != requested_model:
        remap_reason = "retired_alias"

    enumeration = _enumerate_models_detailed(provider, api_key, base_url)
    models = enumeration["models"]
    live_verified = enumeration["verified"]
    from backend.ai.provider_resolution import model_is_promoted
    model_candidates = []
    for candidate_model in models:
        native = dict(enumeration.get("candidates", {}).get(candidate_model) or {})
        eligibility = str(native.get("eligibility") or "unknown")
        evidence = str(native.get("evidence") or "provider_catalogue_only")[:120]
        if model_is_promoted(provider, base_url, api_key, candidate_model):
            eligibility, evidence = "usable", "selected_generation_probe"
        if eligibility not in {"usable", "unknown", "blocked"}:
            eligibility = "unknown"
        model_candidates.append({"id": candidate_model, "eligibility": eligibility,
                                 "evidence": evidence,
                                 "capabilities": dict(enumeration["capabilities"].get(candidate_model) or {})})

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
    elif list_status == "forbidden":
        key_status = "forbidden"
        key_verified = False
    else:
        key_status = "unverified"
        key_verified = False

    # Auto may choose from the authoritative live list. An explicit user model
    # is never silently swapped to another model: missing means unavailable and
    # the popup must ask the user to choose one of the verified entries.
    if live_verified and requested_is_auto and resolved_model not in models and models:
        preset_model = str(preset.get("model", "") or "")
        resolved_model = preset_model if preset_model in models else models[0]
        remap_reason = remap_reason or "auto_live_selection"

    if live_verified:
        model_status = "available" if resolved_model in models else "unavailable"
    else:
        model_status = "unverified"

    # Authentication/plan failure is a real failure and never unlocks an
    # unverified fallback model list.
    ok = key_status not in ("invalid", "forbidden") and model_status != "unavailable"
    error = (
        "invalid_api_key" if key_status == "invalid"
        else "provider_access_forbidden" if key_status == "forbidden"
        else "model_unavailable" if model_status == "unavailable"
        else ""
    )

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
        model_capabilities=dict(enumeration["capabilities"].get(resolved_model) or {}),
        model_candidates=model_candidates,
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
        "canonicalPrompt": prompts.canonical_prompt_contract(
            code, want_memo=want_memo
        ),
    }
