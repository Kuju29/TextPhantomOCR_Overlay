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
import json
import math
import os
import tempfile
import time
from collections import OrderedDict, deque
from pathlib import Path

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


# --- learned-rate persistence -------------------------------------------------
#
# What a bucket learns is the only expensive thing in this module: reaching a
# usable rate from the free-tier starting number costs ~64 clean calls, and
# until 2026-08-19 every one of those calls was paid again on the next process
# start. On a Hugging Face Space — which restarts whenever it wakes from sleep —
# that meant the ramp was paid on essentially every session, and the measured
# result was 19 pages/min on the first chapter against 50 on the fourth.
#
# So the rate is written to a small JSON file keyed by the SAME hashed bucket
# key used in memory (provider|model|sha1(key)[:12]) — the API key itself is
# never written. Nothing else is persisted: tokens, waiters and timers are all
# in-flight state that must start clean.
#
# This is a cache, not a source of truth. A restored rate that is now too high
# costs exactly one provider 429, which `report_rate_limited` halves on the same
# round trip. A restore that fails is REPORTED (see `persistence()`), never
# silently skipped, because "the ramp is back" with no explanation is the
# hardest version of this bug to find.
_STATE_TTL_SEC = _env_float("TP_RATE_STATE_TTL_SEC", 7 * 24 * 3600.0)
_STATE_SAVE_MIN_INTERVAL_SEC = _env_float("TP_RATE_STATE_SAVE_SEC", 30.0)
_STATE_SCHEMA = "tp.rategate.state/1"


def _state_path() -> Path | None:
    """Where the learned rates live, or None when persistence is switched off.

    Order matters and is about WRITABILITY, not preference. A Docker Space runs
    the app as a non-root user against a root-owned image, so the checkout is
    usually read-only; `/data` is the only mount that survives a restart, and
    the temp dir at least survives an in-container reload.
    """
    raw = os.environ.get("TP_RATE_STATE_FILE", "").strip()
    if raw:
        return Path(raw)
    if _env_int("TP_RATE_STATE", 1) == 0:
        return None
    for candidate in (
        Path("/data") / "textphantom",                      # HF persistent storage
        Path(__file__).resolve().parents[2] / "state",      # local install
    ):
        parent = candidate if candidate.is_dir() else candidate.parent
        if parent.is_dir() and os.access(parent, os.W_OK):
            return candidate / "rate-gate.json"
    return Path(tempfile.gettempdir()) / "textphantom-rate-gate.json"


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

    # How long a request arriving NOW would have to wait, in seconds.
    #
    # This is the number the caller owes a rejected client: not a flat guess,
    # but the queue in front of it divided by the rate it drains at. A flat
    # "Retry-After: 5" on a bucket with 30 queued jobs at 12 rpm sends every one
    # of them back in five seconds to be rejected again.
    def eta_sec(self) -> float:
        self.refill()
        if self.rate <= 0:
            return 0.0
        need = (len(self.jobset) + 1) - self.tokens
        return max(0.0, need) / self.rate

    # Clean calls required before the rate may step up (see RATE_ADAPT_* notes).
    def ok_streak_target(self) -> int:
        if self.rate <= 0:
            return ai_config.RATE_ADAPT_OK_STREAK
        per_window = math.ceil(self.rate * ai_config.RATE_ADAPT_OK_WINDOW_SEC)
        return max(
            ai_config.RATE_ADAPT_OK_STREAK_MIN,
            min(ai_config.RATE_ADAPT_OK_STREAK, per_window),
        )


