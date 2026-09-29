"""Resolve, invoke, and decode one provider generation."""

from __future__ import annotations

from backend.ai import markers, prompts, wire_trace
from backend.ai import trace_preview
from backend.ai.clients.base import usage_meta
from backend.ai.cloud_reasoning import (
    CloudReasoningPreferenceUnavailable, PROVIDER_MANAGED_UNVERIFIED,
    ensure_cloud_reasoning_preflight,
    native_reasoning_capability,
)
from backend.ai.capabilities import (OutputCapability, select_planned_output_capability,
    COMPACT_MARKERS)
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
from backend.ai.reasoning_preference import (
    normalize_reasoning_preference, reasoning_is_active, resolve_reasoning_preference,
)

# This module is also a supported standalone entry point in tests and tooling,
# outside the API process composition root.
ensure_provider_registry()

def resolve_thinking_selection(requested: object, reasoning_caps: object) -> str:
    """Resolve user intent against exact model capability without hiding models.

    Unsupported or stale preferences fall back to provider default. Provider
    adapters alone translate the normalized value into native wire fields.
    """
    return resolve_reasoning_preference(requested, reasoning_caps)

def _translate_once_impl(
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
    from backend.ai.credentials import ProviderEndpointConflict
    from backend.ai.rate_policy import cloud_local_endpoint_conflict
    if cloud_local_endpoint_conflict(_prov_hint, _base_hint):
        raise ProviderEndpointConflict()
    _looks_local = is_local_target(_prov_hint, _base_hint)
    if _looks_local and _prov_hint in ("", "auto") and api_key:
        raise ProviderEndpointConflict()
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
        if _prov_hint in ("", "auto"):
            provider = default_local_provider()
        else:
            raise ValueError(f"Unsupported Local AI provider: {_prov_hint}")
    model = resolve_generation_model(provider, ai.model)
    base_url = resolve_base_url(provider, ai.base_url)
    thinking_requested = normalize_reasoning_preference(getattr(ai, "thinking", None), "off")
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
                listed = spec.adapter.list_models(api_key=api_key, base_url=base_url)
                installed = list(listed.models)
                if provider == "lmstudio" and listed.status == "valid":
                    from backend.ai.provider_resolution import remember_model_capabilities
                    remember_model_capabilities(provider, base_url, api_key,
                        dict(listed.capabilities), models=listed.models)
            except Exception:
                installed = []
            if installed:
                model = installed[0]

    image_b64 = (getattr(ai, "image_b64", "") or "").strip()
    image_mime = (getattr(ai, "image_mime", "") or "image/jpeg").strip()
    char_memory = bool(getattr(ai, "char_memory", True))
    context_frozen = bool(getattr(ai, "context_frozen", False))

    want_memo = char_memory and not context_frozen
    legacy_ids = markers.expected_ids(original_text_full)
    if not legacy_ids:
        raise ValueError("AI input requires the exact marker sequence P0..Pn")
    source_decoded = markers.extract_paragraphs_exact(original_text_full, len(legacy_ids))
    if source_decoded is None:
        raise ValueError("AI input requires attributable P0..Pn source units")
    ids = list(legacy_ids)
    conversation_records = False
    if getattr(ai, "translation_mode", "") == "conversation":
        origins = (getattr(ai, "conversation", None) or {}).get("origins") or []
        wire_ids = [str(uid) for row in origins for uid in (row.get("unitIds") or [])]
        if wire_ids:
            if len(wire_ids) != len(source_decoded[0]) or len(set(wire_ids)) != len(wire_ids) or any(not markers.valid_output_id(uid) for uid in wire_ids):
                raise ValueError("Conversation image/unit IDs do not match the current source")
            ids = wire_ids
            conversation_records = all(uid.startswith("I") for uid in ids)

    from backend.ai.provider_resolution import (
        discovered_model_capabilities, effective_model_capabilities,
    )
    discovery_fresh, server_capabilities = discovered_model_capabilities(
        provider, base_url, model, api_key
    )
    if provider == "huggingface":
        from backend.ai.provider_resolution import refresh_hf_selected_metadata
        discovery_fresh, server_capabilities = refresh_hf_selected_metadata(provider, base_url, model, api_key)
    native_reasoning = native_reasoning_capability(provider, model) if not is_local_provider(provider) else {}
    if (not is_local_provider(provider) and provider != "paid" and thinking_requested != "default"
            and not discovery_fresh and not native_reasoning):
        # A saved browser catalogue is a model hint, not current proof for this
        # account. On a cold API process, read the provider's model catalogue
        # before choosing a native Thinking control or dispatching generation.
        from backend.ai.provider_resolution import refresh_cloud_model_capabilities
        try:
            discovery_fresh, server_capabilities = refresh_cloud_model_capabilities(
                provider, base_url, model, api_key)
        except Exception:
            # Adapter discovery may fail before returning a typed status.
            # Keep the public failure specific to the user's Thinking choice
            # without exposing a credential-bearing upstream exception.
            raise CloudReasoningPreferenceUnavailable(
                provider, model, thinking_requested) from None
    preplanned = getattr(ai, "_runtime_context_evidence", None)
    prepared = None
    if provider in {"lmstudio", "ollama"}:
        from backend.ai.translation_paths.batch_policy import PreparedModelEvidence
        if isinstance(preplanned, PreparedModelEvidence):
            prepared = preplanned.consume(provider, model, base_url, api_key)
    if provider == "lmstudio":
        # A loaded instance can be replaced or evicted within the catalogue
        # TTL. Read its exact context before every real request; an unloaded
        # JIT key supplies only a requested, unverified first-chat window.
        if prepared is None:
            from backend.ai.provider_resolution import remember_model_capabilities
            listed = provider_registry.require(provider).adapter.list_models(
                api_key=api_key, base_url=base_url)
            selected = listed.capabilities.get(model, {}) if listed.status == "valid" else {}
        else:
            listed = None
            selected = prepared
        limits = selected.get("limits") if isinstance(selected, dict) else {}
        limits = limits if isinstance(limits, dict) else {}
        if ((listed is not None and (listed.status != "valid" or model not in listed.models)) or
                not isinstance(limits.get("contextTokens"), int) or
                limits["contextTokens"] <= 0):
            raise ValueError("Selected LM Studio model has no available exact instance or JIT context budget")
        if listed is not None:
            remember_model_capabilities(provider, base_url, api_key,
                dict(listed.capabilities), models=listed.models)
        discovery_fresh, server_capabilities = True, dict(selected)
    runtime_proof = None
    if provider in {"vllm", "llamacpp", "koboldcpp"}:
        import hashlib
        from backend.ai.providers.local_openai_runtime import RuntimeContextEvidence
        from backend.ai.workload import WorkloadBudgetError, positive
        candidate = getattr(ai, "_runtime_context_evidence", None)
        adapter = provider_registry.require(provider).adapter
        if (isinstance(candidate, RuntimeContextEvidence) and
                candidate.matches(provider, model, adapter.normalize_base_url(base_url), api_key)):
            runtime_proof = candidate
        else:
            # READY may have spent >5 seconds preparing a prompt. The old
            # bound belongs to this specific model/endpoint/account only; a
            # changed bound invalidates the already planned batch before POST.
            same_ready_identity = (isinstance(candidate, RuntimeContextEvidence) and
                candidate.provider == provider and candidate.model == model and
                candidate.base_url == adapter.normalize_base_url(base_url) and
                candidate.key_digest == hashlib.sha256(api_key.encode()).hexdigest())
            planned_limits = candidate.limits if same_ready_identity else None
            runtime_proof = adapter.inspect_runtime_context(
                model=model, api_key=api_key, base_url=base_url,
                prior_limits=(planned_limits if planned_limits is not None else
                    server_capabilities.get("limits") if discovery_fresh else {}))
            if (planned_limits is not None and
                    positive(planned_limits.get("contextTokens")) !=
                    positive(runtime_proof.limits.get("contextTokens"))):
                error = WorkloadBudgetError(
                    "Selected Local model's context changed since READY planning; no generation was sent")
                error.diagnostics = {"constraintScope": "per_request",
                                     "constraint": "runtime_context_changed"}
                raise error
        # Runtime numeric facts never come from the client or an account TTL.
        # This one-use proof is consumed at the adapter immediately before POST.
        server_capabilities = {"limits": dict(runtime_proof.limits)}
        discovery_fresh = True
    ollama_minimum_unresolved = False
    ollama_unverified_off_attempt = False
    if provider == "ollama":
        # A 300-second catalogue fact is useful for Settings, but the same
        # Ollama model ID can be reloaded with different Thinking controls.
        # Check the exact installed model for each explicit preference before
        # dispatch; this read-only probe never invokes /api/chat.
        from backend.ai.provider_contract import ProbeRequest
        from backend.ai.provider_resolution import replace_selected_model_capabilities
        if prepared is None:
            probed = provider_registry.require(provider).adapter.probe(ProbeRequest(
                model=model, api_key=api_key, base_url=base_url, timeout_sec=3.0,
                model_capabilities=server_capabilities if discovery_fresh else {}))
            capability = dict(probed.capabilities) if probed.ok else {}
        else:
            probed = None
            capability = prepared
        native_reasoning = capability.get("reasoning") or {}
        replace_selected_model_capabilities(provider, base_url, api_key, model,
            capability if isinstance(native_reasoning.get("supported"), bool) else {})
        if probed is not None and not probed.ok:
            if thinking_requested != "default":
                from backend.ai.translation_paths.store import ConversationError
                error = ConversationError("Ollama cannot verify the selected model's Thinking controls from current /api/show")
                error.code = "ai_local_thinking_unsupported"
                raise error
            from backend.ai.workload import WorkloadBudgetError
            raise WorkloadBudgetError("Selected Ollama model is unavailable from current /api/show metadata")
        if thinking_requested != "default" and not isinstance(native_reasoning.get("supported"), bool):
            # A successful /api/show can omit `thinking.values` even when the
            # installed model accepts /api/chat `think:false`. Saved Off/Lowest
            # may attempt that native switch; the adapter rejects any returned
            # thinking without accepting this turn. On/named levels need proof.
            if thinking_requested in {"off", "minimum"}:
                ollama_unverified_off_attempt = True
            else:
                from backend.ai.translation_paths.store import ConversationError
                error = ConversationError(
                    "Ollama cannot verify this model's Thinking controls; no model request was sent")
                error.code = "ai_local_thinking_unsupported"
                raise error
        # A fresh probe is authoritative for this request even when the
        # selected-model catalogue chooses not to retain incomplete metadata.
        server_capabilities = capability
        discovery_fresh = True
        if (thinking_requested == "minimum" and
                native_reasoning.get("minimum_unresolved") is True):
            ollama_minimum_unresolved = True
        if ollama_minimum_unresolved:
            from backend.ai.translation_paths.store import ConversationError
            error = ConversationError(
                "Ollama cannot identify the lowest Thinking level from the selected model's live metadata")
            error.code = "ai_local_thinking_unsupported"
            raise error
    discovered_capabilities = effective_model_capabilities(
        discovery_fresh=discovery_fresh, server=server_capabilities,
        client=getattr(ai, "model_capabilities", {}),
    )
    if runtime_proof is not None:
        discovered_capabilities["limits"] = dict(runtime_proof.limits)
    if is_local_provider(provider) and provider not in {"ollama", "lmstudio", "vllm", "llamacpp", "koboldcpp"}:
        discovered_capabilities.pop("limits", None)
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
    # Anthropic and Gemini own exact model-family contracts in their leaves.
    # An account snapshot cannot override those native mandatory/Off facts.
    if native_reasoning:
        reasoning_caps = native_reasoning
        discovered_capabilities = {**discovered_capabilities, "reasoning": native_reasoning}
    thinking_selected = resolve_thinking_selection(thinking_requested, reasoning_caps)
    if ollama_unverified_off_attempt:
        thinking_selected = "off"
    provider_managed_minimum = False
    if is_local_provider(provider) and thinking_requested == "minimum":
        nonreasoning_proved = discovery_fresh and reasoning_caps.get("supported") is False
        if provider == "lmstudio" and not nonreasoning_proved and thinking_selected == "default":
            from backend.ai.translation_paths.store import ConversationError
            error = ConversationError(
                "LM Studio cannot verify the selected model's lowest Thinking setting from live metadata")
            error.code = "ai_local_thinking_unsupported"
            raise error
        if (ollama_minimum_unresolved or
                (not nonreasoning_proved and
                 (provider not in {"ollama", "lmstudio"} or
                  thinking_selected == "default"))):
            # Keep the user's saved Lowest intent. An unknown Local control
            # may use its default, but cannot report a verified minimum.
            thinking_selected = "default"
            provider_managed_minimum = True
    if not is_local_provider(provider):
        preflight = ensure_cloud_reasoning_preflight(
            provider, model, thinking_requested, thinking_selected, reasoning_caps,
            capability_verified=discovery_fresh or bool(native_reasoning),
        )
        if preflight == PROVIDER_MANAGED_UNVERIFIED:
            if provider != "paid":
                # Lowest is the user's choice. An unproved default may enable
                # hidden reasoning and turn a fast translation into a slow one.
                # Report the missing proof before any provider request.
                raise CloudReasoningPreferenceUnavailable(provider, model, thinking_requested)
            # Paid has a separate Center-owned model contract and is outside
            # the nine manual Cloud providers covered by this change.
            thinking_selected = "default"
            provider_managed_minimum = True

    # The native LM Studio chat endpoint has no JSON-schema output field. A
    # stale compatible-api capability must not select an unsupported wire
    # contract. An explicitly planned schema fails before provider dispatch.
    output_capabilities = ({**discovered_capabilities,
        "structured_output": {"supported": False}}
        if provider == "lmstudio" else discovered_capabilities)
    capability = select_planned_output_capability(
        provider, model, base_url, model_capabilities=output_capabilities,
        planned_contract=getattr(ai, "output_contract", ""),
    )
    if provider == "lmstudio" and capability.selected_contract == COMPACT_MARKERS:
        capability = OutputCapability(capability.requested_contract,
            capability.selected_contract, False, "lmstudio_native_marker_contract")
    # Conversation image/unit records deliberately use one marker grammar. An
    # exact-key JSON schema changes every turn and would become request-varying
    # provider metadata, defeating the append-only cache prefix we are building.
    structured_output = bool(capability.native_schema and not conversation_records)
    selected_wire_contract = (
        "tp.translation.compact-records/1" if conversation_records
        else capability.selected_contract
    )
    response_schema = markers.translation_schema_ids(ids) if structured_output else None

    # The selected style is owned once by System; User holds the current task.
    selected_style, _style_source = prompts.select_style(
        target_lang, ai.prompt_editable, prompt_mode
    )
    system_text = prompts.build_translator_identity_system(selected_style, target_lang)
    request_prompt_audit = prompts.prompt_trace_metadata(
        target_lang,
        ai.prompt_editable,
        prompt_mode=prompt_mode,
        effective_system_text=system_text,
    )
    # These aliases intentionally avoid prompt/text/content field names so the
    # normal trace privacy filter can retain counts and session-scoped hashes.
    # They prove which style reached the provider boundary without exposing it.
    encoded_source = (
        markers.apply_schema_source_ids(source_decoded[0], ids)
        if structured_output else markers.apply_wire_ids(source_decoded[0], ids)
    )
    # Keep the caller's example preference in the first Conversation anchor.
    # Its private scope also separates threads when this preference changes.
    effective_style_examples = getattr(ai, "style_examples", True)
    from backend.ai.prompts.localization import (
        HUMAN_STYLE_EXAMPLE_LIMIT, LOCAL_INDEPENDENT_HUMAN_STYLE_EXAMPLE_LIMIT,
    )
    # These nine Local providers have a stateless Independent API route: a
    # compact human style anchor is sent each request, never a replayed chat.
    # The full first anchor stays intact for Conversation and all Cloud routes.
    human_example_limit = (
        LOCAL_INDEPENDENT_HUMAN_STYLE_EXAMPLE_LIMIT
        if is_local_provider(provider) and ai.translation_mode == "independent"
        else HUMAN_STYLE_EXAMPLE_LIMIT
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
        page_context=getattr(ai, "page_context", None),
        source_lang=getattr(ai, "source_lang", ""),
        source_context=getattr(ai, "source_context", None),
        repair_reason=getattr(ai, "repair_reason", ""),
        style_examples=effective_style_examples,
        human_example_limit=human_example_limit,
        memory_mode=getattr(ai, "memory_mode", None),
        conversation_records=conversation_records,
    )
    from backend.ai.prompts.layout import prompt_layout
    layout = prompt_layout(system_text, user_message, lang=target_lang,
        source_lang=getattr(ai, "source_lang", ""), structured=structured_output,
        examples=effective_style_examples, memory_mode=getattr(ai, "memory_mode", None),
        selected_style=selected_style, conversation_records=conversation_records,
        human_example_limit=human_example_limit)
    trace_preview.note("AI style delivery boundary", {
        "styleRole": layout["styleRole"],
        "systemStyleCopies": layout["systemStyleCopies"],
        "userStyleCopies": layout["userStyleCopies"],
        "policyVersion": layout["policyVersion"],
        "userStaticChars": layout["userStaticChars"],
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
    user_parts = [user_message]
    wire_trace.write_json("01_units.json", [
        {"id": marker_id, "text": text}
        for marker_id, text in zip(ids, source_decoded[0])
    ])
    wire_trace.write_text("02_system_prompt.txt", system_text)
    contract_trace = {
        "requested": selected_wire_contract,
        "plannedOutputContract": selected_wire_contract,
        "selectedOutputContract": selected_wire_contract,
        "selectionReason": "conversation_marker_contract" if conversation_records else capability.reason,
        "decodedResponseShape": None,
        "parserId": "schema_object" if structured_output else "compact_records",
        "formatSwitch": False,
        "selected": selected_wire_contract,
        "applied": "native_json_schema" if structured_output else "compact_markers",
        "nativeSchema": structured_output,
        "reason": "conversation_marker_contract" if conversation_records else capability.reason,
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
    trace_preview.emit(
        "AI diagnostic source units", trace_preview.marked_units(original_text_full),
        selectedContract=selected_wire_contract,
    )

    trace_preview.note("AI diagnostic reasoning policy resolved", {
        "provider": provider,
        "model": model,
        "requestedMode": thinking_requested,
        "selectedMode": thinking_selected,
        "overrideReason": (
            "requested_off_unverified_metadata" if ollama_unverified_off_attempt
            else PROVIDER_MANAGED_UNVERIFIED if provider_managed_minimum
            else "lowest_available_resolved" if thinking_requested == "minimum" and thinking_selected != thinking_requested
            else "mandatory_reasoning_clamp" if thinking_requested == "off" and reasoning_caps.get("mandatory") is True and thinking_selected != "off"
            else "capability_fallback_to_provider_default" if thinking_selected != thinking_requested
            else "none"
        ),
        "capabilitySource": "ollama_live_metadata_unknown_thinking" if ollama_unverified_off_attempt
            else "native_verified_model_family" if native_reasoning else "server_account_cache" if discovery_fresh else (
            "extension_account_catalogue" if discovered_capabilities else "unknown"
        ),
        "supported": reasoning_caps.get("supported"),
        "mandatory": reasoning_caps.get("mandatory"),
        "defaultEnabled": reasoning_caps.get("default_enabled"),
        "dynamic": reasoning_caps.get("dynamic"),
        "control": str(reasoning_caps.get("control") or "unknown"),
        "supportsMaxTokens": reasoning_caps.get("supports_max_tokens"),
        "defaultEffort": reasoning_caps.get("default_effort"),
        "supportedEfforts": reasoning_caps.get("supported_efforts"),
        "effectivePolicy": ("off_requested_runtime_check_pending" if ollama_unverified_off_attempt
                            else "provider_default" if provider_managed_minimum
                            else "reasoning_active" if reasoning_is_active(thinking_selected, reasoning_caps)
                            else "reasoning_off" if thinking_selected == "off"
                            else "provider_default"),
        "lowestResolvedToActiveReasoning": (
            not provider_managed_minimum and thinking_requested == "minimum" and
            reasoning_is_active(thinking_selected, reasoning_caps)
        ),
    })
    spec = provider_registry.require(provider)
    if spec.adapter is None:
        raise RuntimeError(f"AI provider has no adapter: {provider}")
    system_sections = (SystemPromptSection("final_system", system_text, cacheable=True),)
    from backend.ai.accounting import generate_with_receipt
    from backend.ai.workload import bounded_source_workload
    generation_request = GenerationRequest(
        provider=provider, model=model, api_key=api_key, base_url=base_url,
        system_text=system_text, user_parts=tuple(user_parts), image_b64=image_b64,
        system_sections=system_sections,
        # Shared capability resolution turns the user preference (including
        # TextPhantom's synthetic "minimum") into one concrete model-supported
        # mode. Leaf adapters only map that concrete value to native wire fields.
        image_mime=image_mime, thinking=thinking_selected,
        response_schema=response_schema, unit_count=len(ids), expected_ids=tuple(ids),
        model_capabilities=discovered_capabilities,
        workload=bounded_source_workload(ai.workload, source_decoded[0]),
        source_unit_texts=tuple(source_decoded[0]), cancel_check=cancel_check,
        cache_context={**{key: layout[key] for key in ("staticPrefixSha256", "targetLang", "sourceLang")},
                       "translationMode": ai.translation_mode,
                       "operationId": getattr(ai, "paid_operation_id", ""),
                       "thinkingRequested": thinking_requested,
                       "reasoningCapabilityVerified": discovery_fresh and provider not in {"vllm", "llamacpp", "koboldcpp"}
                           and (provider != "ollama" or isinstance(reasoning_caps.get("supported"), bool)),
                       "minimumProviderManagedUnverified": provider_managed_minimum,
                       "conversationSource": encoded_source if conversation_records else "",
                       "conversationRecordProtocol": "tp.translation.image-records/1" if conversation_records else "",
                       **({"_localRuntimeEvidence": runtime_proof} if runtime_proof else {})},
    )
    if ai.translation_mode == "conversation":
        from backend.ai.translation_paths.conversation import prepare
        from backend.ai.translation_paths.store import current
        current().source_texts = source_decoded[0]
        generation_request = prepare(generation_request, layout, ai)
        layout = dict(current().prepared.get("prompt_layout") or layout)
    native_conversation = ai.translation_mode == "conversation" and \
        spec.conversation_transport == "native_response_cursor"
    native_linked = native_conversation and bool(generation_request.previous_response_id)
    if native_conversation:
        layout.update(systemDelivery="provider_native_state" if native_linked else "current_request",
                      effectiveWireSystemChars=0 if native_linked else len(system_text))
    if native_linked:
        # The earlier 02 slot is assembled policy input. On this native
        # continuation the effective wire request contains no System text.
        label = "LM Studio" if spec.provider_id == "lmstudio" else spec.provider_id
        wire_trace.write_text("02_system_prompt.txt",
            f"[{label} native continuation: System retained by provider; not sent in this request]\n")
    trace_preview.note("AI prompt layout", layout)
    wire_trace.write_json("03_prompt_layout.json", layout)
    trace_preview.note("AI provider user-message boundary", {
        "userMessageChars": sum(len(part) for part in generation_request.user_parts),
        "historyMessages": len(generation_request.history_messages),
        "unitCount": len(ids),
    })
    trace_preview.emit(
        "AI diagnostic provider request units",
        trace_preview.marked_units("\n\n".join(generation_request.user_parts)),
        selectedContract=selected_wire_contract,
    )
    result = generate_with_receipt(spec.adapter, generation_request, phase="repair" if is_retry else "initial")
    used_model = result.used_model
    # A selected preference does not prove that the adapter sent a native
    # control or that the provider honored it.
    thinking_applied = getattr(result, "thinking_applied", None) or "unverified"
    if provider_managed_minimum:
        thinking_applied = PROVIDER_MANAGED_UNVERIFIED
    trace_preview.note("AI diagnostic provider response", {
        "selectedContract": selected_wire_contract,
        "finishReason": result.finish_reason,
        "usage": usage_meta(result),
        "providerMs": result.provider_ms,
        "firstContentMs": result.first_content_ms,
        "parseMs": result.parse_ms,
        "response": trace_preview.preview(result.text),
    })

    decoded = decode_result(
        result=result, ids=ids, provider=provider, base_url=base_url,
        used_model=used_model,
        target_lang=target_lang, ai=ai, context_frozen=context_frozen,
        selected_wire_contract=selected_wire_contract, want_memo=want_memo,
        native_schema=structured_output, contract_selection_reason=("conversation_marker_contract" if conversation_records else capability.reason),
        image_b64=image_b64, thinking_selected=thinking_selected,
        thinking_applied=thinking_applied, system_text=system_text,
        user_parts=list(generation_request.user_parts), capture_request=capture_request, is_retry=is_retry,
    )
    if native_linked and capture_request and "debug_request" in decoded.get("meta", {}):
        debug_request = decoded["meta"]["debug_request"]
        debug_request["assembled_system_text"] = debug_request["system_text"]
        debug_request["system_text"] = ""
        debug_request["system_delivery"] = "provider_native_state"
    decoded["meta"]["promptLayout"] = layout
    decoded["meta"]["cacheCoordination"] = result.cache_coordination
    decoded["meta"]["prompt_audit"].update({
        key: layout[key] for key in ("styleRole", "systemStyleCopies", "userStyleCopies", "userStaticChars")
    })
    decoded["meta"]["model_limits"] = dict(discovered_capabilities.get("limits") or {})
    if ai.translation_mode == "conversation":
        from backend.ai.translation_paths.conversation import finish
        finish(result, decoded, ai, source_decoded[0], target_lang, cancel_check)
    else:
        decoded["meta"]["translationMode"] = "independent"
        trace_preview.note("AI translation path", {"schema": "tp.conversation/1", "path": "independent", "mode": "independent", "historyTurns": 0, "historyMessages": 0, "queueWaitMs": 0, "commitStatus": "not_applicable", "legacyFallback": False})
        wire_trace.write_json("03_conversation_path.json", {"schema": "tp.conversation/1", "path": "independent", "historyTurns": 0, "legacyFallback": False})
    wire_trace.write_json("06_parsed_records.json", {
        "aiTextFull": decoded.get("aiTextFull", ""), "meta": decoded.get("meta", {})
    })
    return decoded

def _translate_once(original_text_full, target_lang, ai, **kwargs):
    from backend.ai.translation_paths.store import current
    if ai.translation_mode == "conversation" and current() is None:
        from backend.ai.translation_paths.conversation import execute
        return execute(_translate_once_impl, original_text_full, target_lang, ai, **kwargs)
    return _translate_once_impl(original_text_full, target_lang, ai, **kwargs)


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
    from backend.ai.translation_paths.mode import mode
    selected_mode = mode(ai.translation_mode, default="independent")
    if selected_mode == "conversation":
        from backend.ai.translation_paths.conversation import execute
    else:
        from backend.ai.translation_paths.independent import execute
    result = execute(_translate_once,
        original_text_full, target_lang, ai, is_retry=is_retry,
        reference_text_full=reference_text_full, capture_request=capture_request,
        cancel_check=cancel_check,
    )
    result["meta"].setdefault("sourceUnitCount", len(expected))
    result["meta"].setdefault("batchCount", 1)
    result["meta"].setdefault("batchRanges", [f"0-{len(expected)-1}"] if expected else [])
    return result
