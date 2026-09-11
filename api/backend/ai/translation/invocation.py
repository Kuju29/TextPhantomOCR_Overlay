"""Resolve, invoke, and decode one provider generation."""

from __future__ import annotations

from backend.ai import markers, prompts, wire_trace
from backend.ai import trace_preview
from backend.ai.clients.base import usage_meta
from backend.ai.capabilities import select_planned_output_capability
from backend.ai.provider_contract import GenerationRequest, SystemPromptSection
from backend.ai.provider_bootstrap import ensure_provider_registry
from backend.ai.provider_registry import provider_registry
from backend.ai.provider_resolution import (
    is_local_provider,
    default_local_provider,
    provider_key_mismatch,
    resolve_base_url,
    resolve_provider,
)
from backend.ai.rate_policy import is_local_target
from backend.security import assert_ai_base_url_allowed
from backend.ai.translation.contracts import AiConfig, AiResult
from backend.ai.translation.model_resolution import resolve_generation_model
from backend.ai.translation.result_decode import decode_result

# This module is also a supported standalone entry point in tests and tooling,
# outside the API process composition root.
ensure_provider_registry()

def resolve_thinking_selection(requested: object, reasoning_caps: object) -> str:
    """Resolve the user selection without silently enabling model reasoning."""
    selected = str(requested or "off").strip().lower()
    if selected not in {"off", "on"}:
        selected = "off"
    caps = reasoning_caps if isinstance(reasoning_caps, dict) else {}
    if caps.get("mandatory") is True and selected == "off":
        error = ValueError(
            "The selected model requires Thinking. Change [AI option > AI thinking] "
            "or choose a model that supports Thinking off."
        )
        error.code = "AI_THINKING_REQUIRED"
        raise error
    return "on" if caps.get("mandatory") is True else selected

