"""Provider usage normalization. Counts are observations, never text estimates.

inputTokens includes cache reads/writes. outputTokens includes reasoning where
reported; its breakdowns must NOT be added to totalTokens again. Money stays a
decimal string. This module does not price tokens or debit a customer's wallet.
"""
from __future__ import annotations
from decimal import Decimal, InvalidOperation, localcontext
from typing import Any

TOKEN_FIELDS = ("inputTokens", "outputTokens", "totalTokens", "cachedInputTokens",
                "cacheWriteInputTokens", "uncachedInputTokens", "ordinaryInputTokens",
                "thinkingTokens", "visibleOutputTokens")
MAX_SAFE_INTEGER = 2**53 - 1

def token(value: Any) -> int | None:
    return value if type(value) is int and 0 <= value <= MAX_SAFE_INTEGER else None

def money(value: Any, *, signed: bool = False) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
        if not number.is_finite() or (not signed and number < 0):
            return None
        return format(number, 'f')
    except (ValueError, InvalidOperation):
        return None

def _dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}

def _pick(raw: dict, *keys: str) -> int | None:
    return next((v for key in keys if (v := token(raw.get(key))) is not None), None)

def finalize_usage(values: dict, *, complete: bool = True) -> dict:
    out = {**values}
    for key in TOKEN_FIELDS:
        out[key] = token(out.get(key))
    inp, output = out['inputTokens'], out['outputTokens']
    reported = out['totalTokens']
    out['totalDerived'] = bool(out.get('totalDerived')) or (reported is None and inp is not None and output is not None)
    if reported is None and inp is not None and output is not None:
        out['totalTokens'] = token(inp + output)
    issues = list(out.get('accountingIssues') or [])
    read, write = out['cachedInputTokens'], out['cacheWriteInputTokens']
    if inp is not None and write is not None and write > inp:
        issues.append('cache_write_exceeds_input')
    if inp is not None and read is not None:
        if read > inp:
            issues.append('cache_read_exceeds_input')
        else:
            out['uncachedInputTokens'] = inp - read
            if write is not None:
                if write > inp - read:
                    issues.append('cache_read_write_exceed_input')
                else:
                    out['ordinaryInputTokens'] = inp - read - write
    thought = out['thinkingTokens']
    if output is not None and thought is not None:
        if thought > output:
            issues.append('reasoning_exceeds_output')
        elif out['visibleOutputTokens'] is None:
            out['visibleOutputTokens'] = output - thought
    if reported is not None and inp is not None and output is not None and reported != inp + output:
        issues.append('provider_total_differs_from_input_plus_output')
    known = [out[key] for key in TOKEN_FIELDS[:3]]
    out['source'] = 'provider' if any(v is not None for v in known) else None
    out['usageStatus'] = ('inconsistent' if issues else 'reported' if complete and all(v is not None for v in known)
                          else 'incomplete' if any(v is not None for v in known) else 'unavailable')
    out['accountingIssues'] = sorted(set(issues))
    out['providerCostUsd'] = money(out.get('providerCostUsd'))
    out['cacheSavingsUsd'] = money(out.get('cacheSavingsUsd'), signed=True)
    out['costSource'] = 'provider' if out['providerCostUsd'] is not None else None
    return out