class RateGate:
    """Process-wide singleton coordinating all AI provider pacing."""

    def __init__(self) -> None:
        self._buckets: dict[str, _Bucket] = {}
        # job_id -> _Waiter, for O(1) cancellation by job id.
        self._waiters: dict[str, _Waiter] = {}
        # Learned rates read from disk, applied when a bucket is first created.
        self._restored: dict[str, float] | None = None
        self._state_error: str = ""
        self._state_loaded_count: int = 0
        self._state_saved_at: float = 0.0
        self._state_dirty: bool = False

    # --- learned-rate persistence -------------------------------------------
    def _load_state(self) -> dict[str, float]:
        """Read the saved rates once per process. Never raises."""
        if self._restored is not None:
            return self._restored
        self._restored = {}
        path = _state_path()
        if path is None:
            self._state_error = "disabled by TP_RATE_STATE=0"
            return self._restored
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return self._restored  # first run on this machine; not an error
        except (OSError, ValueError) as exc:
            self._state_error = f"{type(exc).__name__}: {exc}"
            return self._restored
        if not isinstance(raw, dict) or raw.get("schema") != _STATE_SCHEMA:
            self._state_error = "unrecognised state file; ignoring it"
            return self._restored
        now = time.time()
        for key, entry in (raw.get("buckets") or {}).items():
            if not isinstance(entry, dict):
                continue
            try:
                rpm = float(entry.get("rpm") or 0.0)
                seen = float(entry.get("at") or 0.0)
            except (TypeError, ValueError):
                continue
            # Evidence has a shelf life. Past the TTL the key may have changed
            # tier, been rotated, or moved to another quota entirely.
            if rpm > 0 and 0 < seen and (now - seen) <= _STATE_TTL_SEC:
                self._restored[str(key)] = rpm
        self._state_loaded_count = len(self._restored)
        return self._restored

    def _save_state(self, *, force: bool = False) -> None:
        """Write the learned rates, at most once per interval. Never raises."""
        if not self._state_dirty and not force:
            return
        now = time.monotonic()
        if not force and (now - self._state_saved_at) < _STATE_SAVE_MIN_INTERVAL_SEC:
            return
        path = _state_path()
        if path is None:
            return
        self._state_saved_at = now
        self._state_dirty = False
        wall = time.time()
        payload = {
            "schema": _STATE_SCHEMA,
            "at": wall,
            "buckets": {
                key: {"rpm": round(bucket.rpm, 3), "at": wall}
                # A pinned bucket is the user's number, not something learned;
                # persisting it would resurrect a setting they since changed.
                for key, bucket in self._buckets.items()
                if not bucket.pinned and bucket.rpm > 0
            },
        }
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            tmp.replace(path)  # atomic: a torn file would read as "no evidence"
            self._state_error = ""
        except OSError as exc:
            self._state_error = f"{type(exc).__name__}: {exc}"

    def persistence(self) -> dict:
        """What the learned-rate cache is doing, for /v1/capabilities and logs.

        Reported rather than assumed: a read-only filesystem turns this feature
        off completely, and the only symptom is that the ramp comes back.
        """
        path = _state_path()
        self._load_state()
        return {
            "path": str(path) if path else "",
            "enabled": bool(path),
            "restored": self._state_loaded_count,
            "error": self._state_error,
        }

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
            # A quota that has been quiet for this long is weaker evidence, not
            # no evidence. Give back one idle window's worth and keep the rest:
            # being wrong here costs a single 429 that halves the rate anyway,
            # while resetting to the start cost the whole ramp after every
            # break the user took.
            idle_windows = int(
                (now - bucket.touched) // max(1.0, ai_config.RATE_ADAPT_IDLE_RESET_SEC)
            )
            decayed = bucket.rpm * (ai_config.RATE_ADAPT_IDLE_DECAY ** max(1, idle_windows))
            bucket.set_rpm(max(start_rpm, decayed))
            bucket.ok_streak = 0
        if bucket is None:
            self._prune_buckets()
            # Start from what this key was last known to sustain. Only the RATE
            # is restored — tokens start full either way, so a restored bucket
            # still fires its burst immediately and still halves on a 429.
            restored = 0.0 if pinned else self._load_state().get(key, 0.0)
            seed = start_rpm
            if restored > 0:
                seed = min(max(restored, rpm_min), rpm_max)
            bucket = _Bucket(burst, seed / 60.0)
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
        if bucket.ok_streak < bucket.ok_streak_target():
            return
        bucket.ok_streak = 0
        if bucket.rpm < bucket.rpm_max:
            bucket.set_rpm(min(bucket.rpm_max, bucket.rpm + ai_config.RATE_ADAPT_STEP_RPM))
            self._state_dirty = True
        self._save_state()

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
            # Persist the DECREASE straight away. A rate we learned was too high
            # is the one piece of evidence worth surviving a crash: replaying it
            # after a restart is another round of 429s at the user's expense.
            self._state_dirty = True
            self._save_state(force=True)
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
            # How many clean calls this bucket still owes before it may speed
            # up, and how long a request arriving now would queue. Both were
            # previously only derivable by re-implementing the maths.
            "okStreak": int(bucket.ok_streak),
            "okStreakTarget": bucket.ok_streak_target(),
            "etaSec": round(bucket.eta_sec(), 2),
        }

    def retry_after_sec(self, provider: str, model: str, api_key: str) -> float:
        """Seconds a rejected caller should actually wait, from the bucket.

        A flat number here is worse than none: told to come back in 5 s, thirty
        queued pages all come back in 5 s and are all rejected again.
        """
        bucket = self._lookup(provider, model, api_key)
        if bucket is None:
            return 1.0
        return max(1.0, min(60.0, bucket.eta_sec()))

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
            "persistence": self.persistence(),
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
