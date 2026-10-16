"""Shared stage admission for synchronous API/legacy pipeline workers.

The public runs:Extension routes await :class:`AdmissionGate` directly. The
full runs:API and legacy pipelines execute in worker threads, so this bridge
lets those threads use the *same* Lens/Grouping/AI gate objects owned by the
FastAPI event loop. There is one running count per stage for the entire
process; engine choice cannot mint extra capacity.

Two ways in:

* :func:`reserve` (async, on the loop): wait for a slot WITHOUT holding a worker
  thread and get a :class:`SlotTicket`. runs:API reserves its Lens slot this
  way before it takes a pipeline thread, then hands the ticket to the thread.
* :func:`stage_slot` (sync, in a worker thread): use a handed-over ticket, or
  wait for a slot from the thread (grouping/AI inside the pipeline, legacy
  queue workers). There is no deadline: the wait ends when a slot is granted
  or ``cancel_check()`` turns true (client gone / batch cancelled).
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import functools
import threading
import time
from collections.abc import Callable, Iterator

from backend.jobs.admission import (
    Admission, AdmissionCancelled, AdmissionGate, AdmissionRejected, ANONYMOUS, fair_key,
)

_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None
_loop_thread_id: int | None = None
_gates: dict[str, AdmissionGate] = {}


def configure(loop: asyncio.AbstractEventLoop, **gates: AdmissionGate) -> None:
    """Register the loop and its stage gates (lens, grouping, ai, ...)."""
    global _loop, _loop_thread_id, _gates
    with _lock:
        _loop = loop
        _loop_thread_id = threading.get_ident()
        _gates = {str(name): gate for name, gate in gates.items() if gate is not None}


def clear() -> None:
    global _loop, _loop_thread_id, _gates
    with _lock:
        _loop = None
        _loop_thread_id = None
        _gates = {}


def configured() -> bool:
    return _loop is not None and bool(_gates)


def gate(stage: str) -> AdmissionGate | None:
    return _gates.get(str(stage))


def _release_on_loop(gate_obj: AdmissionGate, key: str, run_sec: float,
                     loop: asyncio.AbstractEventLoop | None) -> None:
    """Give a slot back from any thread; the gate itself is mutated on its loop."""
    release = functools.partial(gate_obj.release, key, run_sec=run_sec)
    if loop is None or loop.is_closed():
        return  # shutting down: nothing will ever wait on this gate again
    if threading.get_ident() == _loop_thread_id:
        release()
        return
    try:
        loop.call_soon_threadsafe(release)
    except RuntimeError:
        pass  # loop closed between the check and the call


class SlotTicket:
    """One slot reserved on the event loop, owned by exactly one releaser.

    The async side creates it; a worker thread may ``claim()`` it and then
    releases it when its stage ends. If the thread never claims it (cache hit,
    early failure, executor shutdown) the async side ``abandon()``s it. Both
    paths are idempotent, so the slot is released exactly once.
    """

    def __init__(self, stage: str, gate_obj: AdmissionGate, key: str,
                 loop: asyncio.AbstractEventLoop, admission: Admission) -> None:
        self.stage = stage
        self.key = key
        self.admission = admission
        self._gate = gate_obj
        self._loop = loop
        self._mutex = threading.Lock()
        self._claimed = False
        self._released = False
        self._t0 = time.perf_counter()

    @property
    def released(self) -> bool:
        return self._released

    def claim(self) -> bool:
        """Called by the worker thread before using the slot."""
        with self._mutex:
            if self._released or self._claimed:
                return False
            self._claimed = True
            return True

    def release(self) -> None:
        with self._mutex:
            if self._released:
                return
            self._released = True
        _release_on_loop(self._gate, self.key, time.perf_counter() - self._t0, self._loop)

    def abandon(self) -> None:
        """Async-side cleanup: release unless a thread claimed it (the thread releases)."""
        with self._mutex:
            if self._claimed or self._released:
                return
            self._released = True
        _release_on_loop(self._gate, self.key, time.perf_counter() - self._t0, self._loop)


async def reserve(stage: str, identity: str = ANONYMOUS, *,
                  cancel_check: Callable[[], bool] | None = None,
                  nbytes: int = 0) -> SlotTicket | None:
    """Wait on the loop (no thread held) for a slot and return its ticket."""
    gate_obj = _gates.get(str(stage))
    if gate_obj is None:
        return None
    key = fair_key(identity)
    try:
        admission = await gate_obj.acquire(key, cancel_check=cancel_check, nbytes=nbytes)
    except (AdmissionRejected, AdmissionCancelled) as exc:
        exc.tp_stage = f"{stage}_admission"  # type: ignore[attr-defined]
        raise
    return SlotTicket(str(stage), gate_obj, key, asyncio.get_running_loop(), admission)


@contextlib.contextmanager
def stage_slot(stage: str, identity: str = ANONYMOUS, *, unlimited: bool = False,
               cancel_check: Callable[[], bool] | None = None,
               held: SlotTicket | None = None,
               stats: dict | None = None) -> Iterator[None]:
    """Hold one shared API stage slot for the body, from a worker thread.

    ``held`` — a ticket for this stage reserved before the thread started; it
    is used instead of waiting and released when the body ends.
    ``stats`` — receives ``<stage>_wait_ms`` / ``<stage>_queue_position``.
    CLI/offline callers become a no-op because no FastAPI loop owns capacity.
    """
    if held is not None and held.stage == stage and held.claim():
        if stats is not None:
            stats[f"{stage}_wait_ms"] = held.admission.wait_ms
            stats[f"{stage}_queue_position"] = held.admission.queue_position
        try:
            yield
        finally:
            held.release()
        return
    gate_obj = _gates.get(str(stage))
    loop = _loop
    if unlimited or gate_obj is None or loop is None or loop.is_closed():
        yield
        return
    if threading.get_ident() == _loop_thread_id:
        raise RuntimeError("stage_slot must not block the API event-loop thread")

    key = fair_key(identity)
    acquire_future = asyncio.run_coroutine_threadsafe(
        gate_obj.acquire(key, cancel_check=cancel_check), loop)
    while True:
        try:
            admission = acquire_future.result(timeout=1.0)
            break
        except concurrent.futures.TimeoutError:
            # No deadline: keep waiting while the loop lives. The gate itself
            # polls cancel_check and removes the waiter when the owner leaves.
            if loop.is_closed() or not loop.is_running():
                acquire_future.cancel()
                cancelled = AdmissionCancelled(f"{stage}: event loop stopped while waiting")
                cancelled.tp_stage = f"{stage}_admission"  # type: ignore[attr-defined]
                raise cancelled
        except (AdmissionRejected, AdmissionCancelled) as exc:
            exc.tp_stage = f"{stage}_admission"  # type: ignore[attr-defined]
            raise
        except concurrent.futures.CancelledError as exc:
            cancelled = AdmissionCancelled(f"{stage}: wait cancelled")
            cancelled.tp_stage = f"{stage}_admission"  # type: ignore[attr-defined]
            raise cancelled from exc
    if stats is not None:
        stats[f"{stage}_wait_ms"] = admission.wait_ms
        stats[f"{stage}_queue_position"] = admission.queue_position

    started = time.perf_counter()
    try:
        yield
    finally:
        _release_on_loop(gate_obj, key, time.perf_counter() - started, loop)