def _translate_once(
    original_text_full: str,
    target_lang: str,
    ai: AiConfig,
    *,
    is_retry: bool = False,
    reference_text_full: str = "",
    capture_request: bool = False,
    cancel_check=None,
) -> AiResult:
    """Translate one marked image; ``reference_text_full`` is compatibility-only."""
    prompt_mode = prompts.normalize_prompt_mode(getattr(ai, "prompt_mode", None))
    if not markers.has_meaningful_text(original_text_full):
        return AiResult(aiTextFull="", meta={"skipped": True, "skipped_reason": "no_text"})

    api_key = (ai.api_key or "").strip()
    _prov_hint = (ai.provider or "auto").strip().lower()
    _base_hint = (ai.base_url or "").strip()
    _looks_local = is_local_target(_prov_hint, _base_hint)
    if not api_key and not _looks_local:
        raise ValueError("AI api_key is required")

    provider = resolve_provider(ai.provider, api_key)
    if not provider and api_key:
        raise ValueError("AI provider must be selected explicitly for this API key")
    mismatched_provider = provider_key_mismatch(provider, api_key) if api_key else ""
    if mismatched_provider:
        raise ValueError(
            f"AI provider/key mismatch: selected {provider}, key belongs to {mismatched_provider}"
        )
    resolved_spec = provider_registry.get(provider)
    if not api_key and _looks_local and (resolved_spec is None or not resolved_spec.local):
        provider = default_local_provider()
    model = resolve_generation_model(provider, ai.model)
    base_url = resolve_base_url(provider, ai.base_url)
    thinking_requested = str(getattr(ai, "thinking", "") or "off").strip().lower()
    if thinking_requested not in {"off", "on"}:
        thinking_requested = "off"
    thinking_selected = thinking_requested

    assert_ai_base_url_allowed(
        provider, base_url,
        user_key=bool(getattr(ai, "user_key", False)),
        key_present=bool(api_key),
    )

    if is_local_provider(provider):
        if str(ai.model or "auto").strip().lower() in ("", "auto"):
            try:
                spec = provider_registry.require(provider)
                listed = spec.adapter.list_models(api_key="", base_url=base_url)
                installed = list(listed.models)
            except Exception:
                installed = []
            if installed:
                model = installed[0]

    image_b64 = (getattr(ai, "image_b64", "") or "").strip()
    image_mime = (getattr(ai, "image_mime", "") or "image/jpeg").strip()
    char_memory = bool(getattr(ai, "char_memory", True))
    context_frozen = bool(getattr(ai, "context_frozen", False))

    want_memo = char_memory and not context_frozen
    ids = markers.expected_ids(original_text_full)
    if not ids:
        raise ValueError("AI input requires the exact marker sequence P0..Pn")
    source_decoded = markers.extract_paragraphs_exact(original_text_full, len(ids))
    if source_decoded is None:
        raise ValueError("AI input requires attributable P0..Pn source units")

    from backend.ai.provider_resolution import (
        discovered_model_capabilities, effective_model_capabilities,
    )
    discovery_fresh, server_capabilities = discovered_model_capabilities(
        provider, base_url, model, api_key
    )
    discovered_capabilities = effective_model_capabilities(
        discovery_fresh=discovery_fresh, server=server_capabilities,
        client=getattr(ai, "model_capabilities", {}),
    )
    if image_b64 and discovered_capabilities.get("vision", {}).get("supported") is not True:
        status = discovered_capabilities.get("vision", {}).get("supported")
        if status is False:
            raise ValueError(
                "[AI option > Page image to AI] is unavailable for the selected model"
            )
        raise ValueError(
            "[AI option > Page image to AI] requires verified image support for the selected model"
        )
    reasoning_caps = discovered_capabilities.get("reasoning", {})
    reasoning_caps = reasoning_caps if isinstance(reasoning_caps, dict) else {}
    thinking_selected = resolve_thinking_selection(thinking_requested, reasoning_caps)

    capability = select_planned_output_capability(
        provider, model, base_url, model_capabilities=discovered_capabilities,
        planned_contract=getattr(ai, "output_contract", ""),
    )
    selected_wire_contract = capability.selected_contract
    structured_output = capability.native_schema
    response_schema = markers.translation_schema(original_text_full) if structured_output else None

    # 2026.9.5.36 experiment: keep task/context/contracts in User, but make
    # System the translator identity and embed the selected editable Style in
    # that identity so style adherence gets system-role priority.
    selected_style, _style_source = prompts.select_style(
        target_lang, ai.prompt_editable, prompt_mode
    )
    system_text = prompts.build_translator_identity_system(selected_style)
    request_prompt_audit = prompts.prompt_trace_metadata(
        target_lang,
        ai.prompt_editable,
        prompt_mode=prompt_mode,
        effective_system_text=system_text,
    )
    # These aliases intentionally avoid prompt/text/content field names so the
    # normal trace privacy filter can retain counts and session-scoped hashes.
    # They prove which style reached the provider boundary without exposing it.
    trace_preview.note("AI style delivery boundary", {
        "styleOrigin": request_prompt_audit["promptSource"],
        "styleMode": request_prompt_audit["promptMode"],
        "styleChars": request_prompt_audit["effectiveStyleChars"],
        "styleFingerprint": request_prompt_audit["effectiveStyleFingerprint"],
        "instructionChars": request_prompt_audit["effectiveSystemPromptChars"],
        "instructionFingerprint": request_prompt_audit["effectiveSystemPromptFingerprint"],
        "targetLang": request_prompt_audit["targetLang"],
        "provider": provider,
        "model": model,
    })
    encoded_source = (
        markers.apply_schema_source(source_decoded[0])
        if structured_output else markers.apply_wire(source_decoded[0])
    )
    user_message = prompts.build_translation_user_message(
        target_lang,
        ai.prompt_editable,
        encoded_source,
        ids,
        structured_output=structured_output,
        prompt_mode=prompt_mode,
        glossary=getattr(ai, "glossary", None),
        characters=(
            getattr(ai, "characters", None) if (char_memory or context_frozen) else None
        ),
        has_image=bool(image_b64),
        series_state=str(getattr(ai, "series_state", "") or ""),
        speakers=getattr(ai, "speakers", None),
        prev_context=getattr(ai, "prev_context", None),
        repair_reason=getattr(ai, "repair_reason", ""),
    )
    user_parts = [user_message]
    wire_trace.write_json("01_units.json", [
        {"id": marker_id, "text": text}
        for marker_id, text in zip(ids, source_decoded[0])
    ])
    wire_trace.write_text("02_system_prompt.txt", system_text)
    contract_trace = {
        "requested": "json_schema_object_v1",
        "selected": selected_wire_contract,
        "applied": "native_json_schema" if structured_output else "compact_markers",
        "nativeSchema": structured_output,
        "reason": capability.reason,
        "capabilitySource": "server_account_cache" if discovery_fresh else (
            "extension_account_catalogue" if discovered_capabilities else "provider_known_or_unknown"
        ),
    }
    wire_trace.write_json("03_wire_units.json", {
        "contract": contract_trace,
        "units": [{"id": item, "text": text} for item, text in zip(ids, source_decoded[0])],
        "providerSource": encoded_source,
    })
    trace_preview.note("AI output contract selected", contract_trace)
    trace_preview.note("AI provider user-message boundary", {
        "userMessageChars": len(user_message),
        "unitCount": len(ids),
    })
    trace_preview.emit(
        "AI diagnostic source units", trace_preview.marked_units(original_text_full),
        selectedContract=selected_wire_contract,
    )
    trace_preview.emit(
        "AI diagnostic provider request units",
        trace_preview.marked_units(user_message),
        selectedContract=selected_wire_contract,
    )

    trace_preview.note("AI diagnostic reasoning policy resolved", {
        "provider": provider,
        "model": model,
        "requestedMode": thinking_requested,
        "selectedMode": thinking_selected,
        "overrideReason": "provider_requires_thinking" if thinking_selected != thinking_requested else "none",
        "capabilitySource": "server_account_cache" if discovery_fresh else (
            "extension_account_catalogue" if discovered_capabilities else "unknown"
        ),
        "supported": reasoning_caps.get("supported") is True,
        "mandatory": reasoning_caps.get("mandatory") is True,
        "defaultEnabled": reasoning_caps.get("default_enabled") is True,
        "dynamic": reasoning_caps.get("dynamic") is True,
        "control": str(reasoning_caps.get("control") or "unknown"),
        "supportsMaxTokens": reasoning_caps.get("supports_max_tokens") is True,
    })
    spec = provider_registry.require(provider)
    if spec.adapter is None:
        raise RuntimeError(f"AI provider has no adapter: {provider}")
    system_sections = (SystemPromptSection("final_system", system_text, cacheable=True),)
    from backend.ai.accounting import generate_with_receipt
    result = generate_with_receipt(spec.adapter, GenerationRequest(
        provider=provider, model=model, api_key=api_key, base_url=base_url,
        system_text=system_text, user_parts=tuple(user_parts), image_b64=image_b64,
        system_sections=system_sections,
        image_mime=image_mime, thinking=thinking_selected,
        response_schema=response_schema, unit_count=len(ids), expected_ids=tuple(ids),
        model_capabilities=discovered_capabilities, workload=ai.workload, cancel_check=cancel_check,
    ), phase="repair" if is_retry else "initial")
    used_model = result.used_model
    # A selected preference does not prove that the adapter sent a native
    # control or that the provider honored it.
    thinking_applied = getattr(result, "thinking_applied", None) or "unverified"
    trace_preview.note("AI diagnostic provider response", {
        "selectedContract": selected_wire_contract,
        "finishReason": result.finish_reason,
        "usage": usage_meta(result),
        "providerMs": result.provider_ms,
        "parseMs": result.parse_ms,
        "response": trace_preview.preview(result.text),
    })

    decoded = decode_result(
        result=result, ids=ids, provider=provider, base_url=base_url,
        used_model=used_model,
        target_lang=target_lang, ai=ai, context_frozen=context_frozen,
        selected_wire_contract=selected_wire_contract, want_memo=want_memo,
        native_schema=structured_output, contract_selection_reason=capability.reason,
        image_b64=image_b64, thinking_selected=thinking_selected,
        thinking_applied=thinking_applied, system_text=system_text,
        user_parts=user_parts, capture_request=capture_request, is_retry=is_retry,
    )
    decoded["meta"]["model_limits"] = dict(discovered_capabilities.get("limits") or {})
    wire_trace.write_json("06_parsed_records.json", {
        "aiTextFull": decoded.get("aiTextFull", ""), "meta": decoded.get("meta", {})
    })
    return decoded

def translate(
    original_text_full: str,
    target_lang: str,
    ai: AiConfig,
    *,
    is_retry: bool = False,
    reference_text_full: str = "",
    capture_request: bool = False,
    cancel_check=None,
) -> AiResult:
    """Translate one image in one provider generation.

    A caller may invoke this entry point once more for a bounded repair, but a
    single invocation is never split by unit count.  This keeps each image's
    initial translation on its own request/stream for both Local and Cloud AI.
    """
    expected = markers.expected_ids(original_text_full)
    result = _translate_once(
        original_text_full, target_lang, ai, is_retry=is_retry,
        reference_text_full=reference_text_full, capture_request=capture_request,
        cancel_check=cancel_check,
    )
    result["meta"].setdefault("sourceUnitCount", len(expected))
    result["meta"].setdefault("batchCount", 1)
    result["meta"].setdefault("batchRanges", [f"0-{len(expected)-1}"] if expected else [])
    return result
