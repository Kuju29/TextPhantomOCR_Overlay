"""Bounded in-process idempotency for concurrent AI requests."""

from __future__ import annotations

from collections import OrderedDict

import threading, asyncio, time

MAX_ENTRIES = 512
TTL_SEC = 3600.0

_results: "OrderedDict[str, tuple[float, str, dict]]" = OrderedDict()
_inflight: dict[str, tuple[str, "asyncio.Future[dict | None]"]] = {}
_lock = threading.Lock()


def reserve(key: str, request_hash: str) -> tuple[str, dict | asyncio.Future | None]:
    """Return hit, mismatch, wait, or ownership atomically."""
    with _lock:
        hit = _results.get(key)
        if hit and time.time() - hit[0] <= TTL_SEC:
            _results.move_to_end(key)
            return ("hit", hit[2]) if hit[1] == request_hash else ("mismatch", None)
        if hit:
            _results.pop(key, None)
        pending = _inflight.get(key)
        if pending:
            return ("wait", pending[1]) if pending[0] == request_hash else ("mismatch", None)
        future = asyncio.get_running_loop().create_future()
        _inflight[key] = (request_hash, future)
        return "owner", future

def store(key: str, request_hash: str, value: dict) -> None:
    with _lock:
        _results[key] = (time.time(), request_hash, value)
        _results.move_to_end(key)
        while len(_results) > MAX_ENTRIES:
            _results.popitem(last=False)
        pending = _inflight.pop(key, None)
        if pending and pending[0] == request_hash and not pending[1].done():
            pending[1].set_result(value)

def release(key: str, request_hash: str, future: asyncio.Future) -> None:
    """Wake waiters after owner failure so exactly one may retry."""
    with _lock:
        current = _inflight.get(key)
        if current and current[0] == request_hash and current[1] is future:
            _inflight.pop(key, None)
            if not future.done():
                future.set_result(None)

def clear() -> None:
    """Reset state for isolated tests."""
    with _lock:
        _results.clear()
        _inflight.clear()
