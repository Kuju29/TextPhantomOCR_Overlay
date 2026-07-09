"""Proactive per-provider AI request pacing (the "batch gate").

Why this exists
---------------
On a manga page with many images the extension enqueues one AI translation
job per image. Firing them all as fast as the workers drain trips a provider's
*requests-per-minute* limit (e.g. Gemini free tier ~15 RPM) and the provider
returns HTTP 429 — so most images error at once. Reacting with retries only
masks the symptom and wastes tokens.

Instead we pace *proactively*: each provider+model+key gets a token bucket
sized to its RPM. A request must take a token before the provider is called;
when the bucket is empty the request waits just long enough for the bucket to
refill. The first ``burst`` requests fire immediately (the visible "batch"),
the rest drain at the sustainable rate, and no request is ever sent above the
limit — so there is nothing to retry.

Design properties (all requested):
- **Multiple models / providers**: bucket key is ``(provider, model, key)``.
  gemini-2.0-flash and gemini-1.5-pro on the same key get independent budgets,
  because the real limits are per model/key.
- **Multi-user**: buckets are per API key (the limit lives on the key). Users
  who share one key share one bucket *fairly* — waiters are dispatched
  round-robin across tab sessions, so one user's 50-page dump cannot starve
  another user's 2 pages.
- **Cancellation**: a waiting request can be cancelled (tab closed / batch
  cancelled) without ever consuming a token.
- **Dynamic, bounded wait (anti-bloat)**: fast path has zero added latency; a
  request that cannot get a token within ``deadline_sec`` is skipped fast
  (``RateGateTimeout``); once a bucket already has ``max_waiters`` queued,
  new requests are rejected immediately (``RateGateRejected``) so memory and
  latency stay bounded instead of the queue swelling without end.

The gate lives at the async worker level (before the blocking pipeline runs in
a thread), so waiting is cheap and does not pin a worker thread.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
from collections import OrderedDict, deque

from backend.ai import config as ai_config
from backend.ai.providers import canonical_provider, is_local_provider, resolve_model
from backend.config import settings


class RateGateError(Exception):
    """Base class for gate refusals (never raised for a normal grant)."""


class RateGateTimeout(RateGateError):
    """The request could not get a token within its deadline — skip it."""


class RateGateRejected(RateGateError):
    """The bucket already has too many waiters — shed load immediately."""


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


class _Waiter:
    __slots__ = ("job_id", "session", "future")

    def __init__(self, job_id: str, session: str, future: "asyncio.Future[bool]") -> None:
        self.job_id = job_id
        self.session = session
        self.future = future


class _Bucket:
    """A single token bucket with per-session fair queues."""

    __slots__ = ("capacity", "tokens", "rate", "last", "sessions", "jobset", "timer")

    def __init__(self, capacity: int, rate_per_sec: float) -> None:
        self.capacity = float(max(1, capacity))
        self.tokens = float(max(1, capacity))  # start full so the first burst is instant
        self.rate = float(max(0.0, rate_per_sec))
        self.last = time.monotonic()
        # session -> FIFO deque of job_ids waiting; OrderedDict gives round-robin.
        self.sessions: "OrderedDict[str, deque[str]]" = OrderedDict()
        # every job_id currently waiting in this bucket (admission counting).
        self.jobset: set[str] = set()
        self.timer: asyncio.TimerHandle | None = None

    def refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self.last
        if elapsed > 0:
            if self.rate > 0:
                self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
            self.last = now


class RateGate:
    """Process-wide singleton coordinating all AI provider pacing."""

    def __init__(self) -> None:
        self._buckets: dict[str, _Bucket] = {}
        # job_id -> _Waiter, for O(1) cancellation by job id.
        self._waiters: dict[str, _Waiter] = {}

    # --- policy ------------------------------------------------------------
    @staticmethod
    def enabled() -> bool:
        return bool(getattr(settings, "rate_gate_enabled", True))

    @staticmethod
    def _policy(provider: str) -> tuple[float, int]:
        """Return ``(rpm, burst)`` for a canonical provider, env-overridable."""
        dflt = ai_config.RATE_POLICY_DEFAULTS.get(provider, {})
        rpm = _env_float(
            f"TP_RATE_RPM_{provider.upper()}",
            float(dflt.get("rpm", settings.rate_default_rpm)),
        )
        burst = _env_int(
            f"TP_RATE_BURST_{provider.upper()}",
            int(dflt.get("burst", settings.rate_default_burst)),
        )
        return max(0.0, rpm), max(1, burst)

    @staticmethod
    def _gated(provider: str) -> bool:
        """Local servers have no limit; Hugging Face has its own throttle."""
        return not (is_local_provider(provider) or provider == "huggingface")

    @staticmethod
    def _bucket_key(provider: str, model: str, api_key: str) -> str:
        kf = hashlib.sha1((api_key or "").encode("utf-8")).hexdigest()[:12]
        resolved = (resolve_model(provider, model) or "auto").strip().lower()
        return f"{provider}|{resolved}|{kf}"

    # --- public API --------------------------------------------------------
    async def acquire(
        self,
        provider: str,
        model: str,
        api_key: str,
        *,
        session: str,
        job_id: str,
        deadline_sec: float,
        max_waiters: int,
    ) -> None:
        """Block until this request may call the provider.

        Returns ``None`` on success. Raises :class:`RateGateTimeout` if the
        deadline elapses first, :class:`RateGateRejected` if the bucket is
        already saturated, or :class:`asyncio.CancelledError` if the waiter is
        cancelled (never consuming a token in any of those cases).
        """
        provider = canonical_provider(provider or "auto")
        if not self.enabled() or not self._gated(provider):
            return
        rpm, burst = self._policy(provider)
        if rpm <= 0:
            return  # gate disabled for this provider via config

        key = self._bucket_key(provider, model, api_key)
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = _Bucket(burst, rpm / 60.0)
            self._buckets[key] = bucket

        bucket.refill()

        # Fast path: nobody waiting and a token is ready -> go immediately.
        if not bucket.jobset and bucket.tokens >= 1.0:
            bucket.tokens -= 1.0
            return

        # Anti-bloat: refuse to grow an already-saturated bucket.
        if len(bucket.jobset) >= max(1, max_waiters):
            raise RateGateRejected(
                f"rate bucket saturated ({len(bucket.jobset)} waiting) for {provider}"
            )

        loop = asyncio.get_event_loop()
        future: "asyncio.Future[bool]" = loop.create_future()
        waiter = _Waiter(job_id, session or "", future)

        dq = bucket.sessions.get(waiter.session)
        if dq is None:
            dq = deque()
            bucket.sessions[waiter.session] = dq
        dq.append(job_id)
        bucket.jobset.add(job_id)
        self._waiters[job_id] = waiter

        self._pump(bucket)  # may grant right away if a token is free

        try:
            await asyncio.wait_for(future, timeout=max(0.1, deadline_sec))
        except asyncio.TimeoutError as exc:
            self._drop(bucket, job_id)
            raise RateGateTimeout(
                f"waited {deadline_sec:.0f}s without a slot for {provider}"
            ) from exc
        except asyncio.CancelledError:
            # Either the caller's task was cancelled or cancel_jobs() cancelled
            # our future — release our place and consume no token.
            self._drop(bucket, job_id)
            raise
        finally:
            self._waiters.pop(job_id, None)

    def cancel_jobs(self, job_ids) -> int:
        """Cancel any waiting acquire() for these job ids. Returns count hit."""
        hit = 0
        for jid in list(job_ids or []):
            waiter = self._waiters.get(str(jid))
            if waiter and not waiter.future.done():
                waiter.future.cancel()
                hit += 1
        return hit

    def cancel_session(self, session: str) -> int:
        session = str(session or "")
        ids = [w.job_id for w in self._waiters.values() if w.session == session]
        return self.cancel_jobs(ids)

    def stats(self) -> dict:
        return {
            "buckets": len(self._buckets),
            "waiting": len(self._waiters),
        }

    # --- internals ---------------------------------------------------------
    def _next_session(self, bucket: _Bucket) -> str | None:
        """Pick the next session round-robin and rotate it to the back."""
        if not bucket.sessions:
            return None
        session = next(iter(bucket.sessions))
        bucket.sessions.move_to_end(session)
        return session

    def _pump(self, bucket: _Bucket) -> None:
        """Grant tokens to waiting jobs while tokens are available."""
        bucket.refill()
        # Guard against endless loops: at most one pass per waiting job.
        guard = len(bucket.jobset) + 1
        while guard > 0 and bucket.tokens >= 1.0 and bucket.sessions:
            guard -= 1
            session = self._next_session(bucket)
            if session is None:
                break
            dq = bucket.sessions.get(session)
            if not dq:
                bucket.sessions.pop(session, None)
                continue
            job_id = dq.popleft()
            if not dq:
                bucket.sessions.pop(session, None)

            waiter = self._waiters.get(job_id)
            bucket.jobset.discard(job_id)
            if waiter is None or waiter.future.done():
                # Already cancelled/timed out between enqueue and now: skip,
                # do NOT spend a token on it.
                continue
            bucket.tokens -= 1.0
            waiter.future.set_result(True)

        # If jobs still wait but no token is ready, wake up when one refills.
        if bucket.sessions and bucket.tokens < 1.0:
            self._schedule_pump(bucket)

    def _schedule_pump(self, bucket: _Bucket) -> None:
        if bucket.timer is not None or bucket.rate <= 0:
            return
        need = 1.0 - bucket.tokens
        delay = max(0.02, need / bucket.rate)
        loop = asyncio.get_event_loop()

        def _fire() -> None:
            bucket.timer = None
            self._pump(bucket)

        bucket.timer = loop.call_later(delay, _fire)

    def _drop(self, bucket: _Bucket, job_id: str) -> None:
        """Remove a waiter that timed out / was cancelled. Idempotent."""
        self._waiters.pop(job_id, None)
        if job_id in bucket.jobset:
            bucket.jobset.discard(job_id)
            for session, dq in list(bucket.sessions.items()):
                try:
                    dq.remove(job_id)
                except ValueError:
                    continue
                if not dq:
                    bucket.sessions.pop(session, None)
                break


# Process-wide singleton.
rate_gate = RateGate()
