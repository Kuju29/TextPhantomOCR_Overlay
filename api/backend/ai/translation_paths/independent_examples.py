"""Private, bounded accepted examples for one Local Independent API run.

RAM only: restart begins with human examples. No assistant history is retained.
Reservations wait outside AI admission and commit only on successful scope exit.
"""
from contextlib import contextmanager, asynccontextmanager
from contextvars import ContextVar
from collections import OrderedDict, deque
import asyncio
import hashlib
import hmac
import json
import secrets
import threading
import time

from backend.ai.prompts.independent_examples import bounded_pairs, suitable, select_pairs
from backend.ai.provider_resolution import is_local_provider
from backend.lens.languages import normalize
from backend.ai.clients.base import ProviderGenerationCancelled

MAX_SCOPES = 128
MAX_WAITERS_PER_SCOPE = 128
MAX_AGE_SECONDS = 30 * 86400
WAIT_SECONDS = 600
_current = ContextVar('tp_independent_examples_lease', default=None)


def descriptor(context=None, metadata=None, document=''):
    context = context if isinstance(context, dict) else {}
    metadata = metadata if isinstance(metadata, dict) else {}
    values = [context.get('tp_tab_session'), context.get('batch_id') or metadata.get('batch_id'),
              context.get('page_url') or document]
    # Anonymous/shared credentials are never substituted for a tab/run owner.
    if any(not isinstance(v, str) or not v.strip() or len(v) > 4096 for v in values):
        return {}
    return dict(zip(('owner', 'batch', 'document'),
        (hashlib.sha256(v.strip().encode()).hexdigest() for v in values)))


def enabled(ai):
    return bool(ai and ai.translation_mode == 'independent' and ai.style_examples is True
                and is_local_provider(str(ai.provider).lower()))


def _cancel(check, lease=None):
    if callable(check) and check():
        error = ProviderGenerationCancelled('Translation cancelled while waiting for Independent examples')
        result = (lease or {}).get('result')
        meta = (result or {}).get('meta') or {}
        error.preDispatchCancelled = not bool(result)
        error.requestDispatched = bool(result)
        if result:
            error.generationMeta = {k: meta[k] for k in ('provider', 'model', 'usage',
                'generationAttempts', 'providerAttempts', 'generation_attempts', 'provider_attempts') if k in meta}
        raise error


class Store:
    def __init__(self):
        self.secret = secrets.token_bytes(32)
        self.condition = threading.Condition(threading.RLock())
        self.rows = OrderedDict()
        self.revision = 0

    def key(self, ai, target):
        scope = ai.independent_scope
        # Auto can resolve to a different installed model between requests.
        if not enabled(ai) or not all(scope.get(k) for k in ('owner', 'batch', 'document')) or str(ai.model).lower() in ('', 'auto'):
            return ''
        material = [scope, ai.provider, ai.model, ai.base_url, ai.api_key,
                    ai.prompt_editable, ai.prompt_mode, normalize(target),
                    ai.thinking, ai.output_contract]
        return hmac.new(self.secret, json.dumps(material, sort_keys=True).encode(), hashlib.sha256).hexdigest()

    def register(self, key):
        ticket = object()
        with self.condition:
            now = time.monotonic()
            for k, row in list(self.rows.items()):
                if not row['queue'] and now - row['updated'] > MAX_AGE_SECONDS:
                    del self.rows[k]
            if key not in self.rows:
                while len(self.rows) >= MAX_SCOPES:
                    idle = next((k for k, r in self.rows.items() if not r['queue']), None)
                    if idle is None:
                        from .store import ConversationError
                        error = ConversationError('Independent example capacity is busy; no provider request was sent')
                        error.code = 'ai_independent_examples_capacity'
                        raise error
                    del self.rows[idle]
                self.revision += 1
                self.rows[key] = {'pairs': [], 'queue': deque(), 'updated': now, 'revision': self.revision}
            self.rows.move_to_end(key)
            if len(self.rows[key]['queue']) >= MAX_WAITERS_PER_SCOPE:
                from .store import ConversationError
                error = ConversationError('Independent example queue is full; no provider request was sent')
                error.code = 'ai_independent_examples_capacity'
                raise error
            self.rows[key]['queue'].append(ticket)
        return ticket

    def ready(self, key, ticket):
        with self.condition:
            return self.rows[key]['queue'][0] is ticket

    def release(self, key, ticket, pairs, ok):
        with self.condition:
            row = self.rows[key]
            if ok and pairs:
                updated = bounded_pairs([*row['pairs'], *pairs])
                if updated != row['pairs']:
                    self.revision += 1
                    row['revision'] = self.revision
                    row['pairs'] = updated
            row['updated'] = time.monotonic()
            row['queue'].remove(ticket)
            self.condition.notify_all()

    def pairs(self, key):
        with self.condition:
            row = self.rows.get(key)
            if not row or (not row['queue'] and time.monotonic() - row['updated'] > MAX_AGE_SECONDS):
                return []
            return [dict(p) for p in row['pairs']]

    def clear(self):
        with self.condition:
            if any(r['queue'] for r in self.rows.values()):
                raise RuntimeError('Cannot reset active Independent examples')
            self.rows.clear()

    def snapshot(self, key):
        with self.condition:
            row = self.rows.get(key)
            if row and not row['queue'] and time.monotonic() - row['updated'] > MAX_AGE_SECONDS:
                row = None
            # A monotonic revision prevents A→B→A cache-context races. The pool
            # itself is private; neither story text nor owner enters the key.
            signature = hashlib.sha256(json.dumps([key, row['revision'] if row else 0]).encode()).hexdigest()
            return {'signature': signature, 'busy': bool(row and row['queue'])}


