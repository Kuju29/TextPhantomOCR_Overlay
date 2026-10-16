"""Fair, work-conserving admission for every shared API lane.

The owner's rule, verbatim in spirit:

    Each kind of work has its own pipe. If one user is alone, he gets the
    full pipe. With two or more users, the pipe is split into sub-pipes so one
    user cannot hold it all. The waiting queue is NOT limited by a count of
    waiters -- bursts are short and the queue drains fast. Never drop work
    because a queue is "full".

So a lane (Lens upload, grouping, AI, Login AI, the runs:API pipeline, image
download) has exactly one capacity number, ``limit``: how much work may RUN at
once. That number protects something real (the shared Google IP, the CPU, a
provider account) and stays. Everything else is a queue:

* No waiter count cap and no wait deadline. A request waits until a slot is
  free, its client goes away (``cancel_check``), or its task is cancelled.
* Per identity the queue is FIFO: a user's pages run in the order they came.
* A freed slot goes to the waiting identity that currently runs the FEWEST
  slots; ties go to the identity served least recently (round-robin). One
  identity alone therefore gets every slot (work-conserving), two identities
  converge to half each, and a newcomer with one page gets the very next
  freed slot even while somebody else's 78-page chapter is queued.
* Nothing is preempted: running work always finishes.
* Memory, not count, is the only safety bound on waiting. Waiting request
  bodies are already in RAM; :data:`waiting_bytes` keeps their total under
  ``TP_MAX_QUEUE_BYTES`` so the process cannot be OOM-killed (which would drop
  everyone's work). Only that guard ever turns a waiter away, with a 503
  ``server_busy`` + ``Retry-After`` that every client retries.

Identity is resolved by :func:`fair_key`: the browser install id
(``X-TP-Install``) when present, else the tab session, else the client IP, else
an auth/key hash, else ``anon``. See ``backend/api/fairness.py``.

All gate state lives on the event loop thread. Worker threads reach it only
through ``backend/jobs/stage_admission.py``.
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass

ANONYMOUS = "anon"

# Waiting coroutines re-check their owner (client still connected, batch not
# cancelled) at this interval. It bounds how long a gone client's waiter lingers.
CANCEL_POLL_SEC = 0.25


class AdmissionRejected(RuntimeError):
    """No capacity. Carries the delay the caller should honour.

    Since 2026.10.16.3 the only producer is the waiting-memory guard
    (:class:`MemoryBudgetExceeded`); a waiter count never rejects.
    """

    def __init__(self, message: str, retry_after_sec: int) -> None:
        super().__init__(message)
        self.retry_after_sec = max(1, int(retry_after_sec))


class MemoryBudgetExceeded(AdmissionRejected):
    """Admitting one more WAITING body would exceed the waiting-memory budget."""

    reason = "memory_guard"


class AdmissionCancelled(RuntimeError):
    """The waiter's owner went away (client disconnected / batch cancelled).

    Nothing was dispatched; the waiter was removed from its queue and holds no
    slot. ``requestDispatched`` keeps the existing provider-error contract.
    """

    requestDispatched = False

    def __init__(self, message: str = "cancelled while waiting for a slot") -> None:
        super().__init__(message)


def identity_of(payload: dict | None) -> str:
    """The request's own identity: tab session, else a hash of the AI key.

    Used for cache scoping, conversations and idempotency, and as the
    starting point of :func:`fair_key`. Keys are hashed — an identity printed
    in ``stats()`` must not be a secret.
    """
    data = payload if isinstance(payload, dict) else {}
    ctx = data.get("context") if isinstance(data.get("context"), dict) else {}
    session = str(ctx.get("tp_tab_session") or "").strip()
    if session:
        return "s:" + session[:32]
    ai = data.get("ai") if isinstance(data.get("ai"), dict) else {}
    key = str(ai.get("api_key") or "").strip()
    if key:
        return "k:" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    return ANONYMOUS


# --- who is waiting: the fairness key -----------------------------------------

@dataclass(frozen=True)
class RequestOwner:
    """Request-level evidence for fairness, captured by the ingress middleware.

    Each field is already an opaque, non-secret key ("" when unknown).
    """

    install: str = ""
    ip: str = ""
    auth: str = ""


_request_owner: contextvars.ContextVar[RequestOwner | None] = contextvars.ContextVar(
    "tp_fair_request_owner", default=None)


def bind_request_owner(owner: RequestOwner | None) -> contextvars.Token:
    return _request_owner.set(owner)


def reset_request_owner(token: contextvars.Token) -> None:
    _request_owner.reset(token)


def current_request_owner() -> RequestOwner | None:
    return _request_owner.get()


def fair_key(identity: str | None) -> str:
    """Who a waiter belongs to, for sharing a lane.

    Order: install id > tab session > client IP > key/auth hash > anonymous.
    The install id groups every tab of one browser; the tab session keeps old
    clients (no install id) apart from each other; the IP keeps clients that
    send neither apart; an auth hash is the last distinguishing evidence.
    Outside an HTTP request (CLI, legacy queue workers) the given identity is
    used unchanged.
    """
    value = str(identity or ANONYMOUS)
    owner = _request_owner.get()
    if owner is None:
        return value
    if owner.install:
        return owner.install
    if value.startswith("s:"):
        return value
    if owner.ip:
        return owner.ip
    if value != ANONYMOUS:
        return value
    if owner.auth:
        return owner.auth
    return ANONYMOUS


# --- memory guard ---------------------------------------------------------------

class WaitingBytes:
    """Bytes of request bodies that are WAITING for a slot, process-wide.

    Rule (work-conserving, like the slots): a waiter is admitted while the
    total stays within ``TP_MAX_QUEUE_BYTES``. One identity may exceed
    ``TP_MAX_QUEUE_BYTES_PER_IDENTITY`` only while at least that much of the
    global budget stays free, so a lone user can queue a big chapter (up to
    384 MiB of waiting bodies with the defaults) yet one share always remains
    for everyone else. Event-loop thread only.
    """

    def __init__(self) -> None:
        self.total = 0
        self.by: dict[str, int] = {}
        self.rejections = 0

    @staticmethod
    def limits() -> tuple[int, int]:
        from backend.config import settings
        total = max(1, int(getattr(settings, "max_queue_bytes", 512 << 20)))
        per = max(1, int(getattr(settings, "max_queue_bytes_per_identity", 128 << 20)))
        return total, per

    def reserve(self, key: str, nbytes: int, *, lane: str, retry_after_sec: int) -> int:
        n = max(0, int(nbytes or 0))
        if n == 0:
            return 0
        total_cap, per_cap = self.limits()
        mine = self.by.get(key, 0)
        over_total = self.total + n > total_cap
        over_share = mine + n > per_cap and self.total + n > max(0, total_cap - per_cap)
        if over_total or over_share:
            self.rejections += 1
            from backend.log import event
            event("admission.memory_guard", {
                "lane": lane, "requestBytes": n, "waitingBytes": self.total,
                "identityWaitingBytes": mine, "maxQueueBytes": total_cap,
                "maxQueueBytesPerIdentity": per_cap,
                "rule": "total" if over_total else "identity_share",
                "retryAfterSec": retry_after_sec, "code": "server_busy", "status": 503,
                "rejectionsSinceStart": self.rejections,
            }, ok=False)
            raise MemoryBudgetExceeded(
                f"waiting requests already hold {self.total} bytes "
                f"(limit {total_cap}, this identity {mine} of {per_cap}); retry shortly",
                retry_after_sec,
            )
        self.total += n
        self.by[key] = mine + n
        return n

    def release(self, key: str, nbytes: int) -> None:
        n = max(0, int(nbytes or 0))
        if n == 0:
            return
        self.total = max(0, self.total - n)
        left = self.by.get(key, 0) - n
        if left > 0:
            self.by[key] = left
        else:
            self.by.pop(key, None)


waiting_bytes = WaitingBytes()


# --- the gate ----------------------------------------------------------------------

@dataclass(frozen=True)
class Admission:
    """How a slot was obtained, for the perf events."""

    wait_ms: float = 0.0
    # 1-based place in the whole lane queue / in this identity's own FIFO at
    # enqueue time; 0 = admitted without waiting.
    queue_position: int = 0
    identity_position: int = 0


@dataclass(frozen=True)
class GateStats:
    limit: int
    running: int
    waiting: int
    identities: int = 1
    share: int = 0
    anonymous_running: int = 0
    waiting_identities: int = 0
    waiting_bytes: int = 0

    @property
    def free(self) -> int:
        return max(0, self.limit - self.running)

    def as_dict(self) -> dict:
        return {
            "limit": self.limit,
            "running": self.running,
            "waiting": self.waiting,
            "free": self.free,
            "identities": self.identities,
            # Informational: the fair share each active identity converges to.
            # It is not a cap -- a lone identity uses every slot.
            "share": self.share,
            "anonymousRunning": self.anonymous_running,
            "waitingIdentities": self.waiting_identities,
            "waitingBytes": self.waiting_bytes,
        }


class _Waiter:
    __slots__ = ("key", "future", "enqueued")

    def __init__(self, key: str, future: asyncio.Future) -> None:
        self.key = key
        self.future = future
        self.enqueued = time.perf_counter()


class AdmissionGate:
    """Bounded concurrency, unbounded fair FIFO-per-identity waiting."""

    # Additive increase only under real demand, multiplicative decrease on a
    # latency cliff. Public lanes are built with adaptive=False.
    ADAPT_OK_STREAK = 6
    ADAPT_CLIFF_RATIO = 2.5
    ADAPT_BACKOFF = 0.5
    ADAPT_MIN_SAMPLES = 6

    def __init__(
        self,
        limit: int,
        *,
        name: str = "lane",
        adaptive: bool = False,
        limit_min: int | None = None,
        limit_max: int | None = None,
    ) -> None:
        if limit < 1:
            raise ValueError("limit must be >= 1")
        self.name = str(name or "lane")
        self._limit = int(limit)
        self._limit_start = int(limit)
        self._adaptive = bool(adaptive)
        self._limit_min = max(1, int(limit_min if limit_min is not None else limit))
        self._limit_max = max(self._limit_min, int(limit_max if limit_max is not None else limit))
        self._ok_streak = 0
        self._samples = 0
        self._adapt_events = {"grew": 0, "shrank": 0}
        self._running = 0
        self._running_by: dict[str, int] = {}
        # identity -> its own FIFO of waiters. Only non-empty queues are kept.
        self._queues: dict[str, deque[_Waiter]] = {}
        self._waiting = 0
        # Round-robin tie-break: identity -> sequence number of its last grant.
        self._served_seq = 0
        self._last_served: dict[str, int] = {}
        # Rolling run-time estimate, used only for Retry-After of the memory guard.
        self._avg_run_sec = 2.0
        self._granted = 0
        self._waited = 0
        self._max_wait_ms = 0.0

    # --- introspection -----------------------------------------------------

    def _active_identities(self) -> int:
        return max(1, len(set(self._running_by) | set(self._queues)))

    def _share(self) -> int:
        identities = self._active_identities()
        return max(1, (self._limit + identities - 1) // identities)

    def stats(self) -> GateStats:
        return GateStats(
            limit=self._limit,
            running=self._running,
            waiting=self._waiting,
            identities=self._active_identities(),
            share=self._share(),
            anonymous_running=self._running_by.get(ANONYMOUS, 0),
            waiting_identities=len(self._queues),
            waiting_bytes=waiting_bytes.total,
        )

    def invariants(self) -> dict:
        """Counters recomputed from the structures, for leak tests and /health."""
        queued = sum(len(q) for q in self._queues.values())
        return {
            "running": self._running,
            "runningBySum": sum(self._running_by.values()),
            "waiting": self._waiting,
            "queued": queued,
            "emptyQueues": sum(1 for q in self._queues.values() if not q),
            "staleServed": len(set(self._last_served) - set(self._running_by) - set(self._queues)),
            "consistent": (self._running == sum(self._running_by.values())
                           and self._waiting == queued
                           and all(self._queues.values())
                           and all(v > 0 for v in self._running_by.values())),
        }

    def adaptive_state(self) -> dict:
        return {
            "adaptive": self._adaptive,
            "limit": self._limit,
            "limitStart": self._limit_start,
            "limitMin": self._limit_min,
            "limitMax": self._limit_max,
            "avgRunSec": round(self._avg_run_sec, 3),
            "grew": self._adapt_events["grew"],
            "shrank": self._adapt_events["shrank"],
        }

    def _adapt(self, run_sec: float, saturated: bool) -> None:
        if not self._adaptive or run_sec <= 0:
            return
        cliff = (
            self._samples >= self.ADAPT_MIN_SAMPLES
            and self._avg_run_sec > 0
            and run_sec > self._avg_run_sec * self.ADAPT_CLIFF_RATIO
        )
        self._samples += 1
        if cliff:
            self._ok_streak = 0
            new_limit = max(self._limit_min, int(self._limit * self.ADAPT_BACKOFF))
            if new_limit < self._limit:
                self._limit = new_limit
                self._adapt_events["shrank"] += 1
            return
        if not saturated:
            return
        self._ok_streak += 1
        if self._ok_streak >= self.ADAPT_OK_STREAK:
            self._ok_streak = 0
            if self._limit < self._limit_max:
                self._limit = min(self._limit_max, self._limit + max(1, self._limit // 10))
                self._adapt_events["grew"] += 1

    def retry_after_sec(self) -> int:
        """How long the caller should wait, from the work actually in flight."""
        ahead = self._running + self._waiting
        per_slot = self._avg_run_sec / self._limit
        return max(1, min(30, int(round(ahead * per_slot))))

    # --- slot bookkeeping (event-loop thread only, never awaits) ------------

    def _take(self, key: str) -> None:
        self._running += 1
        self._running_by[key] = self._running_by.get(key, 0) + 1
        self._served_seq += 1
        self._last_served[key] = self._served_seq
        self._granted += 1

    def _forget_if_idle(self, key: str) -> None:
        if key not in self._running_by and key not in self._queues:
            self._last_served.pop(key, None)

    def _give_back(self, key: str) -> None:
        self._running = max(0, self._running - 1)
        left = self._running_by.get(key, 0) - 1
        if left > 0:
            self._running_by[key] = left
        else:
            self._running_by.pop(key, None)
            self._forget_if_idle(key)

    def _pick(self) -> str:
        best_key = ""
        best_rank: tuple[int, int] | None = None
        for key in self._queues:
            rank = (self._running_by.get(key, 0), self._last_served.get(key, -1))
            if best_rank is None or rank < best_rank:
                best_key, best_rank = key, rank
        return best_key

    def _dispatch(self) -> None:
        """Hand every free slot to the fairest waiter, reserving it right here.

        Reserving in the same synchronous step as the decision means no other
        arrival can slip into the slot between "you're next" and the waiter
        actually running.
        """
        while self._running < self._limit and self._queues:
            key = self._pick()
            queue = self._queues[key]
            waiter = queue.popleft()
            if not queue:
                del self._queues[key]
            self._waiting -= 1
            if waiter.future.done():
                # Cancelled between its own cleanup steps; never grant it.
                self._forget_if_idle(key)
                continue
            self._take(key)
            waiter.future.set_result(True)

    def _remove(self, waiter: _Waiter) -> None:
        queue = self._queues.get(waiter.key)
        if queue is None:
            return
        try:
            queue.remove(waiter)
        except ValueError:
            return
        self._waiting -= 1
        if not queue:
            del self._queues[waiter.key]
            self._forget_if_idle(waiter.key)

    # --- public API -----------------------------------------------------------

    async def acquire(
        self,
        identity: str = ANONYMOUS,
        *,
        cancel_check: Callable[[], bool] | None = None,
        nbytes: int = 0,
    ) -> Admission:
        """Take a slot for ``identity`` (already a fairness key), waiting fairly.

        Raises :class:`AdmissionCancelled` when ``cancel_check()`` turns true
        while waiting, :class:`MemoryBudgetExceeded` when the waiting-memory
        guard refuses, or ``CancelledError`` when the task is cancelled. In
        every case the waiter is gone and no slot is held afterwards.
        """
        key = str(identity or ANONYMOUS)
        if self._running < self._limit and not self._queues:
            self._take(key)
            return Admission()

        reserved = waiting_bytes.reserve(key, nbytes, lane=self.name,
                                         retry_after_sec=self.retry_after_sec())
        loop = asyncio.get_running_loop()
        waiter = _Waiter(key, loop.create_future())
        queue = self._queues.get(key)
        if queue is None:
            queue = self._queues[key] = deque()
        queue.append(waiter)
        self._waiting += 1
        position, mine = self._waiting, len(queue)
        started = waiter.enqueued
        try:
            self._dispatch()  # a slot may be free (e.g. adaptive growth)
            future = waiter.future
            while not future.done():
                if cancel_check is not None and cancel_check():
                    raise AdmissionCancelled(
                        f"{self.name}: owner went away while waiting "
                        f"(position {position}, waited {time.perf_counter() - started:.1f}s)")
                # asyncio.wait never cancels the future itself, so a grant that
                # lands while this task is being cancelled is still visible.
                await asyncio.wait({future}, timeout=CANCEL_POLL_SEC if cancel_check else None)
        except BaseException:
            if waiter.future.done() and not waiter.future.cancelled():
                # Granted in the same tick the owner left: hand the slot on.
                self._give_back(key)
                self._dispatch()
            else:
                waiter.future.cancel()
                self._remove(waiter)
            raise
        finally:
            waiting_bytes.release(key, reserved)
        wait_ms = round((time.perf_counter() - started) * 1000, 1)
        self._waited += 1
        self._max_wait_ms = max(self._max_wait_ms, wait_ms)
        return Admission(wait_ms, position, mine)

    def release(self, identity: str = ANONYMOUS, *, run_sec: float | None = None) -> None:
        """Give the slot back and pass it to the next fair waiter.

        ``run_sec`` is keyword-only and a non-string identity is a TypeError, so
        a stale positional ``release(run_sec)`` call cannot bind a float as the
        identity and silently leak the per-identity count.
        """
        if not isinstance(identity, str):
            raise TypeError(
                f"identity must be a str, got {type(identity).__name__} — "
                "release() takes the identity first and run_sec by keyword"
            )
        saturated = bool(self._queues) or self._running >= self._limit
        self._give_back(identity or ANONYMOUS)
        if run_sec is not None and run_sec > 0:
            self._adapt(float(run_sec), saturated)
            self._avg_run_sec = (self._avg_run_sec * 0.8) + (float(run_sec) * 0.2)
        self._dispatch()

    class _Slot:
        def __init__(self, gate: "AdmissionGate", identity: str,
                     cancel_check: Callable[[], bool] | None, nbytes: int) -> None:
            self._gate = gate
            self._identity = identity or ANONYMOUS
            self._cancel_check = cancel_check
            self._nbytes = nbytes
            self.key = ""
            self.admission = Admission()
            self._t0 = 0.0

        @property
        def wait_ms(self) -> float:
            return self.admission.wait_ms

        async def __aenter__(self) -> "AdmissionGate._Slot":
            self.key = fair_key(self._identity)
            self.admission = await self._gate.acquire(
                self.key, cancel_check=self._cancel_check, nbytes=self._nbytes)
            self._t0 = time.perf_counter()
            return self

        async def __aexit__(self, *_exc) -> bool:
            self._gate.release(self.key, run_sec=time.perf_counter() - self._t0)
            return False

    def slot(self, identity: str = ANONYMOUS, *, cancel_check: Callable[[], bool] | None = None,
             nbytes: int = 0) -> "AdmissionGate._Slot":
        """``async with gate.slot(identity):`` — wait fairly, run, always release."""
        return AdmissionGate._Slot(self, identity, cancel_check, nbytes)