def normalize_usage(raw: Any, dialect: str = 'openai', *, complete: bool = True,
                    cost_authoritative: bool = False, response_id: str = '') -> dict:
    data = _dict(raw)
    v: dict[str, Any] = {}
    if dialect == 'anthropic':
        fresh = _pick(data, 'input_tokens')
        # Anthropic's optional cache counters default to zero when omitted.
        read = _pick(data, 'cache_read_input_tokens')
        write = _pick(data, 'cache_creation_input_tokens')
        read = 0 if 'cache_read_input_tokens' not in data and fresh is not None else read
        write = 0 if 'cache_creation_input_tokens' not in data and fresh is not None else write
        v.update(inputTokens=(fresh + read + write if all(x is not None for x in (fresh, read, write)) else None),
                 outputTokens=_pick(data, 'output_tokens'), totalTokens=_pick(data, 'total_tokens'),
                 cachedInputTokens=read, cacheWriteInputTokens=write)
    elif dialect == 'gemini':
        visible = _pick(data, 'candidatesTokenCount')
        thought = _pick(data, 'thoughtsTokenCount')
        v.update(inputTokens=_pick(data, 'promptTokenCount'),
                 outputTokens=(visible + (thought or 0) if visible is not None else None),
                 totalTokens=_pick(data, 'totalTokenCount'), visibleOutputTokens=visible,
                 thinkingTokens=thought, cachedInputTokens=_pick(data, 'cachedContentTokenCount'))
        if _pick(data, 'toolUsePromptTokenCount') not in (None, 0):
            # TextPhantom does not issue tools; retain unexpected usage for review.
            v['accountingIssues'] = ['unexpected_tool_prompt_tokens']
    elif dialect == 'ollama':
        v.update(inputTokens=_pick(data, 'prompt_eval_count'), outputTokens=_pick(data, 'eval_count'),
                 totalTokens=_pick(data, 'total_count'), cachedInputTokens=_pick(data, 'prompt_eval_cached_count'))
    else:
        details = _dict(data.get('prompt_tokens_details') or data.get('input_tokens_details'))
        outputs = _dict(data.get('completion_tokens_details') or data.get('output_tokens_details'))
        v.update(inputTokens=_pick(data, 'prompt_tokens', 'input_tokens'),
                 outputTokens=_pick(data, 'completion_tokens', 'output_tokens'),
                 totalTokens=_pick(data, 'total_tokens'),
                 cachedInputTokens=_pick(details, 'cached_tokens'),
                 cacheWriteInputTokens=_pick(details, 'cache_write_tokens'),
                 thinkingTokens=_pick(outputs, 'reasoning_tokens'))
        if v['cachedInputTokens'] is None:
            v['cachedInputTokens'] = _pick(data, 'prompt_cache_hit_tokens')
        if cost_authoritative:
            v['providerCostUsd'] = money(data.get('cost'))
            v['cacheSavingsUsd'] = money(data.get('cache_discount'), signed=True)
        if data.get('is_byok') is True:
            v['isByok'] = True
            v['upstreamInferenceCostUsd'] = money(_dict(data.get('cost_details')).get('upstream_inference_cost'))
    if response_id:
        v['providerGenerationId'] = str(response_id)[:256]
    return finalize_usage(v, complete=complete)

def aggregate_usage(items: list[dict]) -> dict:
    """Keep known subtotals but explicitly report every missing generation."""
    values = [_dict(item) for item in items]
    result: dict[str, Any] = {}
    coverage = {}
    for key in TOKEN_FIELDS:
        known = [n for v in values if (n := token(v.get(key))) is not None]
        result[key] = sum(known) if known else None
        coverage[key] = len(known)
    costs = [money(v.get('providerCostUsd')) for v in values]
    with localcontext() as ctx:
        ctx.prec = max([len(x) for x in costs if x is not None] + [28]) + len(str(len(costs))) + 4
        result['providerCostUsd'] = (format(sum((Decimal(x) for x in costs if x is not None), Decimal(0)), 'f')
                                     if any(x is not None for x in costs) else None)
    result['costSource'] = 'provider' if result['providerCostUsd'] is not None else None
    complete_count = sum(all(token(v.get(k)) is not None for k in TOKEN_FIELDS[:3])
                         and v.get('usageStatus') not in {'incomplete', 'unavailable', 'inconsistent'} for v in values)
    result.update(source='provider' if any(result[k] is not None for k in TOKEN_FIELDS[:3]) else None,
                  usageStatus='reported' if values and complete_count == len(values) else 'incomplete',
                  generationCount=len(values), reportedGenerations=complete_count,
                  missingUsageGenerations=len(values)-complete_count, tokenCoverage=coverage,
                  costReportedGenerations=sum(x is not None for x in costs),
                  generations=values)
    return result
