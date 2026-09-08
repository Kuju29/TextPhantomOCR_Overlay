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
    result = {key: value[key] for key in ('contextTokens', 'maxOutputTokens', 'outputHintTokens', 'maxInputTokens')
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


class WorkloadBudgetError(ValueError):
    code = 'ai_workload_budget_insufficient'
    requestDispatched = False
    providerAttempts = 0
    generationAttempts = 0


def guard_output_budget(standard, *, workload=None, limits=None, system='', parts=(), schema=None, image=False):
    hint = normalize_workload(workload)
    if not hint:
        return standard
    bounds = normalize_limits(limits)
    inp = math.ceil((text_weight(system) + text_weight('\n\n'.join(parts)) +
                     (text_weight(json.dumps(schema, ensure_ascii=False)) if schema else 0) +
                     64 + (2048 if image else 0)) * 1.25)
    expected = hint.get('predictedOutput', 1)
    reasoning = hint.get('reasoningReserve', 0)
    available = min(8192, bounds.get('maxOutputTokens', math.inf), bounds.get('outputHintTokens', math.inf),
                    bounds['contextTokens'] - inp - 128 if bounds.get('contextTokens') else math.inf,
                    hint.get('completionAvailable', math.inf))
    if inp > bounds.get('maxInputTokens', math.inf) or available < expected + reasoning:
        raise WorkloadBudgetError('The composed prompt and estimated response exceed the available model budget')
    requested = max(standard, min(8192, expected + reasoning + max(128, math.ceil(expected * .5))))
    return max(1, math.floor(min(available, requested)))


def guard_request_budget(request, standard):
    return guard_output_budget(standard, workload=request.workload,
        limits=request.model_capabilities.get('limits'), system=request.system_text,
        parts=request.user_parts, schema=dict(request.response_schema) if request.response_schema else None,
        image=bool(request.image_b64))
