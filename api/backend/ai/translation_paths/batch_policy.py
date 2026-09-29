"""Conversation-only ready-page sizing. Actual adapter/history guards still apply."""
from __future__ import annotations
import math
from dataclasses import replace
from dataclasses import dataclass, field
import hashlib
import threading
import time
from backend.ai import markers, prompts
from backend.ai.workload import text_weight, estimate_provider_input, observed_input_scale, WorkloadBudgetError
from backend.ai.reasoning_preference import reasoning_is_active

MAX_SOURCE_UNITS, MAX_SOURCE_CHARS = 512, 58000
# Local Independent remains governed by live runtime/learned capacity, not
# Cloud history amortisation. Registry-derived IDs avoid a second provider list.
from backend.ai.provider_registry import provider_registry
# Resolve at call time: concrete declarations are composed after module imports.


@dataclass(slots=True)
class PreparedModelEvidence:
    """One operation's private native Local metadata; no wire serialization."""
    provider: str
    model: str
    base_url: str
    key_digest: str = field(repr=False)
    capabilities: dict = field(repr=False)
    issued_at: float = field(repr=False)
    used: bool = field(default=False, repr=False)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def consume(self, provider, model, base_url, key):
        with self.lock:
            if self.used or (provider, model, base_url, hashlib.sha256(key.encode()).hexdigest()) != (
                    self.provider, self.model, self.base_url, self.key_digest):
                return None
            self.used = True
            if time.monotonic() - self.issued_at > 5.0:
                return None
            return dict(self.capabilities)


def _private_proof(provider, model, base, key, capabilities):
    return PreparedModelEvidence(provider, model, base,
        hashlib.sha256(key.encode()).hexdigest(), dict(capabilities), time.monotonic())


