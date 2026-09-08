"""Decode and describe one provider translation response."""

import hashlib
from typing import Any

from backend.ai import markers, parsing, prompts, trace_preview
from backend.ai.clients.base import usage_meta
from backend.ai.errors import ModelOutputContractError
from backend.ai.rate_policy import is_local_target
from backend.ai.translation.contracts import AiConfig, AiResult
from backend.lens.languages import normalize as normalize_lang

def _require_authoritative_terminal(result) -> None:
    """Reject a clean-looking body when the provider protocol ended by EOF."""
    if result.terminal_completed is True:
        return
    error = ModelOutputContractError(
        "AI provider response ended without authoritative terminal completion",
        response_shape="provider_protocol_incomplete",
        expectedContract="tp.translation.compact-records/1",
        validatorSubtype="missing_provider_terminal",
        terminalEvidence=result.terminal_evidence or "none",
        finishReason=result.finish_reason,
    )
    error.code = "AI_OUTPUT_CONTRACT_MISMATCH"
    raise error

def decode_result(*, result, ids: list[str], provider: str, base_url: str,
                  used_model: str,
                  target_lang: str, ai: AiConfig, context_frozen: bool,
                  selected_wire_contract: str, want_memo: bool, image_b64: str,
                  native_schema: bool = False,
                  contract_selection_reason: str = "legacy_compact_default",
                  thinking_selected: str, thinking_applied: str, system_text: str,
                  user_parts: list, capture_request: bool, is_retry: bool) -> AiResult:
    finish_reason = str(result.finish_reason or "").strip().lower()
    provider_output_truncated = finish_reason in {
        "length", "max_tokens", "max_output_tokens", "truncated",
    }
    positive_terminal_completion = result.terminal_completed is True
    try:
        _require_authoritative_terminal(result)
        decoder = (
            markers.decode_legacy_translation_response
            if native_schema else markers.decode_translation_response
        )
        decoded = decoder(result.text, ids, require_complete=True,
                          allow_complete_without_end=(
                              not provider_output_truncated and positive_terminal_completion
                          ))
        if native_schema:
            values = markers.extract_paragraphs_exact(decoded.ai_text_full, len(ids))
            empty_ids = [item for item, text in zip(ids, values[0] if values else []) if not text.strip()]
            if decoded.response_shape not in {"flat_json", "flat_json_wrapped"} or decoded.missing_ids or empty_ids:
                error = ModelOutputContractError(
                    "AI native schema response does not contain every required translation",
                    response_shape=decoded.response_shape,
                    expectedContract="json_schema_object_v1",
                    missingIds=list(decoded.missing_ids), emptyIds=empty_ids,
                    validatorSubtype="schema_result_mismatch",
                )
                error.code = "AI_OUTPUT_CONTRACT_MISMATCH"
                raise error
    except ModelOutputContractError as exc:
        # Every violation of the selected provider-output contract uses the
        # same public typed failure, including errors raised by compatibility
        # JSON decoding before the stricter schema-shape checks below.
        exc.code = "AI_OUTPUT_CONTRACT_MISMATCH"
        raw_bytes = str(result.text or "").encode("utf-8")
        exc.structural_details.setdefault("responseChars", len(str(result.text or "")))
        exc.structural_details.setdefault(
            "responseSha256", hashlib.sha256(raw_bytes).hexdigest()
        )
        exc.structural_details.setdefault("resolvedProvider", provider)
        exc.structural_details.setdefault("resolvedModel", used_model)
        exc.structural_details.setdefault("generationMeta", {
            "usage": usage_meta(result),
            "finish_reason": result.finish_reason,
            "provider_ms": result.provider_ms,
            "provider_parse_ms": result.parse_ms,
            "timeout_policy": (
                "local_connect_bounded_read_unbounded"
                if is_local_target(provider, base_url)
                else "provider_total_bounded"
            ),
        })
        trace_preview.note("AI diagnostic contract failure", {
            "selectedContract": selected_wire_contract,
            "validatorSubtype": exc.structural_details.get("validatorSubtype", "unknown"),
            "endMarkerPresent": exc.structural_details.get("endMarkerPresent", False),
            "response": trace_preview.preview(result.text),
            "missingIds": list(exc.structural_details.get("missingIds", [])),
            "emptyIds": list(exc.structural_details.get("emptyIds", [])),
            "extraIds": list(exc.structural_details.get("extraIds", [])),
            "duplicateIds": list(exc.structural_details.get("duplicateIds", [])),
            "finishReason": result.finish_reason,
            "providerOutputTruncated": provider_output_truncated,
            "terminalCompleted": positive_terminal_completion,
            "terminalEvidence": result.terminal_evidence or "none",
            "responseChars": len(str(result.text or "")),
        })
        if provider_output_truncated:
            from backend.ai.clients.base import OutputBudgetExhausted
            raise OutputBudgetExhausted(
                "AI used its output budget before completing every translation ID",
                response_shape=exc.response_shape,
                **exc.structural_details,
            ) from exc
        raise
    if decoded.accepted_without_end_marker:
        trace_preview.note("AI diagnostic accepted output without end marker", {
            "selectedContract": selected_wire_contract,
            "validatorSubtype": "accepted_without_end_marker",
            "endMarkerPresent": False,
            "missingIds": list(decoded.missing_ids),
            "emptyIds": [],
            "extraIds": [],
            "duplicateIds": [],
            "finishReason": result.finish_reason,
            "terminalCompleted": positive_terminal_completion,
            "terminalEvidence": result.terminal_evidence or "none",
            "responseChars": len(str(result.text or "")),
        })
    ai_text_full = decoded.ai_text_full
    trace_preview.emit(
        "AI diagnostic decoded response units", trace_preview.marked_units(ai_text_full),
        selectedContract=selected_wire_contract, missingIds=list(decoded.missing_ids),
        extraIds=list(decoded.discarded_ids), duplicateIds=list(decoded.duplicate_ids),
        ignoredProseChars=decoded.ignored_prose_chars,
    )
    memo = decoded.memo if want_memo else ""
    characters = parsing.parse_character_memo(memo) if memo else []

    meta: dict[str, Any] = {
        "model": used_model,
        "requested_output_tokens": result.requested_output_tokens,
        "upstream_provider": result.upstream_provider,
        "provider": provider,
        "base_url": base_url,
        "target_lang": normalize_lang(target_lang),
        "ai_flow": "brief_frozen" if context_frozen else "per_page",
        "output_contract": decoded.response_shape,
        "requested_contract": selected_wire_contract,
        "selected_contract": selected_wire_contract,
        "native_schema": native_schema,
        "contract_selection_reason": contract_selection_reason,
        "response_shape": decoded.response_shape,
        "accepted_without_end_marker": decoded.accepted_without_end_marker,
        "terminal_completed": result.terminal_completed is True,
        "terminal_evidence": result.terminal_evidence or "none",
        "completion_evidence": result.terminal_evidence or "none",
        "first_all_ids_ms": result.first_all_ids_ms,
        "early_completion_ms": result.early_completion_ms,
        "terminal_ms": result.terminal_ms,
        "thinking_selected": thinking_selected,
        "thinking_applied": thinking_applied,
        "accepted_losslessly": decoded.accepted_losslessly,
        "content_modified": decoded.content_modified,
        "omitted_ids": list(decoded.missing_ids),
        "ignored_output_ids": list(decoded.discarded_ids),
        "duplicate_output_ids": list(decoded.duplicate_ids),
        "ignored_output_prose_chars": decoded.ignored_prose_chars,
        "malformed_output_record_count": decoded.malformed_line_count,
        "usage": usage_meta(result),
        "finish_reason": result.finish_reason,
        "provider_ms": result.provider_ms,
        "provider_parse_ms": result.parse_ms,
        "prompt_eval_ms": result.prompt_eval_ms,
        "timeout_policy": (
            "local_connect_bounded_read_unbounded"
            if is_local_target(provider, base_url)
            else "provider_total_bounded"
        ),
        "prompt_audit": prompts.prompt_trace_metadata(
            target_lang,
            ai.prompt_editable,
            prompt_mode=getattr(ai, "prompt_mode", None),
            effective_system_text=system_text,
        ),
    }
    if characters:
        meta["characters"] = characters
    if image_b64:
        meta["vision"] = True
    if capture_request:
        meta["debug_request"] = {
            "system_text": system_text,
            "user_parts": user_parts,
            "is_retry": is_retry,
        }
        meta["debug_response_raw"] = result.text
    return AiResult(aiTextFull=ai_text_full, meta=meta)
