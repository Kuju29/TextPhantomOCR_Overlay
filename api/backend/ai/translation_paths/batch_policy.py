"""Conversation-only ready-page sizing. Actual adapter/history guards still apply."""
from __future__ import annotations
import math
from backend.ai import markers, prompts
from backend.ai.workload import text_weight, estimate_provider_input, observed_input_scale, WorkloadBudgetError
from backend.ai.reasoning_preference import reasoning_is_active


def _capacity(profile, ai):
    continuation = profile.get('successes', 0) > 0
    cache_ratio = max(0.0, min(1.0, float(profile.get('cacheRatio') or 0.0)))
    reasoning_caps = dict((getattr(ai, 'model_capabilities', {}) or {}).get('reasoning') or {})
    reasoning_risk = (reasoning_is_active(getattr(ai, 'thinking', 'off'), reasoning_caps)
        or profile.get('reasoningSeen') is True)

    # Content/output budget owns batching. The record count is telemetry only;
    # marker/prompt overhead per unit is already present in _estimate().
    target_output = 1280 if reasoning_risk else 1536
    records = 200
    capacity = 'continuation_token_budget' if continuation else 'anchor'

    if profile.get('restricted') or profile.get('reliabilityRestricted') or 'length' in profile.get('outcomes', []):
        target_output = min(target_output, 1024 if reasoning_risk else 1280)
        capacity = 'continuation_reliability_restricted'

    # Cache and provider latency are observability/economics signals, not
    # capacity gates. A slow turn must not shrink the next serialized request.
    return target_output, records, capacity, cache_ratio


def _estimate(candidate_rows, ai, target, profile, target_output, records):
    texts = [row['text'] for row in candidate_rows]
    ratios = sorted(profile.get('ratios', []))
    ratio = ratios[min(len(ratios)-1, math.floor((len(ratios)-1)*.9))] if ratios else 1.5
    reasoning_caps = dict((getattr(ai, 'model_capabilities', {}) or {}).get('reasoning') or {})
    reasoning_active = (reasoning_is_active(ai.thinking, reasoning_caps)
        or profile.get('reasoningSeen') is True)
    reasoning_unbounded = reasoning_active and reasoning_caps.get('supports_max_tokens') is not True
    reasoning = max(profile.get('reasoning', 0), 2048 if reasoning_unbounded else 768 if reasoning_active else 0)
    style, _ = prompts.select_style(target, ai.prompt_editable, prompts.normalize_prompt_mode(ai.prompt_mode))
    system = prompts.build_translator_identity_system(style, target)
    bounds = dict(ai.model_capabilities.get('limits') or {})
    app_ceiling = 16384 if reasoning_unbounded else 8192
    cap = min(app_ceiling, bounds.get('maxOutputTokens') or app_ceiling, bounds.get('outputHintTokens') or app_ceiling)
    structured = 'json' in ai.output_contract.lower() or 'schema' in ai.output_contract.lower()
    ids = [f'P{i}' for i in range(len(texts))]
    user = prompts.build_translation_user_message(target, ai.prompt_editable,
        markers.apply_schema_source(texts) if structured else markers.apply_wire(texts), ids,
        structured_output=structured, prompt_mode=ai.prompt_mode, glossary=ai.glossary,
        characters=ai.characters if (ai.char_memory or ai.context_frozen) else None,
        has_image=bool(ai.image_b64), series_state=ai.series_state, speakers=ai.speakers,
        prev_context=ai.prev_context, page_context=ai.page_context, source_context=ai.source_context,
        source_lang=ai.source_lang, style_examples=True, memory_mode=ai.memory_mode)
    schema = markers.translation_schema(markers.apply(texts)) if structured else None
    raw_input = estimate_provider_input(system=system, parts=[user], schema=schema,
        image=bool(ai.image_b64)) + len(texts)*30 + 128
    ctx = bounds.get('contextTokens')
    can_calibrate = (ai.provider in ('openrouter', 'openai') and isinstance(ctx, int) and
                     0 < ctx <= 16384 and not ai.image_b64 and not schema)
    scale = observed_input_scale(profile.get('inputSamples', [])) if can_calibrate else 1.0
    estimated_input = math.ceil(raw_input * scale)
    base = sum(text_weight(t) for t in texts) + len(texts)*(8 if structured else 12) + 4
    output = math.ceil(base*ratio*1.25)
    if ai.provider == 'ollama':
        from backend.ai.providers.ollama_context import plan_ollama_context
        cp = plan_ollama_context(bounds, {'estimatedInput':estimated_input,
            'predictedOutput':output, 'reasoningReserve':reasoning})
        if cp: ctx = cp['evidence']['requestedContext']
    available = min(cap, ctx-estimated_input-128 if ctx else cap)
    hard = output+reasoning <= available and estimated_input <= (bounds.get('maxInputTokens') or math.inf)
    soft = output <= target_output
    reason = 'input_limit' if estimated_input > (bounds.get('maxInputTokens') or math.inf) else \
        'context_window' if ctx and output+reasoning > ctx-estimated_input-128 else \
        'output_budget' if output+reasoning > cap else None
    return {
        'version': 1, 'estimatedInput': estimated_input, 'rawEstimatedInput': raw_input,
        'inputEstimateScale':scale, 'predictedOutput': output,
        'reasoningReserve': reasoning, 'completionAvailable': max(0, math.floor(available)),
        'baseOutput': base, 'hard': hard, 'soft': soft, 'hardReason': reason,
        'target': target_output, 'recordTarget': records,
    }


