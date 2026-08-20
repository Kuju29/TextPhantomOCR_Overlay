"""Admission control for the synchronous translate endpoint.


The queue this replaces
-----------------------
``JobQueue`` accepted up to ``TP_MAX_QUEUE_SIZE`` (2000) payloads, held every
result in a process-local dict until the extension polled for it, and lost all
of it on restart. That design forced three other things to exist: job ids,
long-polling, and a client that had to keep asking "is it done yet".

It also did not actually protect anything. A queue that deep does not shed
load — it *hides* it: the client sees an accepted job and waits, while the
work sits behind two thousand others. The user-visible symptom is a progress
bar that has silently stopped moving, which is exactly what the long comments
in ``transport.js`` were written to work around.

What replaces it
----------------
A gate, not a queue. A request either gets a slot within a short, bounded wait
or is told to come back — with a ``Retry-After`` the client can respect. There
is no server-side backlog, so there is nothing to lose on restart and nothing
to poll for. The extension holds the work it has not submitted yet, which is
where the state belongs: it is the only party that knows whether the user is
still looking at that page.

The two limits mean different things:

``limit``       how much work may run at once. Capacity.
``max_waiters`` how many requests may queue for a slot. This is small on
                purpose — it absorbs jitter between two arrivals, not a batch.
                Past it the answer is 503 immediately, which reaches the user
                as "the server is busy" instead of a stalled bar.

Capacity is shared between PEOPLE, not requests
-----------------------------------------------
One gate for the whole server meant one person's chapter was everybody's
outage. Measured 2026-08-07 against this class: user A opened a 60-page
chapter, user B arrived 50 ms later asking for a SINGLE page, and B was the
one who got the 503 — ``A=60 served, B=0``.

So slots are handed out per identity, max-min fair:

* one identity active  -> it may use every slot;
* a second one appears -> each may hold ``limit // 2``, and the first shrinks
  to that as its own jobs finish. Nothing is preempted: work already running
  always finishes, so nobody's page is thrown away to make room.

Identity is the AI key when the request carries one, else the tab session.
That is "different person OR different key" — the two things that have
separate provider budgets. It is deliberately NOT the model: the provider's
per-model budget is the rate gate's job (it buckets by provider+model+key),
and folding the model in here would let one person take two shares by running
two models.

Requests with no identity at all share a single bucket. They cannot be told
apart, so they are not pretended to be different — and ``stats()`` reports how
many are in it, because a server where everyone lands in the anonymous bucket
is fair in name only.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from dataclasses import dataclass, field

ANONYMOUS = "anon"


class AdmissionRejected(RuntimeError):
    """No capacity. Carries the delay the caller should honour."""

    def __init__(self, message: str, retry_after_sec: int) -> None:
        super().__init__(message)
        self.retry_after_sec = max(1, int(retry_after_sec))


def identity_of(payload: dict | None) -> str:
    """Who this request belongs to, for the purpose of sharing capacity.

    The AI key first, because that is the thing with a provider budget behind
    it; the tab session otherwise. Keys are hashed — an identity used as a dict
    key and printed in ``stats()`` must not be a secret.
    """
    data = payload if isinstance(payload, dict) else {}
    ai = data.get("ai") if isinstance(data.get("ai"), dict) else {}
    key = str(ai.get("api_key") or "").strip()
    if key:
        return "k:" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    ctx = data.get("context") if isinstance(data.get("context"), dict) else {}
    session = str(ctx.get("tp_tab_session") or "").strip()
    if session:
        return "s:" + session[:32]
    return ANONYMOUS


@dataclass(frozen=True)
class GateStats:
    limit: int
    running: int
    waiting: int
    max_waiters: int
    identities: int = 1
    share: int = 0
    anonymous_running: int = 0

    @property
    def free(self) -> int:
        return max(0, self.limit - self.running)

    def as_dict(self) -> dict:
        return {
            "limit": self.limit,
            "running": self.running,
            "waiting": self.waiting,
            "free": self.free,
            # How the capacity is currently divided. Without these, "the server
            # is busy" and "your share is full while the server is half idle"
            # are the same 503 with the same body.
            "identities": self.identities,
            "share": self.share,
            "anonymousRunning": self.anonymous_running,
        }


class AdmissionGate:
    """Bounded-concurrency gate with bounded waiting and no backlog."""

    # Additive increase only under real demand, multiplicative decrease on a
    # latency cliff. Growing a gate that nobody is queueing for proves nothing.
    ADAPT_OK_STREAK = 6
    ADAPT_CLIFF_RATIO = 2.5
    ADAPT_BACKOFF = 0.5
    ADAPT_MIN_SAMPLES = 6

    def __init__(
        self,
        limit: int,
        *,
        max_waiters: int,
        max_wait_sec: float,
        adaptive: bool = False,
        limit_min: int | None = None,
        limit_max: int | None = None,
    ) -> None:
        if limit < 1:
            raise ValueError("limit must be >= 1")
        self._limit = int(limit)
        self._limit_start = int(limit)
        self._adaptive = bool(adaptive)
        self._limit_min = max(1, int(limit_min if limit_min is not None else limit))
        self._limit_max = max(self._limit_min, int(limit_max if limit_max is not None else limit))
        self._ok_streak = 0
        self._samples = 0
        self._adapt_events = {"grew": 0, "shrank": 0}
        self._max_waiters = max(0, int(max_waiters))
        self._max_wait_sec = max(0.0, float(max_wait_sec))
        # Waiting is a small fairness/jitter cushion, not a second server full
        # of future work. `max_waiters` is therefore a literal GLOBAL queue cap.
        # A waiter is cheap, but "cheap" queues are exactly how backlog grows.
        self._running = 0
        self._waiting = 0
        # identity -> how many of its jobs are running / queued right now.
        self._running_by: dict[str, int] = {}
        self._waiting_by: dict[str, int] = {}
        # Waiters, oldest first: (identity, future). A freed slot goes to the
        # oldest waiter that its identity's share now allows.
        self._waiters: list[tuple[str, asyncio.Future]] = []
        # Rolling estimate of how long a job takes, used to answer "come back
        # in N seconds" with a real number instead of a constant. Seeded
        # optimistically; the first completions correct it within seconds.
        self._avg_run_sec = 2.0

    # --- introspection -----------------------------------------------------

    @property
    def _hard_waiting_cap(self) -> int:
        return self._max_waiters

    def _active_identities(self) -> int:
        """Distinct identities with work running or queued. At least one."""
        return max(1, len(set(self._running_by) | set(self._waiting_by)))

    def _share(self) -> int:
        """How many slots one identity may hold right now.

        Floor division, but never below one: with sixteen identities on a
        fifteen-slot server, ``15 // 16 == 0`` would admit nobody at all — a
        fairness rule that starves everyone equally is not fairness.
        """
        return max(1, self._limit // self._active_identities())

    def _waiting_share(self) -> int:
        """How many of one identity's requests may queue for a slot.

        The waiting list needs the same rule as the running slots, and for a
        sharper reason: sharing the SLOTS is pointless if one person's batch
        can fill the QUEUE, because the second person is then turned away
        before the fairness rule ever gets to look at them. Measured
        2026-08-07 with the running slots already shared: A held 15 running
        plus all 8 waiting, and B's single page was still refused.
        """
        return max(1, self._max_waiters // self._active_identities())

    def stats(self) -> GateStats:
        return GateStats(
            limit=self._limit,
            running=self._running,
            waiting=self._waiting,
            max_waiters=self._max_waiters,
            identities=self._active_identities(),
            share=self._share(),
            anonymous_running=self._running_by.get(ANONYMOUS, 0),
        )

    # Current capacity and how it got there, for /v1/capabilities and the logs.
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

    # Moves capacity from one completed job's run time: grow while the gate is
    # in demand and latency is stable, halve the moment latency cliffs.
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

    # --- gate --------------------------------------------------------------

    def _may_run(self, identity: str) -> bool:
        """Pure check. Never awaits, so a caller can act on it atomically."""
        if self._running >= self._limit:
            return False
        return self._running_by.get(identity, 0) < self._share()

    def _take(self, identity: str) -> None:
        self._running += 1
        self._running_by[identity] = self._running_by.get(identity, 0) + 1

    def _give_back(self, identity: str) -> None:
        self._running = max(0, self._running - 1)
        left = self._running_by.get(identity, 0) - 1
        if left > 0:
            self._running_by[identity] = left
        else:
            # Drop the entry, or `_active_identities` counts people who left
            # and the share shrinks forever.
            self._running_by.pop(identity, None)

    def _wake_next(self) -> None:
        """Hand freed capacity to the oldest waiter its share now permits."""
        for index, (identity, future) in enumerate(self._waiters):
            if future.done():
                continue
            if not self._may_run(identity):
                continue
            self._waiters.pop(index)
            # Reserve the slot HERE, in the same synchronous step as the
            # decision. Waking the waiter and letting it take its own slot
            # would leave a gap in which another arrival could take it, and
            # the woken request would find the door shut again.
            self._take(identity)
            future.set_result(True)
            return

    async def acquire(self, identity: str = ANONYMOUS) -> None:
        """Take a slot for ``identity``, or raise :class:`AdmissionRejected`.

        The fast path decides and reserves with no ``await`` in between, which
        is what makes it correct under a burst. The previous version asked
        ``asyncio.Semaphore.locked()``, and a semaphore is not decremented
        until the coroutine that acquires it actually runs — so sixty requests
        arriving in one event-loop tick ALL saw an unlocked semaphore, all
        queued, and ``max_waiters=8`` bounded nothing. Measured 2026-08-07:
        peak waiting was 45 for a burst of 60, versus 3 for the same 60 spread
        5 ms apart. A burst is the only case this limit exists for.
        """
        identity = identity or ANONYMOUS

        if self._may_run(identity):
            self._take(identity)
            return

        # Some lanes (notably public AI) deliberately keep ALL deferred work
        # in the caller's browser. max_waiters=0 must therefore mean exactly
        # zero, not "one per identity" through _waiting_share()'s floor.
        if self._max_waiters <= 0:
            raise AdmissionRejected(
                f"server at capacity ({self._running}/{self._limit} running; no server wait queue)",
                1,
            )

        # Two ceilings, and they answer different questions.
        #
        # The per-identity one is the fairness rule: it stops one person's
        # batch from owning the queue. The absolute one is the safety rule:
        # identity comes from the request, so a client that invents a new tab
        # session per image would otherwise mint unlimited identities and, with
        # them, an unlimited waiting list — the exact 2000-deep queue this
        # class exists to delete, rebuilt by accident.
        mine_waiting = self._waiting_by.get(identity, 0)
        if mine_waiting >= self._waiting_share() or self._waiting >= self._hard_waiting_cap:
            raise AdmissionRejected(
                f"server at capacity ({self._running}/{self._limit} running, "
                f"{self._waiting} waiting, share {self._share()} running / "
                f"{self._waiting_share()} waiting per identity)",
                self.retry_after_sec(),
            )

        future: asyncio.Future = asyncio.get_running_loop().create_future()
        entry = (identity, future)
        self._waiters.append(entry)
        self._waiting += 1
        self._waiting_by[identity] = self._waiting_by.get(identity, 0) + 1
        try:
            await asyncio.wait_for(future, timeout=self._max_wait_sec or None)
        except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
            # `wait_for` may have been cancelled after `_wake_next` already
            # reserved a slot for this waiter. Handing that slot straight on
            # keeps the count honest instead of leaking capacity.
            if future.done() and not future.cancelled() and future.exception() is None:
                self._give_back(identity)
                self._wake_next()
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise AdmissionRejected(
                f"waited {self._max_wait_sec:g}s for a slot "
                f"({self._running}/{self._limit} running, "
                f"share {self._share()} per identity)",
                self.retry_after_sec(),
            ) from exc
        finally:
            if entry in self._waiters:
                self._waiters.remove(entry)
            self._waiting = max(0, self._waiting - 1)
            left = self._waiting_by.get(identity, 0) - 1
            if left > 0:
                self._waiting_by[identity] = left
            else:
                self._waiting_by.pop(identity, None)

    def release(self, identity: str = ANONYMOUS, *, run_sec: float | None = None) -> None:
        """Give the slot back and fold the run time into the estimate.

        ``run_sec`` is keyword-only, and a non-string identity is a TypeError,
        because this signature used to be ``release(run_sec)``. A stale
        positional call would otherwise bind a float as the identity: the total
        count would still look right while the per-identity count leaked, and
        the fairness rule would quietly stop working with nothing to see.
        """
        if not isinstance(identity, str):
            raise TypeError(
                f"identity must be a str, got {type(identity).__name__} — "
                "release() now takes the identity first and run_sec by keyword"
            )
        saturated = self._waiting > 0 or self._running >= self._limit
        self._give_back(identity or ANONYMOUS)
        if run_sec is not None and run_sec > 0:
            self._adapt(float(run_sec), saturated)
            # Exponential moving average — recent jobs describe current load
            # better than the whole history does.
            self._avg_run_sec = (self._avg_run_sec * 0.8) + (float(run_sec) * 0.2)
        self._wake_next()

    class _Slot:
        def __init__(self, gate: "AdmissionGate", identity: str) -> None:
            self._gate = gate
            self._identity = identity or ANONYMOUS
            self._t0 = 0.0

        async def __aenter__(self) -> "AdmissionGate._Slot":
            await self._gate.acquire(self._identity)
            self._t0 = time.perf_counter()
            return self

        async def __aexit__(self, *_exc) -> bool:
            self._gate.release(self._identity, run_sec=time.perf_counter() - self._t0)
            return False

    def slot(self, identity: str = ANONYMOUS) -> "AdmissionGate._Slot":
        """``async with gate.slot(identity):`` — acquire, run, always release."""
        return AdmissionGate._Slot(self, identity)
