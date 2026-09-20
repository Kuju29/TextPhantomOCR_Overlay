"""Server-owned, per-generation usage receipts, independent of browser delivery.

Not a wallet. Unauthenticated browser counters and Local diagnostic relays are
never accepted here. One adapter invocation gets one server receipt; observed
stream usage replaces the snapshot, it is never summed across SSE frames.
"""
from __future__ import annotations
import contextvars
import json
import logging
import os
from collections import OrderedDict
import time
import threading
import uuid
from .usage import normalize_usage, finalize_usage

_log = logging.getLogger(__name__)
_schema_lock = threading.Lock()
_active = contextvars.ContextVar('tp_provider_receipt', default=None)
_scope = contextvars.ContextVar('tp_usage_scope', default={})
_receipts = contextvars.ContextVar('tp_usage_receipts', default=None)

from contextlib import contextmanager
from functools import wraps

@contextmanager
def receipt_scope(engine, operation_id=''):
    token = _scope.set({'engine': engine, 'operationId': str(operation_id)[:160]})
    receipt_token = _receipts.set([])
    try: yield
    finally:
        _receipts.reset(receipt_token)
        _scope.reset(token)

def adopt_receipt_references(usage: dict) -> None:
    """Attach internal shared-batch receipts to the caller's error scope only.

    No new receipt/write/charge. A later renderer failure must not hide the
    already observed request merely because another thread dispatched it.
    """
    observations = _receipts.get()
    if observations is None or not isinstance(usage, dict):
        return
    seen = {r.get('receiptId') for r in observations}
    for row in usage.get('generations') or [usage]:
        identity = row.get('receiptId')
        if identity and identity not in seen and row.get('accountingOrigin') == 'server_provider_boundary':
            observations.append(dict(row)); seen.add(identity)

def api_pipeline_scope(fn):
    @wraps(fn)
    def run(payload, *args, **kwargs):
        with receipt_scope('runsapi', payload.get('idempotency_key', '')):
            try:
                return fn(payload, *args, **kwargs)
            except Exception as exc:
                observations = _receipts.get() or []
                if observations:
                    from .usage import aggregate_usage
                    detail = dict(getattr(exc, 'structural_details', {}) or {})
                    meta = dict(detail.get('generationMeta') or {})
                    meta.pop('accumulatedUsage', None)
                    detail.pop('accumulatedUsage', None)
                    meta['usage'] = aggregate_usage(observations) if len(observations) > 1 else observations[0]
                    meta['generationAttempts'] = len(observations)
                    detail['generationMeta'] = meta
                    detail['generationAttempts'] = len(observations)
                    exc.structural_details = detail
                    exc.generationMeta = meta
                    exc.generationAttempts = len(observations)
                    exc.requestDispatched = True
                raise
    return run

MAX_RECEIPTS = 1024
MAX_RECEIPT_BYTES = 128 * 1024
MAX_RECEIPT_CACHE_BYTES = 8 * 1024 * 1024
_receipt_cache = OrderedDict()
_receipt_bytes = 0

def _store(ctx: dict) -> bool:
    """Keep a bounded diagnostic snapshot; never claim disk durability.

    Legacy TP_USAGE_STATE_FILE never enables persistent state. TP_USAGE_REQUIRED
    requires an in-process receipt, not restart durability.
    Accounting returned to the caller remains authoritative if this cache drops
    a large/old entry or is disabled.
    """
    global _receipt_bytes
    if os.getenv('TP_USAGE_RECEIPTS', 'on').lower() == 'off':
        if os.getenv('TP_USAGE_REQUIRED', '0') == '1':
            raise RuntimeError('AI_USAGE_RECEIPT_REQUIRED_BUT_DISABLED')
        return False
    try:
        encoded = json.dumps(ctx['usage'], ensure_ascii=False, allow_nan=False)
    except (ValueError, TypeError):
        if os.getenv('TP_USAGE_REQUIRED', '0') == '1' and not ctx.get('dispatched'):
            raise RuntimeError('AI_USAGE_RECEIPT_INVALID')
        return False  # Optional diagnostics never hide a billed answer.
    size = len(encoded.encode())
    if size > MAX_RECEIPT_BYTES:
        if os.getenv('TP_USAGE_REQUIRED', '0') == '1' and not ctx.get('dispatched'):
            raise RuntimeError('AI_USAGE_RECEIPT_SIZE_LIMIT')
        return False
    with _schema_lock:
        previous = _receipt_cache.pop(ctx['receiptId'], None)
        if previous is not None:
            _receipt_bytes -= len(previous.encode())
        while _receipt_cache and (len(_receipt_cache) >= MAX_RECEIPTS or
                _receipt_bytes + size > MAX_RECEIPT_CACHE_BYTES):
            _, old = _receipt_cache.popitem(last=False)
            _receipt_bytes -= len(old.encode())
        _receipt_cache[ctx['receiptId']] = encoded
        _receipt_bytes += size
    return False

def diagnostic_identity() -> dict:
    """Read the current generation identity without changing receipt ownership."""
    current = _active.get() or _scope.get() or {}
    return {key: current.get(key, "") for key in ("operationId", "receiptId")}

