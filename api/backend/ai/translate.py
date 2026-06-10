"""High-level AI translation orchestration.

This is the single entry point the rest of the backend uses to turn a block
of marked source text into a marked translation.  It owns:

- provider / model / base-url resolution,
- prompt assembly,
- dispatch to the correct client (Gemini / Anthropic / OpenAI-compatible),
- HF rate-limit backoff,
- response parsing + marker sanitisation.

It does NOT own retry-on-missing-markers — that decision lives in the
pipeline, which knows how many paragraphs were expected.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, TypedDict

from backend.ai import markers, parsing, prompts
from backend.ai.clients import anthropic as anthropic_client
from backend.ai.clients import gemini as gemini_client
from backend.ai import throttle
from backend.ai.clients import openai_compat
from backend.ai.config import PROVIDER_DEFAULTS
from backend.ai.providers import (
    is_hf_provider,
    is_local_provider,
    openai_compat_models,
    resolve_base_url,
    resolve_model,
    resolve_provider,
)
from backend.lens.languages import normalize as normalize_lang


@dataclass
class AiConfig:
    """User-supplied AI settings for one translation request."""

    api_key: str
    model: str = "auto"
    provider: str = "auto"
    base_url: str = "auto"
    prompt_editable: str = ""
    # Optional translation-memory: recent {"src","tgt"} pairs from earlier
    # pages in the same session, injected into the prompt for consistency.
    glossary: list = field(default_factory=list)


class AiResult(TypedDict):
    aiTextFull: str
    meta: dict[str, Any]


def translate(
    original_text_full: str,
    target_lang: str,
    ai: AiConfig,
    *,
    is_retry: bool = False,
    reference_text_full: str = "",  # kept for backward compatibility; ignored
    capture_request: bool = False,
) -> AiResult:
    """Translate ``original_text_full`` into ``target_lang`` using ``ai``.

    ``original_text_full`` carries ``<<TP_Pn>>`` markers; the return
    value's ``aiTextFull`` is sanitised back into canonical marker form.

    ``reference_text_full`` is accepted but ignored — the model now sees only
    the source text.  Sending the Lens MT roughly doubled the input tokens
    and made the model copy the MT's stilted register; translating from the
    source alone is faster, cheaper, and produces more natural dialogue.

    Raises ``ValueError`` if no API key is supplied.  Returns a ``skipped``
    result (rather than raising) when the input has no real text.
    """
    if not markers.has_meaningful_text(original_text_full):
        return AiResult(aiTextFull="", meta={"skipped": True, "skipped_reason": "no_text"})

    api_key = (ai.api_key or "").strip()
    # Local, self-hosted providers (Ollama / LM Studio / LocalAI) need no key.
    # Detect a local provider either from an explicit provider name or from a
    # localhost base_url, so a keyless local request is allowed through.
    _prov_hint = (ai.provider or "auto").strip().lower()
    _base_hint = (ai.base_url or "").strip().lower()
    _looks_local = (
        is_local_provider(_prov_hint)
        or "localhost" in _base_hint
        or "127.0.0.1" in _base_hint
        or "0.0.0.0" in _base_hint
    )
    if not api_key and not _looks_local:
        raise ValueError("AI api_key is required")

    provider = resolve_provider(ai.provider, api_key)
    if not api_key and _looks_local and provider in ("", "auto", "openai"):
        # Keyless request with a local base_url but no recognised provider name
        # → treat as Ollama (the most common local server).
        provider = "ollama"
    model = resolve_model(provider, ai.model)
    base_url = resolve_base_url(provider, ai.base_url)

    # The HF fallback path should only kick in when the user did not pin a model.
    model_was_auto = (ai.model or "auto").strip().lower() in ("", "auto")

    # Local servers (Ollama / LM Studio / …) load whatever model the USER has
    # installed; our default model name is only a placeholder.  When the user
    # didn't pin a real model (auto / empty / the "local-model" placeholder /
    # the provider's own default), ask the server which models it actually has
    # and use the first one — so the request matches an installed model instead
    # of 404-ing on a name the user doesn't have.
    if is_local_provider(provider):
        _placeholder = {
            "auto", "", "local-model",
            str((PROVIDER_DEFAULTS.get(provider) or {}).get("model", "")).strip().lower(),
        }
        if str(ai.model or "auto").strip().lower() in _placeholder:
            try:
                installed = openai_compat_models(api_key or "local", base_url)
            except Exception:
                installed = []
            if installed:
                model = installed[0]

    system_text = prompts.build_system_text(
        target_lang, ai.prompt_editable, is_retry=is_retry,
        glossary=getattr(ai, "glossary", None),
    )
    user_parts = prompts.build_user_parts(original_text_full)

    # Local servers ignore the key but the OpenAI client always sends a
    # bearer header; supply a harmless placeholder when none was given.
    if not api_key and is_local_provider(provider):
        api_key = "local"

    used_model = model
    if provider == "gemini":
        result = gemini_client.generate(api_key, model, system_text, user_parts)
    elif provider == "anthropic":
        result = anthropic_client.generate(api_key, model, system_text, user_parts)
    elif is_hf_provider(provider, base_url):
        result = throttle.generate_with_backoff(
            api_key, base_url, model, system_text, user_parts,
            allow_hf_fallback=model_was_auto,
        )
    else:
        result = openai_compat.generate(
            api_key, base_url, model, system_text, user_parts,
            allow_hf_fallback=False,
        )
    used_model = result.used_model

    ai_text_full = markers.sanitize(parsing.parse_text(result.text))

    meta: dict[str, Any] = {
        "model": used_model,
        "provider": provider,
        "base_url": base_url,
        "target_lang": normalize_lang(target_lang),
    }
    if capture_request:
        # Verbose debug payload for the CLI; not included on normal API runs
        # because some clients log meta verbatim.
        meta["debug_request"] = {
            "system_text": system_text,
            "user_parts": user_parts,
            "is_retry": is_retry,
        }
        meta["debug_response_raw"] = result.text
    return AiResult(aiTextFull=ai_text_full, meta=meta)