def _capacity(profile, ai):
    continuation = profile.get('successes', 0) > 0
    cache_ratio = max(0.0, min(1.0, float(profile.get('cacheRatio') or 0.0)))
    reasoning_caps = dict((getattr(ai, 'model_capabilities', {}) or {}).get('reasoning') or {})
    reasoning_risk = (reasoning_is_active(getattr(ai, 'thinking', 'off'), reasoning_caps)
        or (profile.get('reasoningSeen') is True and
            reasoning_caps.get('supported') is not False and
            profile.get('zeroReasoningSamples', 0) < 2))

    # Content/output budget owns batching. The record count is telemetry only;
    # marker/prompt overhead per unit is already present in _estimate().
    target_output = 1280 if reasoning_risk else 1536
    records = 200
    capacity = 'continuation_token_budget' if continuation else 'anchor'

    # Fallback for unverified windows. _estimate() sizes each candidate from
    # its own remaining context/output capacity when both model limits are known.
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
        or (profile.get('reasoningSeen') is True and
            reasoning_caps.get('supported') is not False and
            profile.get('zeroReasoningSamples', 0) < 2))
    # Observed reasoning while Thinking is Off needs output headroom, but it
    # must not silently turn the user's ordinary 8K request into 16K.
    reasoning_unbounded = (reasoning_is_active(ai.thinking, reasoning_caps)
                           and reasoning_caps.get('supports_max_tokens') is not True)
    measured_reasoning = max(profile.get('reasoning', 0) if reasoning_active else 0,
                             2048 if reasoning_unbounded else 768 if reasoning_active else 0)
    style, _ = prompts.select_style(target, ai.prompt_editable, prompts.normalize_prompt_mode(ai.prompt_mode))
    system = prompts.build_translator_identity_system(style, target)
    bounds = dict(ai.model_capabilities.get('limits') or {})
    structured = 'json' in ai.output_contract.lower() or 'schema' in ai.output_contract.lower()
    ids = [f'P{i}' for i in range(len(texts))]
    user = prompts.build_translation_user_message(target, ai.prompt_editable,
        markers.apply_schema_source(texts) if structured else markers.apply_wire(texts), ids,
        structured_output=structured, prompt_mode=ai.prompt_mode, glossary=ai.glossary,
        characters=ai.characters if (ai.char_memory or ai.context_frozen) else None,
        has_image=bool(ai.image_b64), series_state=ai.series_state, speakers=ai.speakers,
        prev_context=ai.prev_context, page_context=ai.page_context, source_context=ai.source_context,
        source_lang=ai.source_lang,
        style_examples=getattr(ai, 'style_examples', True),
        memory_mode=ai.memory_mode)
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
    # 8192 is a normal request target, never a made-up model maximum. A long
    # indivisible unit may need a larger completion when the live model allows
    # it; a provider's routing/output hint is not a physical limit either.
    physical_output = bounds.get('maxOutputTokens') or math.inf
    reasoning = (max(measured_reasoning, min(8192, physical_output // 2))
                 if reasoning_active and math.isfinite(physical_output) and physical_output >= 2048
                 else measured_reasoning)
    if ai.provider == 'ollama':
        from backend.ai.providers.ollama_context import plan_ollama_context
        from backend.ai.generation_defaults import DEFAULT_GENERATION, output_token_budget
        # Ollama receives num_predict (Thinking and answer share that number).
        # A live mandatory/Lowest mode sends 8192 even for a short source;
        # sizing context against only ~529 translation tokens understates the
        # actual on-wire request. A verified Off/plain model keeps the small
        # source-derived allocation.
        native_output = (DEFAULT_GENERATION.max_output_tokens
            if reasoning_active or (ai.thinking == 'default' and reasoning_caps.get('supported') is not False)
            else output_token_budget([user],system,unit_count=len(texts)))
        cp = plan_ollama_context(bounds, {'estimatedInput':estimated_input,
            'predictedOutput':max(native_output, output+reasoning), 'reasoningReserve':0})
        if cp: ctx = cp['evidence']['requestedContext']
    physical_available = min(physical_output, ctx-estimated_input-128 if ctx else math.inf)
    available = min(physical_available, max(8192, output + reasoning + max(256, math.ceil(output*.5))))
    hard = output+reasoning <= available and estimated_input <= (bounds.get('maxInputTokens') or math.inf)
    context_limit = bounds.get('contextTokens') or bounds.get('maxInputTokens')
    large_context = type(context_limit) is int and context_limit >= 32768
    reported_output = type(bounds.get('maxOutputTokens')) is int and bounds['maxOutputTokens'] > 0
    provider_spec = provider_registry.get(ai.provider)
    application_window = bool(provider_spec and not provider_spec.local) and not reported_output and large_context
    sized_window = large_context and (reported_output or application_window)
    recent_length = 'length' in profile.get('outcomes', [])[-4:]
    if sized_window:
        # The predicted answer already includes a 1.25 multiplier. Leave 10%
        # more of the actual request window unused and reserve hidden reasoning.
        # A recent truncation temporarily increases headroom for four turns.
        policy_window = min(physical_available, max(8192, 8192 + reasoning))
        target_output = max(0, math.floor(policy_window * (.75 if recent_length else .9)) - reasoning)
    soft = output <= target_output
    reason = 'input_limit' if estimated_input > (bounds.get('maxInputTokens') or math.inf) else \
        'context_window' if ctx and output+reasoning > ctx-estimated_input-128 else \
        'output_budget' if output+reasoning > physical_output else None
    return {
        'version': 1, 'estimatedInput': estimated_input, 'rawEstimatedInput': raw_input,
        'inputEstimateScale':scale, 'predictedOutput': output,
        'reasoningReserve': reasoning, 'completionAvailable': max(0, math.floor(available)),
        'baseOutput': base, 'hard': hard, 'soft': soft, 'hardReason': reason,
        'target': target_output, 'recordTarget': records,
        'conversationCapacity': ('continuation_reliability_restricted' if recent_length else
            'application_context_bounded' if application_window else
            'continuation_token_budget' if profile.get('successes', 0) > 0 else 'anchor') if sized_window else None,
    }


def _hard_prefix(page, ai, target, profile, target_output, records):
    """Return the largest semantic-unit prefix of one page that fits hard limits."""
    picked, last = [], None
    chars = 0
    for row in page:
        row_chars = len(str(row.get('text') or ''))
        if picked and (len(picked) >= MAX_SOURCE_UNITS or chars + row_chars > MAX_SOURCE_CHARS):
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
    if rows:
        capabilities, proof = _current_capabilities(ai)
        ai = replace(ai, model_capabilities=capabilities)
    else:
        proof = None
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
        if not selected and (len(page) > MAX_SOURCE_UNITS or page_chars > MAX_SOURCE_CHARS):
            selected, last = _hard_prefix(page, ai, target, profile, target_output, records)
            reason = 'hard_application_source_limit_partial_page'
            break
        if selected and (len(selected)+len(page) > MAX_SOURCE_UNITS or chars+page_chars > MAX_SOURCE_CHARS):
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
    last['conversationCapacity'] = last.get('conversationCapacity') or capacity
    last['cacheRatio'] = cache_ratio
    last['cacheConfirmed'] = profile.get('cacheConfirmed') is True
    if proof is not None:
        last['_runtimeContextEvidence'] = proof
    last['_preparedCapabilities'] = ai.model_capabilities
    last.pop('hard', None); last.pop('soft', None); last.pop('hardReason', None)
    return selected, last, reason


def _current_capabilities(ai):
    """Resolve selected account/model facts before READY sizing, not browser numbers."""
    from backend.ai.provider_bootstrap import ensure_provider_registry
    from backend.ai.provider_registry import provider_registry
    from backend.ai.provider_resolution import (
        resolve_provider, resolve_base_url, provider_key_mismatch,
        discovered_model_capabilities, normalize_model_capabilities, is_local_provider,
    )
    from backend.ai.translation.model_resolution import resolve_generation_model
    from backend.security import assert_ai_base_url_allowed
    ensure_provider_registry()
    key = (ai.api_key or '').strip()
    provider = resolve_provider(ai.provider, key)
    if not provider:
        raise ValueError('AI provider must be selected explicitly before Conversation READY')
    mismatch = provider_key_mismatch(provider, key) if key else ''
    if mismatch:
        raise ValueError(f'AI provider/key mismatch: selected {provider}, key belongs to {mismatch}')
    base = resolve_base_url(provider, ai.base_url)
    assert_ai_base_url_allowed(provider, base, user_key=bool(ai.user_key), key_present=bool(key))
    model = resolve_generation_model(provider, ai.model)
    fresh, current = discovered_model_capabilities(provider, base, model, key)
    if provider == 'huggingface':
        from backend.ai.provider_resolution import refresh_hf_selected_metadata
        fresh, current = refresh_hf_selected_metadata(provider, base, model, key)
    capabilities = normalize_model_capabilities(current if fresh else {})
    if not is_local_provider(provider):
        return capabilities, None
    if provider in {'vllm', 'llamacpp', 'koboldcpp'}:
        proof = provider_registry.require(provider).adapter.inspect_runtime_context(
            model=model, base_url=base, api_key=key,
            prior_limits=capabilities.get('limits'))
        # The exact live model/optional native endpoint proves context only;
        # neither Thinking nor vision follows from runtime allocation.
        # A 300-second cached supported:false cannot override a fresh model.
        return {'limits': dict(proof.limits)}, proof
    if provider == 'lmstudio':
        listed = provider_registry.require(provider).adapter.list_models(
            api_key=key, base_url=base)
        if listed.status != 'valid' or model not in listed.models:
            raise WorkloadBudgetError('Selected LM Studio model is unavailable from its live instance list')
        selected = normalize_model_capabilities(listed.capabilities.get(model))
        if not (selected.get('limits') or {}).get('contextTokens'):
            raise WorkloadBudgetError('Selected LM Studio model has no live context allocation or JIT bound')
        return selected, _private_proof(provider, model, base, key, selected)
    if provider == 'ollama':
        from backend.ai.provider_contract import ProbeRequest
        response = provider_registry.require(provider).adapter.probe(ProbeRequest(
            model=model, api_key=key, base_url=base, timeout_sec=3.0,
            model_capabilities={"structured_output": capabilities.get("structured_output")}
            if capabilities.get("structured_output") else {}))
        if not response.ok:
            raise WorkloadBudgetError('Selected Ollama model is unavailable from its live native metadata')
        selected = normalize_model_capabilities(dict(response.capabilities))
        return selected, _private_proof(provider, model, base, key, dict(response.capabilities))
    # Compatible Local endpoints do not publish a standard numeric context.
    # Previous catalogue/browser numbers cannot turn an unknown into a bound.
    capabilities.pop('limits', None)
    return capabilities, None


def learn(profile, result, estimate, missing=0):
    meta = result.get('meta') or {}; u = meta.get('usage') or {}
    ev = meta.get('conversation') or {}
    valid = ev.get('commitStatus') in ('committed','pending_commit','ephemeral_not_retained')
    if valid:
        profile['successes'] = profile.get('successes',0)+1
        if u.get('thinkingTokens') == 0:
            profile['zeroReasoningSamples'] = profile.get('zeroReasoningSamples',0)+1
            if profile['zeroReasoningSamples'] >= 2:
                profile['reasoningSeen'] = False
                profile['reasoning'] = 0
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
        profile['zeroReasoningSamples'] = 0
        profile['reasoning'] = max(profile.get('reasoning',0), math.ceil(u['thinkingTokens']*1.2))
    truncated = meta.get('finish_reason') in ('length','max_tokens')
    profile['outcomes'] = (profile.get('outcomes', []) + [
        'length' if truncated else 'ok' if valid and not missing else 'partial'])[-4:]
    if truncated:
        profile['restricted'] = True