store = Store()


def selection(ai, target, current_source):
    if not enabled(ai):
        return {'source': 'none', 'pairs': [], 'scopeStatus': 'disabled', 'acceptedPairs': 0}
    key = store.key(ai, target)
    pairs = [p for p in store.pairs(key) if suitable(p['tgt'], normalize(target))] if key else []
    return {'source': 'story' if pairs else 'human' if normalize(target) in ('en', 'ja', 'th') else 'none',
            'pairs': select_pairs(pairs, current_source, normalize(target)), 'acceptedPairs': len(pairs),
            'scopeStatus': 'private_run' if key else 'unscoped', 'humanExampleCount': 4}


def cache_signature(ai, target):
    return cache_snapshot(ai, target)['signature']


def cache_snapshot(ai, target):
    if not enabled(ai): return {'signature': '', 'busy': False}
    return store.snapshot(store.key(ai, target))


def stage_result(ai, target, source, result):
    lease = _current.get()
    if not lease or lease['key'] != store.key(ai, target) or not enabled(ai): return
    lease['result'] = result
    from backend.ai import markers
    ids = markers.expected_ids(source)
    sources = markers.extract_paragraphs_exact(source, len(ids))
    targets = markers.extract_paragraphs_exact(result.get('aiTextFull', ''), len(ids))
    meta = result.get('meta') or {}
    if not sources or not targets or meta.get('skipped') or meta.get('malformed_output_record_count', 0): return
    rejected = set(meta.get('omitted_ids', [])) | set(meta.get('alignment_uncertain_ids', [])) | set(meta.get('duplicate_output_ids', []))
    # Unexpected IDs make a repair's mapping ambiguous, even if rows parsed.
    if meta.get('ignored_output_ids') or meta.get('unexpected_prose_chars', 0): return
    lease['pairs'].extend(bounded_pairs([{'src': src, 'tgt': tgt}
        for uid, src, tgt in zip(ids, sources[0], targets[0])
        if uid not in rejected and suitable(tgt, normalize(target))]))


def _timeout(started):
    if time.monotonic() - started > WAIT_SECONDS:
        from .store import ConversationError
        error = ConversationError('Timed out waiting for Independent examples; no provider request was sent')
        error.code = 'ai_independent_examples_wait_timeout'
        raise error


@contextmanager
def execution_scope(ai, target, cancel_check=None):
    key = store.key(ai, target) if enabled(ai) else ''
    current = _current.get()
    if not key or current and current['key'] == key:
        yield current
        return
    ticket, started = store.register(key), time.monotonic()
    ok, marker, lease = False, None, {'key': key, 'pairs': []}
    try:
        with store.condition:
            while not store.ready(key, ticket):
                _cancel(cancel_check); _timeout(started); store.condition.wait(0.1)
        _cancel(cancel_check, lease)
        marker = _current.set(lease)
        yield lease
        _cancel(cancel_check, lease)
        ok = True
    finally:
        if marker is not None: _current.reset(marker)
        store.release(key, ticket, lease['pairs'], ok)


@asynccontextmanager
async def async_execution_scope(ai, target, cancel_check=None):
    key = store.key(ai, target) if enabled(ai) else ''
    current = _current.get()
    if not key or current and current['key'] == key:
        yield current
        return
    ticket, started = store.register(key), time.monotonic()
    ok, marker, lease = False, None, {'key': key, 'pairs': []}
    try:
        while not store.ready(key, ticket):
            _cancel(cancel_check); _timeout(started); await asyncio.sleep(0.05)
        _cancel(cancel_check, lease)
        marker = _current.set(lease)
        yield lease
        _cancel(cancel_check, lease)
        ok = True
    finally:
        if marker is not None: _current.reset(marker)
        store.release(key, ticket, lease['pairs'], ok)
