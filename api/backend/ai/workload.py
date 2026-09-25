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


def guard_output_budget(standard, *, workload=None, limits=None, system='', parts=(), schema=None, image=False, history=()):
    hint = normalize_workload(workload)
    if not hint:
        return standard
    bounds = normalize_limits(limits)
    inp = estimate_provider_input(system=system, parts=parts, schema=schema, image=image, history=history)
    expected = hint.get('predictedOutput', 1)
    reasoning = hint.get('reasoningReserve', 0)
    application_ceiling = max(8192, hint.get('completionAvailable', 0) or 8192)
    available = min(application_ceiling, bounds.get('maxOutputTokens', math.inf), bounds.get('outputHintTokens', math.inf),
                    bounds['contextTokens'] - inp - 128 if bounds.get('contextTokens') else math.inf,
                    hint.get('completionAvailable', math.inf))
    if inp > bounds.get('maxInputTokens', math.inf) or available < expected + reasoning:
        error = WorkloadBudgetError('The composed prompt and estimated response exceed the available model budget')
        error.diagnostics = {"constraintScope":"per_request", "estimatedInput":inp,
            "estimatedOutput":expected, "reasoningReserve":reasoning,
            "contextLimit":bounds.get("contextTokens"),"outputLimit":bounds.get("maxOutputTokens"),"inputLimit":bounds.get("maxInputTokens"),
            "completionAvailable":max(0,int(available)) if math.isfinite(available) else None,
            "constraint":"input_limit" if inp > bounds.get('maxInputTokens', math.inf) else
                "context_window" if bounds.get('contextTokens') and inp+expected+reasoning+128 > bounds['contextTokens'] else "output_budget"}
        raise error
    requested = max(standard, min(application_ceiling, expected + reasoning + max(128, math.ceil(expected * .5))))
    return max(1, math.floor(min(available, requested)))


def guard_request_budget(request, standard):
    return guard_output_budget(standard, workload=request.workload,
        limits=request.model_capabilities.get('limits'), system=request.system_text,
        parts=request.user_parts, schema=dict(request.response_schema) if request.response_schema else None,
        image=bool(request.image_b64), history=request.history_messages)
