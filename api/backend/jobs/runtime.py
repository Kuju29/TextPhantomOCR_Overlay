"""Shared runtime admission for CPU-heavy job stages."""

from __future__ import annotations

from collections.abc import Iterator

import threading, contextlib

from backend.config import settings
from backend.utils.cpu_runtime import effective_cpu_count

CPU_SLOTS = max(1, min(settings.cpu_concurrency, effective_cpu_count()))
CPU_GATE = threading.Semaphore(CPU_SLOTS)

@contextlib.contextmanager
def cpu_slot() -> Iterator[None]:
    CPU_GATE.acquire()
    try:
        yield
    finally:
        CPU_GATE.release()
