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


# Upper bound on how many distinct (provider, model, key) buckets we keep. Each
# bucket is tiny, but on a multi-user server the set of API keys is unbounded,
# so idle buckets are pruned to keep memory flat. Only IDLE buckets (no waiters
# and no pending refill timer) are ever evicted; an evicted bucket simply starts
# full again next time, which is the correct state for one that was quiet.
_MAX_BUCKETS = _env_int("TP_RATE_MAX_BUCKETS", 512)


class _Waiter:
    __slots__ = ("job_id", "session", "future")

    def __init__(self, job_id: str, session: str, future: "asyncio.Future[bool]") -> None:
        self.job_id = job_id
        self.session = session
        self.future = future


class _Bucket:
    """A single token bucket with per-session fair queues."""

    __slots__ = (
        "capacity", "tokens", "rate", "last", "sessions", "jobset", "timer",
        "rpm", "rpm_start", "rpm_min", "rpm_max", "pinned", "ok_streak", "touched",
    )

    def __init__(self, capacity: int, rate_per_sec: float) -> None:
        self.capacity = float(max(1, capacity))
        self.tokens = float(max(1, capacity))  # start full so the first burst is instant
        self.rate = float(max(0.0, rate_per_sec))
        self.last = time.monotonic()
        self.rpm = self.rate * 60.0
        self.rpm_start = self.rpm
        self.rpm_min = self.rpm
        self.rpm_max = self.rpm
        self.pinned = False
        self.ok_streak = 0
        self.touched = self.last
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

    # Moves the sustained rate without losing the tokens already earned.
    def set_rpm(self, rpm: float) -> None:
        self.refill()
        self.rpm = max(0.0, float(rpm))
        self.rate = self.rpm / 60.0

    def set_capacity(self, burst: int) -> None:
        self.capacity = float(max(1, burst))
        self.tokens = min(self.tokens, self.capacity)


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
    def _policy(provider: str) -> tuple[float, int, float, float]:
        """Return ``(start_rpm, burst, rpm_min, rpm_max)``, env-overridable."""
        dflt = ai_config.RATE_POLICY_DEFAULTS.get(provider, {})
        rpm = _env_float(
            f"TP_RATE_RPM_{provider.upper()}",
            float(dflt.get("rpm", settings.rate_default_rpm)),
        )
        burst = _env_int(
            f"TP_RATE_BURST_{provider.upper()}",
            int(dflt.get("burst", settings.rate_default_burst)),
        )
        rpm_min = _env_float(
            f"TP_RATE_RPM_MIN_{provider.upper()}", float(dflt.get("rpm_min", rpm))
        )
        rpm_max = _env_float(
            f"TP_RATE_RPM_MAX_{provider.upper()}", float(dflt.get("rpm_max", rpm))
        )
        rpm = max(0.0, rpm)
        return rpm, max(1, burst), max(0.0, min(rpm_min, rpm)), max(rpm, rpm_max)

    @staticmethod
    def adaptive_enabled() -> bool:
        return _env_int("TP_RATE_ADAPTIVE", 1) != 0

    @staticmethod
    def _gated(provider: str) -> bool:
        """Local servers have no limit; Hugging Face has its own throttle."""
        return not (is_local_provider(provider) or provider == "huggingface")

    # Identity of one quota: provider + resolved model + API key. The rate is NOT
    # part of the key, because the bucket's rate now moves at runtime — one key
    # keeps one bucket and one learned rate for as long as it stays warm.
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
        rpm_override: float | None = None,
        burst_override: int | None = None,
    ) -> None:
        """Block until this request may call the provider.

        Returns ``None`` on success. Raises :class:`RateGateTimeout` if the
        deadline elapses first, :class:`RateGateRejected` if the bucket is
        already saturated, or :class:`asyncio.CancelledError` if the waiter is
        cancelled (never consuming a token in any of those cases).

        ``rpm_override`` / ``burst_override`` come from the user's own rate
        settings in the extension. They replace the built-in per-provider policy
        for this request, because only the user knows whether their key is on a
        free tier or a paid one. Values <= 0 are ignored (treated as "not set")
        rather than being read as "no requests allowed".
        """
        provider = canonical_provider(provider or "auto")
        if not self.enabled() or not self._gated(provider):
            return
        start_rpm, burst, rpm_min, rpm_max = self._policy(provider)
        pinned = rpm_override is not None and float(rpm_override) > 0
        if pinned:
            start_rpm = float(rpm_override)
            rpm_min = rpm_max = start_rpm
        if burst_override is not None and int(burst_override) > 0:
            burst = int(burst_override)
        if start_rpm <= 0:
            return  # gate disabled for this provider via config

        bucket = self._bucket_for(
            provider, model, api_key,
            start_rpm=start_rpm, burst=burst,
            rpm_min=rpm_min, rpm_max=rpm_max, pinned=pinned,
        )
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

    # Returns this quota's bucket, creating it or re-shaping it when the user's
    # pinned rate changed. One (provider, model, key) keeps one learned rate.
    def _bucket_for(
        self,
        provider: str,
        model: str,
        api_key: str,
        *,
        start_rpm: float,
        burst: int,
        rpm_min: float,
        rpm_max: float,
        pinned: bool,
    ) -> "_Bucket":
        key = self._bucket_key(provider, model, api_key)
        bucket = self._buckets.get(key)
        now = time.monotonic()
        if bucket is not None and (now - bucket.touched) > ai_config.RATE_ADAPT_IDLE_RESET_SEC:
            # A quota that has been quiet for this long is no longer evidence.
            bucket.set_rpm(start_rpm)
            bucket.ok_streak = 0
        if bucket is None:
            self._prune_buckets()
            bucket = _Bucket(burst, start_rpm / 60.0)
            self._buckets[key] = bucket
        bucket.touched = now
        bucket.rpm_start = start_rpm
        bucket.rpm_min = rpm_min
        bucket.rpm_max = rpm_max
        bucket.set_capacity(burst)
        if pinned != bucket.pinned:
            # The user just pinned or un-pinned a number; honour it immediately.
            bucket.pinned = pinned
            bucket.set_rpm(start_rpm)
            bucket.ok_streak = 0
        elif pinned and abs(bucket.rpm - start_rpm) > 1e-9:
            bucket.set_rpm(start_rpm)
        elif not pinned:
            bucket.set_rpm(min(max(bucket.rpm, rpm_min), rpm_max))
        return bucket

    def _lookup(self, provider: str, model: str, api_key: str) -> "_Bucket | None":
        provider = canonical_provider(provider or "auto")
        return self._buckets.get(self._bucket_key(provider, model, api_key))

    # One clean provider call. After a streak of them the sustained rate climbs
    # by a step, so a paid key stops being paced at the free tier's number.
    def report_success(self, provider: str, model: str, api_key: str) -> None:
        bucket = self._lookup(provider, model, api_key)
        if bucket is None or bucket.pinned or not self.adaptive_enabled():
            return
        bucket.ok_streak += 1
        if bucket.ok_streak < ai_config.RATE_ADAPT_OK_STREAK:
            return
        bucket.ok_streak = 0
        if bucket.rpm < bucket.rpm_max:
            bucket.set_rpm(min(bucket.rpm_max, bucket.rpm + ai_config.RATE_ADAPT_STEP_RPM))

    # The provider itself said no. Halve the sustained rate immediately and, when
    # it told us how long to wait, spend that time before handing out a token.
    def report_rate_limited(
        self, provider: str, model: str, api_key: str, *, retry_after_sec: float = 0.0
    ) -> None:
        bucket = self._lookup(provider, model, api_key)
        if bucket is None:
            return
        bucket.ok_streak = 0
        if not bucket.pinned and self.adaptive_enabled():
            bucket.set_rpm(max(bucket.rpm_min, bucket.rpm * ai_config.RATE_ADAPT_BACKOFF))
        wait = max(0.0, float(retry_after_sec))
        if wait > 0:
            bucket.refill()
            bucket.tokens = min(bucket.tokens, 0.0) - wait * bucket.rate

    # What this key is allowed right now, for the response body and the logs.
    def snapshot(self, provider: str, model: str, api_key: str) -> dict:
        provider = canonical_provider(provider or "auto")
        if not self.enabled() or not self._gated(provider):
            return {"gated": False, "adaptive": False, "rpm": 0.0, "burst": 0, "waiting": 0}
        bucket = self._lookup(provider, model, api_key)
        if bucket is None:
            start_rpm, burst, rpm_min, rpm_max = self._policy(provider)
            return {
                "gated": True, "adaptive": self.adaptive_enabled(), "pinned": False,
                "rpm": start_rpm, "burst": burst,
                "rpmMin": rpm_min, "rpmMax": rpm_max, "waiting": 0,
            }
        bucket.refill()
        return {
            "gated": True,
            "adaptive": self.adaptive_enabled() and not bucket.pinned,
            "pinned": bucket.pinned,
            "rpm": round(bucket.rpm, 2),
            "burst": int(bucket.capacity),
            "rpmMin": round(bucket.rpm_min, 2),
            "rpmMax": round(bucket.rpm_max, 2),
            "tokens": round(bucket.tokens, 2),
            "waiting": len(bucket.jobset),
        }

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
    def _prune_buckets(self) -> None:
        """Evict idle buckets (no waiters, no pending timer) when over the cap.

        Oldest-refilled first. Buckets that are actively pacing (have queued
        waiters or a scheduled refill) are never touched, so pacing state is
        never lost mid-batch.
        """
        if len(self._buckets) <= _MAX_BUCKETS:
            return
        idle = [
            (b.last, k)
            for k, b in self._buckets.items()
            if not b.jobset and b.timer is None
        ]
        idle.sort()
        for _, k in idle[: len(self._buckets) - _MAX_BUCKETS]:
            self._buckets.pop(k, None)

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