def mark_dispatched() -> None:
    from .cache_coordination import mark_dispatched as mark_cache_dispatch
    mark_cache_dispatch()
    ctx = _active.get()
    if ctx is None or ctx.get('dispatched'):
        return
    ctx['state'] = 'dispatch_intent_usage_pending'
    ctx['usage'] = {'receiptId': ctx['receiptId'], 'engine': ctx.get('engine', 'standalone'),
                    'operationId': ctx.get('operationId', ''), 'usageStatus': 'unavailable',
                    'customerChargeStatus': 'not_assessed', 'billingEligible': False}
    ctx['durable'] = _store(ctx)
    ctx['dispatched'] = True

def observe(raw, dialect='openai', *, complete=False, cost_authoritative=False,
            response_id='', http_status=None) -> dict:
    usage = normalize_usage(raw, dialect, complete=complete,
                            cost_authoritative=cost_authoritative, response_id=response_id)
    ctx = _active.get()
    if ctx is not None:
        # Immutable provider snapshots: merge present fields, never add frames.
        previous = ctx.get('usage') or {}
        for k, v in previous.items():
            if usage.get(k) is None and v is not None:
                usage[k] = v
        usage = finalize_usage(usage, complete=complete)
        if http_status is not None: usage['httpStatus'] = http_status
        ctx['usage'] = usage
        ctx['responseComplete'] = complete
    return usage

def generate_with_receipt(adapter, request, *, phase='initial'):
    from .clients.base import usage_meta
    from urllib.parse import urlsplit
    u = urlsplit(request.base_url)
    endpoint = f'{u.scheme}://{u.hostname or ""}' + (f':{u.port}' if u.port else '')
    if str(_scope.get().get('operationId', '')).startswith('repair:'):
        phase = 'repair'
    ctx = {'receiptId': uuid.uuid4().hex, 'createdMs': int(time.time()*1000),
           'provider': request.provider, 'model': request.model, 'endpoint': endpoint,
           'phase': phase, 'state': 'prepared', 'dispatched': False,
           'usage': {}, 'responseComplete': False, 'durable': False, **dict(_scope.get())}
    token = _active.set(ctx)
    try:
        from .cache_coordination import coordinate
        with coordinate(request, operation_id=ctx.get("operationId", "")) as cache_lease:
            result = adapter.generate(request)
            observed = result.usage_details or usage_meta(result)
            cache_evidence = cache_lease.finish(
                complete=result.terminal_completed is True,
                cached=observed.get("cachedInputTokens"), input_tokens=observed.get("inputTokens"))
            result = result._replace(cache_coordination=cache_evidence)
        if not ctx['dispatched']:
            # Custom/mock adapter without an actual transport hook is not an
            # authoritative paid receipt. Do not invent a network dispatch.
            return result
        normalized = result.usage_details or finalize_usage(usage_meta(result),
                           complete=result.terminal_completed is True)
        if result.cache_policy is not None: normalized['cachePolicy'] = result.cache_policy
        if 'cachePolicy' not in normalized:
            from .prompt_cache import cache_policy
            normalized['cachePolicy'] = cache_policy(request.provider, request.model, request.base_url)
        normalized['provider'] = request.provider
        normalized['model'] = result.used_model
        ctx['usage'] = normalized
        ctx['state'] = 'provider_complete' if normalized.get('usageStatus') == 'reported' else 'usage_pending_review'
        _finish(ctx)
        return result._replace(usage_details=dict(ctx['usage']))
    except Exception as exc:
        if ctx['dispatched']:
            ctx['state'] = ('provider_response_error' if ctx['responseComplete'] else 'interrupted_usage_pending')
            _finish(ctx)
            info = dict(ctx['usage'])
            detail = getattr(exc, 'structural_details', None)
            if not isinstance(detail, dict): detail = {}
            gen = dict(detail.get('generationMeta') or getattr(exc, 'generationMeta', None) or {})
            gen['usage'] = info
            if getattr(exc, 'cacheCoordination', None): gen['cacheCoordination'] = exc.cacheCoordination
            detail['generationMeta'] = gen
            detail.setdefault('generationAttempts', 1)
            try:
                exc.structural_details = detail
                exc.generationMeta = gen
                exc.generationAttempts = 1
                exc.requestDispatched = True
            except (AttributeError, TypeError): pass
        raise
    finally:
        _active.reset(token)

def _finish(ctx: dict) -> None:
    usage = dict(ctx['usage'])
    usage.update(receiptId=ctx['receiptId'], accountingOrigin='server_provider_boundary',
                 phase=ctx['phase'], receiptStatus=ctx['state'],
                 engine=ctx.get('engine', 'standalone'), operationId=ctx.get('operationId',''),
                 provider=ctx['provider'], model=usage.get('model') or ctx['model'],
                 requestedModel=ctx['model'],
                 customerChargeStatus='not_assessed')
    # Server receipt proves observation, NOT authorization to debit a customer.
    usage['billingEligible'] = False
    ctx['usage'] = usage
    ctx['durable'] = _store(ctx)
    usage['receiptDurable'] = ctx['durable']
    # In-process receipts are not durable. No raw prompt/key is stored.
    ctx['usage'] = usage
    observations = _receipts.get()
    if observations is not None:
        for i, previous in enumerate(observations):
            if previous.get('receiptId') == usage['receiptId']:
                observations[i] = dict(usage)
                break
        else:
            observations.append(dict(usage))

