"""Observe real requests sharing a prefix; never delay or warm a provider.

Leader leases describe local responsibility, not provider cache lifetime. LRU
observations are separate from active leases; eviction cannot cancel a leader.
Only returned usage can establish a cache read, never a lease or a completion.
"""
from __future__ import annotations

from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
import contextvars
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from urllib.parse import urlsplit

from .clients.base import ProviderGenerationCancelled
from .generation_defaults import DEFAULT_GENERATION
from .prompt_cache import cache_policy, enabled

_SCHEMA = 'tp.cache_coordination/1'
_active = contextvars.ContextVar('tp_cache_coordination', default=None)


def _mode(provider, model, endpoint):
    if not enabled() or os.getenv('TP_PROMPT_CACHE_COORDINATION', 'auto').strip().lower() in {'off', '0', 'false'}:
        return 'disabled'
    policy = cache_policy(provider, model, endpoint)
    if policy['strategy'] == 'local_runtime':
        return 'runtime_managed'
    if policy['strategy'] not in {'unknown', 'disabled'}:
        return 'observe_only'
    if provider == 'huggingface' and (urlsplit(endpoint).hostname or '').lower() == 'router.huggingface.co':
        return 'observe_only'
    return 'unsupported'


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=dict)


@dataclass
class _Observation:
    completions: int = 0
    last_hit: bool | None = None
    last_order: int = 0
    observed_at: float | None = None


@dataclass(frozen=True)
class _Leader:
    request_id: str
    deadline: float


class Lease:
    def __init__(self, owner, key, observation, leader, *, mode, role, reason,
                 prefix, target, source, request_id, operation_id, order, reused=False):
        self.owner, self.key, self.observation, self.leader = owner, key, observation, leader
        self.finished = False
        self.data = {
            'schema': _SCHEMA, 'phase': 'admitted', 'mode': mode, 'role': role,
            'reason': reason, 'registryScope': 'api_process', 'groupId': key,
            'coordinationId': request_id, 'leaderCoordinationId': leader.request_id if leader else None,
            'operationId': operation_id or None,
            'staticPrefixSha256': prefix, 'targetLang': target, 'sourceLang': source,
            'waitMs': 0, 'waitLimitMs': 0, 'retentionMs': None,
            'coordinationPolicy': 'observe_no_wait', 'namespaceScope': 'credential_endpoint_model_prefix',
            'providerCacheTtlMs': None, 'leaderLeaseMs': owner.lease_ms,
            'leaderLeaseState': 'active' if leader else 'not_tracked',
            'observationLimit': owner.max_groups, 'activeLeaderLimit': owner.max_active,
            'observationOrder': order, 'previousObservationOrder': observation.last_order if observation else None,
            'observationRecorded': None, 'latestObservationApplied': None,
            'previousObservationAgeMs': (round(max(0, owner.clock() - observation.observed_at) * 1000, 3)
                if observation and observation.observed_at is not None else None),
            # Compatibility names refer to local observations, NOT cache hit/readiness.
            'reusedGroup': reused, 'previousCompletions': observation.completions if observation else 0,
            'previousCacheHit': observation.last_hit if observation else None,
            'providerCacheReady': None, 'cacheStatus': 'not_reported',
            'cachedInputTokens': None, 'requestDispatched': False,
            'terminalCompleted': None, 'releaseReason': None, 'missReason': 'unknown',
        }

    def snapshot(self):
        from backend.diagnostic_schema import sanitize_cache_coordination
        return sanitize_cache_coordination(self.data)

    def dispatched(self):
        if self.data['requestDispatched']:
            return
        self.data.update(phase='dispatch', requestDispatched=True)
        emit(self.snapshot())

    def finish(self, *, complete=False, cached=None, input_tokens=None, reason='provider_terminal'):
        if self.finished:
            return self.snapshot()
        self.finished = True
        reported = type(cached) is int and cached >= 0 and (type(input_tokens) is not int or cached <= input_tokens)
        hit = (cached > 0) if reported else None
        self.data.update(phase='finished', terminalCompleted=complete is True,
                         cacheStatus=('reported_hit' if hit else 'reported_zero') if reported else 'not_reported',
                         cachedInputTokens=cached if reported else None)
        self.owner.finish(self, complete=complete, hit=hit, reason=reason)
        emit(self.snapshot())
        return self.snapshot()


