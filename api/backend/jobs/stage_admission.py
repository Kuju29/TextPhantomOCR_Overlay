"""Shared stage admission for synchronous API/legacy pipeline workers.

The public runs:Extension routes can await :class:`AdmissionGate` directly.
The full runs:API and legacy pipelines execute in worker threads, so this small
bridge lets those same threads acquire the *same* Lens/Grouping/AI gate objects
owned by FastAPI.  There is one running count per stage for the entire process;
engine choice cannot mint extra capacity.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import threading
import time
from collections.abc import Iterator

from backend.jobs.admission import AdmissionGate, AdmissionRejected, ANONYMOUS

_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None
_loop_thread_id: int | None = None
_gates: dict[str, AdmissionGate] = {}


def configure(loop: asyncio.AbstractEventLoop, *, lens: AdmissionGate,
              grouping: AdmissionGate, ai: AdmissionGate) -> None:
    global _loop, _loop_thread_id, _gates
    with _lock:
        _loop = loop
        _loop_thread_id = threading.get_ident()
        _gates = {"lens": lens, "grouping": grouping, "ai": ai}


def clear() -> None:
    global _loop, _loop_thread_id, _gates
    with _lock:
        _loop = None
        _loop_thread_id = None
        _gates = {}


def configured() -> bool:
    return _loop is not None and bool(_gates)


@contextlib.contextmanager
def stage_slot(stage: str, identity: str = ANONYMOUS, *, unlimited: bool = False) -> Iterator[None]:
    """Synchronously acquire one shared API stage slot from a worker thread.

    CLI/offline callers intentionally become a no-op because no FastAPI event
    loop owns shared capacity there.  Local verified-unlimited requests keep the
    established bypass behavior.
    """
    gate = _gates.get(str(stage))
    loop = _loop
    if unlimited or gate is None or loop is None or loop.is_closed():
        yield
        return
    if threading.get_ident() == _loop_thread_id:
        raise RuntimeError("stage_slot must not block the API event-loop thread")

    identity = str(identity or ANONYMOUS)
    acquire_future = asyncio.run_coroutine_threadsafe(gate.acquire(identity), loop)
    try:
        # AdmissionGate owns the actual bounded wait. Add a small scheduling
        # margin only for the cross-thread handoff itself.
        wait_budget = max(2.0, float(getattr(gate, "_max_wait_sec", 0.0)) + 2.0)
        acquire_future.result(timeout=wait_budget)
    except concurrent.futures.TimeoutError as exc:
        acquire_future.cancel()
        rejected = AdmissionRejected(f"{stage} admission bridge timed out", gate.retry_after_sec())
        rejected.tp_stage = f"{stage}_admission"  # type: ignore[attr-defined]
        raise rejected from exc
    except AdmissionRejected as exc:
        exc.tp_stage = f"{stage}_admission"  # type: ignore[attr-defined]
        raise

    started = time.perf_counter()
    try:
        yield
    finally:
        run_sec = time.perf_counter() - started
        async def _release() -> None:
            gate.release(identity, run_sec=run_sec)
        release_future = asyncio.run_coroutine_threadsafe(_release(), loop)
        try:
            release_future.result(timeout=2.0)
        except Exception:
            # The process may be shutting down. Never turn a completed provider
            # request into a user-facing failure solely because release raced it.
            release_future.cancel()
