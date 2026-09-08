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
from pathlib import Path
import sqlite3
import time
import threading
import uuid
from .usage import normalize_usage, finalize_usage

_log = logging.getLogger(__name__)
_schema_lock = threading.Lock()
_active = contextvars.ContextVar('tp_provider_receipt', default=None)
_scope = contextvars.ContextVar('tp_usage_scope', default={})
_receipts = contextvars.ContextVar('tp_usage_receipts', default=None)

from contextlib import contextmanager, closing
from functools import wraps

@contextmanager
def receipt_scope(engine, operation_id=''):
    token = _scope.set({'engine': engine, 'operationId': str(operation_id)[:160]})
    receipt_token = _receipts.set([])
    try: yield
    finally:
        _receipts.reset(receipt_token)
        _scope.reset(token)

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

def _path() -> Path:
    return Path(os.getenv('TP_USAGE_STATE_FILE') or Path(__file__).resolve().parents[2] / 'data' / 'ai-usage.sqlite3')

def _prepare_receipt_store(db) -> None:
    # WAL is persistent. Re-requesting its mode on every concurrent write can
    # race the first connection's journal transition, before a receipt exists.
    # Serialize initialization in-process; other API workers may still start
    # together, so retry ONLY that SQLite metadata transition, never generation.
    with _schema_lock:
        deadline = time.monotonic() + 10
        while True:
            try:
                mode = db.execute('PRAGMA journal_mode').fetchone()[0]
                if str(mode).lower() != 'wal':
                    mode = db.execute('PRAGMA journal_mode=WAL').fetchone()[0]
                if str(mode).lower() != 'wal':
                    raise RuntimeError('AI_USAGE_WAL_UNAVAILABLE')
                break
            except sqlite3.OperationalError as exc:
                code = getattr(exc, 'sqlite_errorcode', 0) & 0xff
                if code not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED) or time.monotonic() >= deadline:
                    raise
                time.sleep(0.01)
        db.execute("""CREATE TABLE IF NOT EXISTS provider_usage (
            receipt_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL,
            updated_ms INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
            endpoint TEXT NOT NULL, phase TEXT NOT NULL, state TEXT NOT NULL,
            usage_json TEXT NOT NULL)""")

def _store(ctx: dict) -> bool:
    if os.getenv('TP_USAGE_RECEIPTS', 'on').lower() == 'off':
        if os.getenv('TP_USAGE_REQUIRED', '0') == '1':
            raise RuntimeError('AI_USAGE_PERSISTENCE_REQUIRED_BUT_DISABLED')
        return False
    try:
        path = _path(); path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(path, timeout=10)) as db, db:
            _prepare_receipt_store(db)
            db.execute('''INSERT INTO provider_usage VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT(receipt_id) DO UPDATE SET updated_ms=excluded.updated_ms,
                state=excluded.state, usage_json=excluded.usage_json''',
                (ctx['receiptId'], ctx['createdMs'], int(time.time()*1000),
                 ctx['provider'], ctx['model'], ctx['endpoint'], ctx['phase'], ctx['state'],
                 json.dumps(ctx['usage'], ensure_ascii=False, allow_nan=False)))
        try: path.chmod(0o600)
        except OSError: pass
        return True
    except Exception as exc:
        _log.error('AI usage receipt persistence failed: %s', type(exc).__name__)
        if os.getenv('TP_USAGE_REQUIRED', '0') == '1':
            raise RuntimeError('AI_USAGE_PERSISTENCE_FAILED') from exc
        return False

def mark_dispatched() -> None:
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
        result = adapter.generate(request)
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
    # Returned flag reflects actual persistence. No raw prompt/key is stored.
    ctx['usage'] = usage
    observations = _receipts.get()
    if observations is not None:
        for i, previous in enumerate(observations):
            if previous.get('receiptId') == usage['receiptId']:
                observations[i] = dict(usage)
                break
        else:
            observations.append(dict(usage))

