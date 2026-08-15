"""High-level AI translation orchestration.


This is the single entry point the rest of the backend uses to turn a block
of marked source text into a marked translation.  It owns:

- provider / model / base-url resolution,
- prompt assembly,
- dispatch to the correct client (Gemini / Anthropic / OpenAI-compatible),
- HF account pacing,
- lossless one-response decoding back to canonical internal markers.

It performs exactly one model generation. Provider-native JSON Schema is used
where available; all other models receive the same JSON contract in the prompt.
Incomplete output is rejected rather than repaired or retried.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, TypedDict

from backend.ai import markers, parsing, prompts
from backend.ai.errors import ModelOutputContractError
from backend.ai.clients import anthropic as anthropic_client
from backend.ai.clients import gemini as gemini_client
from backend.ai import throttle
from backend.ai.clients import openai_compat
from backend.ai.providers import (
    is_hf_provider,
    is_local_provider,
    openai_compat_models,
    resolve_base_url,
    resolve_model,
    resolve_provider,
)
from backend.lens.languages import normalize as normalize_lang
from backend.security import assert_ai_base_url_allowed


@dataclass
class AiConfig:
    """User-supplied AI settings for one translation request."""

    api_key: str
    # True when ``api_key`` came from the caller, False when it fell back to
    # the server's AI_API_KEY. This decides whether a caller-chosen base_url
    # may be used at all — see backend/security.py. It defaults to False so a
    # caller that forgets to set it gets the RESTRICTIVE behaviour.
    user_key: bool = False
    model: str = "auto"
    provider: str = "auto"
    base_url: str = "auto"
    prompt_editable: str = ""
    # Optional translation-memory: recent {"src","tgt"} pairs from earlier
    # pages in the same session, injected into the prompt for consistency.
    glossary: list = field(default_factory=list)
    # Optional character sheet: {"name","gender","speech","note"} dicts the
    # client accumulated from earlier pages (via <<TP_MEMO>> blocks), so the
    # model knows each character's gender / pronouns / register.
    characters: list = field(default_factory=list)
    # Toggle for the character-memory feature (memo request + sheet injection).
    # Series memory master switch — default OFF (off = smallest prompt/response,
    # cheapest tokens, and a page translates the same as a clean run).
    char_memory: bool = False
    # Vision: when the client opts in (send_image) the pipeline downscales the
    # page and fills image_b64/image_mime so the model can SEE the speakers.
    # Accepts True/"always" (every page) or "auto" (the pipeline attaches the
    # image only on real dialogue pages — enough OCR bubbles — and only while
    # the character sheet is still thin, so covers/title pages are skipped).
    send_image: bool | str = False
    image_b64: str = ""
    image_mime: str = "image/jpeg"
    # Reasoning control (currently Gemini only): "default" lets the model
    # think normally; "off" minimises thinking for the fastest answers.
    thinking: str = "default"
    # --- Frozen series context (read-then-translate batches) ---------------
    # ⛔ DORMANT-FED — this group of fields (series_state / speakers / prev_context /
    # context_frozen) is populated only by the chapter-brief flow, which is dormant
    # (the extension never calls briefBegin) — so in the current flow they are always empty.
    # The receiving code is still ACTIVE and ready to work immediately if the flow is reconnected.
    # Filled by the chapter-brief flow: every page of one batch carries the
    # SAME immutable context, so parallel translation cannot race and the
    # per-page memo emission is skipped (the brief already updated memory).
    # series_state: the series bible ("STORY SO FAR") text.
    series_state: str = ""
    # speakers: this page's marker->speaker map, e.g. {"0": "Rey"}.
    speakers: dict = field(default_factory=dict)
    # prev_context: previous page's SOURCE tail, [{"src": ..., "who"?: ...}].
    prev_context: list = field(default_factory=list)
    # True = context above is frozen for the whole batch -> no <<TP_MEMO>>.
    context_frozen: bool = False


class AiResult(TypedDict):
    aiTextFull: str
    meta: dict[str, Any]


def resolve_generation_model(provider: str, requested_model: str) -> str:
    """Resolve only an explicit ``auto`` instruction for a generation.

    Alias migration remains available to the settings/resolve endpoint where
    it is disclosed to the user. The generation path sends every explicit
    model ID unchanged, so a retired or misspelled model fails visibly on its
    sole provider attempt instead of being silently substituted.
    """
    requested = (requested_model or "").strip()
    if not requested or requested.lower() == "auto":
        return resolve_model(provider, "auto")
    return requested


def translate(
    original_text_full: str,
    target_lang: str,
    ai: AiConfig,
    *,
    is_retry: bool = False,
    reference_text_full: str = "",  # ⛔ DORMANT param — kept for backward compat but always ignored (Lens MT is no longer sent to the model)
    capture_request: bool = False,
) -> AiResult:
    """Translate ``original_text_full`` into ``target_lang`` using ``ai``.

    ``original_text_full`` carries ``<<TP_Pn>>`` markers; the return
    value's ``aiTextFull`` is decoded back into canonical marker form without
    changing any translated value.

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
    model = resolve_generation_model(provider, ai.model)
    base_url = resolve_base_url(provider, ai.base_url)

    # Refuse to send the SERVER's key to an endpoint the caller picked. This is
    # the last gate before the key reaches an Authorization header, so it runs
    # on the RESOLVED url — a payload that hides the target behind an alias
    # cannot slip past it.
    assert_ai_base_url_allowed(provider, base_url, user_key=bool(getattr(ai, "user_key", False)))

    # Local servers (Ollama / LM Studio / …) load whatever model the USER has
    # installed; our default model name is only a placeholder.  When the user
    # explicitly selected auto/empty, ask the server which models it actually has
    # and use the first one — so the request matches an installed model instead
    # of 404-ing on a placeholder. Every explicit model ID remains immutable.
    if is_local_provider(provider):
        if str(ai.model or "auto").strip().lower() in ("", "auto"):
            try:
                installed = openai_compat_models(api_key or "local", base_url)
            except Exception:
                installed = []
            if installed:
                model = installed[0]

    image_b64 = (getattr(ai, "image_b64", "") or "").strip()
    image_mime = (getattr(ai, "image_mime", "") or "image/jpeg").strip()
    char_memory = bool(getattr(ai, "char_memory", True))
    context_frozen = bool(getattr(ai, "context_frozen", False))

    # Build the system prompt as a cacheable (static) prefix + a per-page
    # (dynamic) suffix. Joining the two reproduces the legacy single-string
    # prompt, so the non-caching providers below are unaffected; the Anthropic
    # client uses the split to mark the static prefix with cache_control.
    # Frozen batches: the brief already updated the series memory, so the
    # per-page <<TP_MEMO>> emission is skipped (shorter, cheaper output) while
    # the character sheet itself IS still injected.
    want_memo = char_memory and not context_frozen
    response_schema = markers.translation_schema(
        original_text_full, want_memo=want_memo
    )
    system_static, system_dynamic = prompts.build_system_split(
        target_lang, ai.prompt_editable, is_retry=is_retry,
        glossary=getattr(ai, "glossary", None),
        characters=(
            getattr(ai, "characters", None) if (char_memory or context_frozen) else None
        ),
        has_image=bool(image_b64),
        want_memo=want_memo,
        series_state=str(getattr(ai, "series_state", "") or ""),
        speakers=getattr(ai, "speakers", None),
        prev_context=getattr(ai, "prev_context", None),
        structured_output=True,
    )
    system_text = "\n\n".join(p for p in (system_static, system_dynamic) if p)
    user_parts = prompts.build_user_parts(original_text_full)

    # Local servers ignore the key but the OpenAI client always sends a
    # bearer header; supply a harmless placeholder when none was given.
    if not api_key and is_local_provider(provider):
        api_key = "local"

    used_model = model
    if provider == "gemini":
        result = gemini_client.generate(
            api_key, model, system_text, user_parts,
            image_b64=image_b64, image_mime=image_mime,
            thinking=str(getattr(ai, "thinking", "") or ""),
            response_schema=response_schema,
        )
    elif provider == "anthropic":
        result = anthropic_client.generate(
            api_key, model, system_text, user_parts,
            image_b64=image_b64, image_mime=image_mime,
            system_static=system_static, system_dynamic=system_dynamic,
            response_schema=response_schema,
        )
    elif is_hf_provider(provider, base_url):
        result = throttle.generate_with_backoff(
            api_key, base_url, model, system_text, user_parts,
            allow_hf_fallback=False,
            image_b64=image_b64, image_mime=image_mime,
            response_schema=response_schema,
        )
    else:
        result = openai_compat.generate(
            api_key, base_url, model, system_text, user_parts,
            allow_hf_fallback=False,
            image_b64=image_b64, image_mime=image_mime,
            response_schema=response_schema,
        )
    used_model = result.used_model

    # Split off the optional <<TP_MEMO>> character-notes block BEFORE marker
    # sanitisation so it can never leak into the rendered translation.
    ids = markers.expected_ids(original_text_full)
    if not ids:
        raise ValueError("AI input requires the exact marker sequence P0..Pn")
    # One deterministic decoder handles the SAME provider response. It accepts
    # only shapes whose IDs and values can be recovered without guessing or
    # editing translated content; structural failures are terminal.
    try:
        decoded = markers.decode_translation_response(result.text, ids)
    except ModelOutputContractError as exc:
        # Structural diagnostics only: enough to identify the exact broken
        # contract without writing translated dialogue into TP_TRACE.
        raw_bytes = str(result.text or "").encode("utf-8")
        exc.structural_details.setdefault("responseChars", len(str(result.text or "")))
        exc.structural_details.setdefault(
            "responseSha256", hashlib.sha256(raw_bytes).hexdigest()
        )
        exc.structural_details.setdefault("resolvedProvider", provider)
        exc.structural_details.setdefault("resolvedModel", used_model)
        raise
    ai_text_full = decoded.ai_text_full
    memo = decoded.memo if want_memo else ""
    characters = parsing.parse_character_memo(memo) if memo else []

    meta: dict[str, Any] = {
        "model": used_model,
        "provider": provider,
        "base_url": base_url,
        "target_lang": normalize_lang(target_lang),
        # NO-SILENT-FALLBACK: which flow actually ran, visible in every log.
        "ai_flow": "brief_frozen" if context_frozen else "per_page",
        "output_contract": decoded.response_shape,
        "response_shape": decoded.response_shape,
        "accepted_losslessly": decoded.accepted_losslessly,
        "content_modified": decoded.content_modified,
        "omitted_ids": list(decoded.missing_ids),
    }
    if characters:
        meta["characters"] = characters
    if image_b64:
        meta["vision"] = True
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