class PrefixCoordinator:
    def __init__(self, *, lease_ms=int(DEFAULT_GENERATION.timeout_sec * 1000),
                 max_groups=1024, max_active=1024, clock=time.monotonic):
        self.lease_ms = max(1, int(lease_ms))
        self.max_groups, self.max_active = max(1, int(max_groups)), max(1, int(max_active))
        self.clock = clock
        self._observations = OrderedDict()
        self._leaders = OrderedDict()
        self._sequence = 0
        self._lock = threading.Lock()
        self._salt = secrets.token_bytes(32)

    def identity(self, *, provider, model, endpoint, account, prefix, target, source,
                 response_schema=None, revision='', thinking='off', has_image=False):
        # Keep private credentials and exact protocol boundaries; this never
        # grants cross-account provider-cache access. No OCR/history is stored.
        parts = [provider, model, endpoint.rstrip('/'), prefix, target, source,
                 response_schema, revision, thinking, bool(has_image)]
        material = str(account).encode() + b'\0' + _json(parts).encode()
        return hmac.new(self._salt, material, hashlib.sha256).hexdigest()

    def acquire(self, *, provider, model, endpoint, account, prefix, target='', source='',
                response_schema=None, revision='', thinking='off', has_image=False,
                mode='observe_only', cancel_check=None, operation_id=''):
        if cancel_check is not None and cancel_check():
            raise ProviderGenerationCancelled('AI generation was cancelled before prefix observation')
        request_id = secrets.token_hex(16)
        valid = isinstance(prefix, str) and re.fullmatch('[a-f0-9]{64}', prefix)
        if not valid:
            mode = 'missing_prefix'
        key = self.identity(provider=provider, model=model, endpoint=endpoint, account=account,
            prefix=prefix, target=target, source=source, response_schema=response_schema,
            revision=revision, thinking=thinking, has_image=has_image) if valid else None
        observation = leader = None
        reused, order = False, 0
        role, reason = 'bypass', mode
        if mode not in {'disabled', 'unsupported', 'missing_prefix'}:
            now = self.clock()
            with self._lock:
                self._sequence += 1
                order = self._sequence
                # Deadlines are insertion ordered, fixed per lease, and not
                # renewed by unrelated requests or cache hits/misses.
                old_leader = self._leaders.get(key)
                expired = old_leader is not None and old_leader.deadline <= now
                while self._leaders and next(iter(self._leaders.values())).deadline <= now:
                    self._leaders.popitem(last=False)
                observation = self._observations.get(key)
                reused = observation is not None
                if observation is None:
                    if len(self._observations) >= self.max_groups:
                        self._observations.popitem(last=False)
                    observation = _Observation()
                    self._observations[key] = observation
                else:
                    self._observations.move_to_end(key)
                leader = self._leaders.get(key)
                if leader:
                    role, reason = 'observer', 'leader_active'
                elif len(self._leaders) < self.max_active:
                    leader = _Leader(request_id, now + self.lease_ms / 1000)
                    self._leaders[key] = leader
                    role = 'leader'
                    reason = 'lease_expired' if expired else 'next_request' if reused else 'new_group'
                else:
                    # Observation pressure never evicts a live leader or blocks
                    # translation. This request still dispatches normally.
                    role, reason = 'observer', 'leader_capacity'
        lease = Lease(self, key, observation, leader, mode=mode, role=role, reason=reason,
            prefix=prefix if valid else None, target=target, source=source,
            request_id=request_id, operation_id=operation_id, order=order, reused=reused)
        try:
            emit(lease.snapshot())
        except BaseException:
            self.finish(lease, complete=False, hit=None, reason='failed')
            raise
        return lease

    def finish(self, lease, *, complete, hit, reason):
        with self._lock:
            data = lease.data
            observation = lease.observation
            current = observation is not None and self._observations.get(lease.key) is observation
            data['observationRecorded'] = bool(current and data['requestDispatched'])
            data['latestObservationApplied'] = False
            if current and data['requestDispatched']:
                if complete:
                    observation.completions += 1
                # Arrival order, not completion order. A slow older response
                # cannot replace a newer observation (even newer 'unknown').
                if data['observationOrder'] >= observation.last_order:
                    observation.last_hit = hit
                    observation.last_order = data['observationOrder']
                    observation.observed_at = self.clock()
                    data['latestObservationApplied'] = True
            if data['role'] != 'leader':
                data['releaseReason'] = 'observation_complete'
                if lease.leader and self._leaders.get(lease.key) is not lease.leader:
                    data['leaderLeaseState'] = 'superseded'
                return
            leader = self._leaders.get(lease.key)
            if leader is not lease.leader:
                data.update(leaderLeaseState='superseded', releaseReason='lease_superseded')
                return
            del self._leaders[lease.key]
            expired = self.clock() >= leader.deadline
            data['leaderLeaseState'] = 'expired' if expired else 'released'
            data['releaseReason'] = ('lease_expired' if expired else 'leader_terminal' if complete
                else 'leader_cancelled' if reason == 'cancelled' else 'leader_failed')


_coordinator = PrefixCoordinator()


def emit(value):
    from backend.diagnostic_schema import sanitize_cache_coordination
    safe = sanitize_cache_coordination(value)
    from . import trace_preview, wire_trace
    trace_preview.note('cacheCoordination', safe)
    wire_trace.write_json('03_cache_coordination.json', safe)


def mark_dispatched():
    lease = _active.get()
    if lease is not None:
        lease.dispatched()


@contextmanager
def coordinate(request, *, operation_id=''):
    context = getattr(request, 'cache_context', {})
    # TP_PROMPT_CACHE_WAIT_MS from 14.7 is deliberately no longer read. There
    # is no event wait, timer, warmup or retry in prefix observation.
    lease = _coordinator.acquire(provider=request.provider, model=request.model,
        endpoint=request.base_url, account=request.api_key,
        prefix=context.get('staticPrefixSha256'), target=context.get('targetLang',''), source=context.get('sourceLang',''),
        response_schema=dict(request.response_schema) if request.response_schema else None,
        revision=str((request.model_capabilities.get('limits') or {}).get('modelRevision','')),
        thinking=request.thinking, has_image=bool(request.image_b64),
        mode=_mode(request.provider, request.model, request.base_url), cancel_check=request.cancel_check, operation_id=operation_id)
    token = _active.set(lease)
    try:
        yield lease
    except BaseException as exc:
        evidence = lease.finish(complete=False, reason='cancelled' if isinstance(exc, ProviderGenerationCancelled) else 'failed')
        try: exc.cacheCoordination = evidence
        except (AttributeError, TypeError): pass
        raise
    finally:
        try:
            if not lease.finished:
                lease.finish(complete=False, reason='failed')
        finally:
            _active.reset(token)