def _hard_prefix(page, ai, target, profile, target_output, records):
    """Return the largest semantic-unit prefix of one page that fits hard limits."""
    picked, last = [], None
    chars = 0
    for row in page:
        row_chars = len(str(row.get('text') or ''))
        if picked and (len(picked) >= 128 or chars + row_chars > 58000):
            break
        candidate = picked + [row]
        estimate = _estimate(candidate, ai, target, profile, target_output, records)
        if picked and not estimate['hard']:
            break
        if not estimate['hard']:
            exc = WorkloadBudgetError('One current unit plus the required prompt cannot fit the model budget')
            exc.diagnostics = {'estimatedInput': estimate['estimatedInput'],
                'estimatedOutput': estimate['predictedOutput'],
                'constraint': estimate.get('hardReason') or 'context_or_output'}
            raise exc
        picked, last, chars = candidate, estimate, chars + row_chars
    return picked, last


def select_rows(rows, ai, target, profile):
    """Pack complete READY pages; split inside a page only at a real hard limit."""
    target_output, records, capacity, cache_ratio = _capacity(profile, ai)
    # The ready registry emits rows in page/ticket order. Preserve those page
    # boundaries so soft targets can stop before the next page instead of
    # consuming a partial page just to fill a record/output target.
    pages = []
    for row in rows:
        if not pages or pages[-1][0]['ticket'] is not row['ticket']:
            pages.append([row])
        else:
            pages[-1].append(row)

    selected, last = [], None
    chars = 0
    reason = 'ready_queue_drained'
    for page in pages:
        page_chars = sum(len(str(row.get('text') or '')) for row in page)
        if not selected and (len(page) > 128 or page_chars > 58000):
            selected, last = _hard_prefix(page, ai, target, profile, target_output, records)
            reason = 'hard_application_source_limit_partial_page'
            break
        if selected and (len(selected)+len(page) > 128 or chars+page_chars > 58000):
            reason = 'request_source_limit_before_page'
            break

        candidate = selected + page
        estimate = _estimate(candidate, ai, target, profile, target_output, records)
        if not estimate['hard']:
            if selected:
                reason = f"per_request_{estimate.get('hardReason') or 'budget'}_before_page"
                break
            selected, last = _hard_prefix(page, ai, target, profile, target_output, records)
            reason = 'hard_provider_budget_partial_page'
            break
        if selected and not estimate['soft']:
            reason = 'conversation_page_output_target'
            break

        selected, last, chars = candidate, estimate, chars + page_chars
        if not estimate['soft']:
            reason = 'whole_page_over_soft_target'
            break

    if not selected:
        return [], {}, 'ready_queue_drained'
    last = dict(last or {})
    last['conversationCapacity'] = capacity
    last['cacheRatio'] = cache_ratio
    last['cacheConfirmed'] = profile.get('cacheConfirmed') is True
    last.pop('hard', None); last.pop('soft', None); last.pop('hardReason', None)
    return selected, last, reason


def learn(profile, result, estimate):
    meta = result.get('meta') or {}; u = meta.get('usage') or {}
    ev = meta.get('conversation') or {}
    valid = ev.get('commitStatus') in ('committed','pending_commit','ephemeral_not_retained')
    if valid:
        profile['successes'] = profile.get('successes',0)+1
        if u.get('thinkingTokens') == 0:
            profile['zeroReasoningSamples'] = profile.get('zeroReasoningSamples',0)+1
        value = u.get('visibleOutputTokens')
        if value is not None and estimate.get('baseOutput'):
            profile['ratios'] = (profile.get('ratios',[])+[max(.05,min(32,value/estimate['baseOutput']))])[-64:]
    cached, actual = u.get('cachedInputTokens'), u.get('inputTokens')
    raw = ev.get('rawEstimatedInput')
    if valid and isinstance(actual, int) and actual >= 256 and isinstance(raw, int) and raw > 0:
        profile['inputSamples'] = (profile.get('inputSamples', []) + [(actual, raw)])[-8:]
    if isinstance(cached, int) and cached > 0 and isinstance(actual, int) and actual > 0:
        profile['cacheConfirmed'] = True
        profile['cacheRatio'] = max(0.0, min(1.0, cached/actual))
        profile['cacheMissStreak'] = 0
    elif isinstance(actual, int) and actual > 0:
        profile['cacheMissStreak'] = profile.get('cacheMissStreak',0)+1
    if (u.get('thinkingTokens') or 0) > 0:
        profile['reasoningSeen'] = True
        profile['reasoning'] = max(profile.get('reasoning',0), math.ceil(u['thinkingTokens']*1.2))
    if meta.get('finish_reason') in ('length','max_tokens'):
        profile['restricted'] = True
