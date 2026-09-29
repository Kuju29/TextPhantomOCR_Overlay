"""Workload metadata and completion guard; no model names, retries or prompt edits."""
from __future__ import annotations

import json
import math
import unicodedata
from collections.abc import Mapping


def positive(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 < value <= 100_000_000 else None


def normalize_limits(value):
    if not isinstance(value, Mapping):
        return {}
    result = {key: value[key] for key in ('contextTokens', 'maxOutputTokens', 'outputHintTokens', 'maxInputTokens', 'runtimeContextTokens', 'modelContextTokens', 'configuredContextTokens')
              if positive(value.get(key))}
    for key in ('source', 'scope', 'modelRevision', 'tokenizer'):
        if isinstance(value.get(key), str):
            result[key] = value[key][:160]
    return result


def normalize_workload(value):
    if not isinstance(value, Mapping) or value.get('version') != 1:
        return {}
    result = {'version': 1}
    for key in ('predictedOutput', 'reasoningReserve', 'estimatedInput', 'completionAvailable'):
        if positive(value.get(key)):
            result[key] = value[key]
    # Limits are taken from account-scoped capability metadata, not this hint.
    return result


def text_weight(value):
    total = 0.0
    for char in str(value or ''):
        cp = ord(char)
        dense = (0x3400 <= cp <= 0x9fff or 0x3040 <= cp <= 0x30ff or
                 0xac00 <= cp <= 0xd7af or 0x0e00 <= cp <= 0x0eff or
                 0x1780 <= cp <= 0x17ff or 0x1000 <= cp <= 0x109f or cp >= 0x20000)
        total += .1 if char.isspace() else 1 if dense else .25 if unicodedata.category(char)[0] in 'LN' else .5
    return max(1, math.ceil(total))


def source_output_allowance(parts):
    """Bound a public estimate by source content, not padding or client hints."""
    texts = tuple(str(part or '') for part in parts)
    substantive = tuple(''.join(char for char in part if not char.isspace())
                        for part in texts)
    chars = sum(len(part) for part in substantive)
    weight = sum(text_weight(part) for part in substantive)
    return max(1024, math.ceil(max(chars, weight) * 3 + len(texts) * 112 + 384))


def bounded_source_workload(workload, source_unit_texts):
    """A translated, validated source bounds numerical browser predictions."""
    hint = normalize_workload(workload)
    if not hint:
        return hint
    result = dict(hint)
    if 'predictedOutput' in result:
        result['predictedOutput'] = min(result['predictedOutput'],
                                        source_output_allowance(source_unit_texts))
    if 'reasoningReserve' in result:
        result['reasoningReserve'] = min(result['reasoningReserve'], 8192)
    return result


def observed_input_scale(samples):
    """Two times the largest observed actual/raw ratio, with a 45% floor.

    Samples are provider-reported input counts for this model and private
    conversation.  Never infer a smaller request from a cache read count.
    """
    valid = [actual / raw for actual, raw in samples[-8:]
             if isinstance(actual, int) and actual >= 256 and isinstance(raw, int) and raw > 0]
    return min(1.0, max(.45, 2 * max(valid))) if valid else 1.0


class WorkloadBudgetError(ValueError):
    code = 'ai_workload_budget_insufficient'
    requestDispatched = False
    providerAttempts = 0
    generationAttempts = 0


def estimate_provider_input(*, system='', parts=(), schema=None, image=False, history=()):
    # Only conversation.prepare can populate this process-local lease. A client
    # workload hint must never reduce the server's context-window guard.
    from backend.ai.translation_paths.store import current
    scale = getattr(current(), 'input_estimate_scale', 1.0)
    if history:
        from backend.ai.translation_paths.messages import history_parts
        extra = sum(bool(m.get('image_b64')) for m in history) * 2048 + len(history) * 8
        return math.ceil((text_weight(system) + text_weight('\n\n'.join(history_parts(history) + list(parts))) +
            (text_weight(json.dumps(schema, ensure_ascii=False)) if schema else 0) + 64 +
            (2048 if image else 0) + extra) * 1.25 * scale)
    return math.ceil((text_weight(system) + text_weight('\n\n'.join(parts)) +
                     (text_weight(json.dumps(schema, ensure_ascii=False)) if schema else 0) +
                     64 + (2048 if image else 0)) * 1.25 * scale)


def guard_output_budget(standard, *, workload=None, limits=None, system='', parts=(), source_unit_texts=(), schema=None, image=False, history=()):
    hint = normalize_workload(workload)
    bounds = normalize_limits(limits)
    inp = estimate_provider_input(system=system, parts=parts, schema=schema, image=image, history=history)
    source_allowance = source_output_allowance(source_unit_texts or parts)
    expected = min(hint.get('predictedOutput', 1), source_allowance)
    reasoning = min(hint.get('reasoningReserve', 0), 8192)
    # The model window is physical evidence; an 8K ordinary request is a
    # generation policy. Neither an unverified routing hint nor a browser's
    # completionAvailable may become a physical provider ceiling.
    available = min(bounds.get('maxOutputTokens') or math.inf,
                    bounds['contextTokens'] - inp - 128 if bounds.get('contextTokens') else math.inf)
    if inp > bounds.get('maxInputTokens', math.inf) or available < expected + reasoning or available < 1:
        error = WorkloadBudgetError('The composed prompt and estimated response exceed the available model budget')
        error.diagnostics = {"constraintScope":"per_request", "estimatedInput":inp,
            "estimatedOutput":expected, "reasoningReserve":reasoning,
            "contextLimit":bounds.get("contextTokens"),"outputLimit":bounds.get("maxOutputTokens"),"inputLimit":bounds.get("maxInputTokens"),
            "completionAvailable":max(0,int(available)) if math.isfinite(available) else None,
            "constraint":"input_limit" if inp > bounds.get('maxInputTokens', math.inf) else
                "context_window" if bounds.get('contextTokens') and inp+expected+reasoning+128 > bounds['contextTokens'] else "output_budget"}
        raise error
    requested = max(standard, expected + reasoning + max(128, math.ceil(expected * .5))) if hint else standard
    return max(1, math.floor(min(available, requested,
        max(standard, source_allowance + reasoning))))


def guard_request_budget(request, standard):
    workload = request.workload
    reasoning = request.model_capabilities.get('reasoning') or {}
    if (request.cache_context.get('reasoningCapabilityVerified') is True and
            isinstance(reasoning, Mapping) and reasoning.get('supported') is False):
        # A browser estimate from an earlier, reasoning-capable instance is
        # not required output space after this exact model was verified plain.
        workload = {**workload, 'reasoningReserve': 0}
    return guard_output_budget(standard, workload=workload,
        limits=request.model_capabilities.get('limits'), system=request.system_text,
        parts=request.user_parts, source_unit_texts=request.source_unit_texts,
        schema=dict(request.response_schema) if request.response_schema else None,
        image=bool(request.image_b64), history=request.history_messages)
