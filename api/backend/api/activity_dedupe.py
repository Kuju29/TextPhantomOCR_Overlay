"""Small process-local transition dedupe for activity-only diagnostics."""
from __future__ import annotations

from collections import OrderedDict
from threading import Lock
import time
from typing import Hashable


class TransitionDedupe:
    def __init__(self, *, max_entries: int = 1024, ttl_sec: float = 3600.0,
                 clock=time.monotonic) -> None:
        self._max = max(1, int(max_entries))
        self._ttl = max(1.0, float(ttl_sec))
        self._clock = clock
        self._items: OrderedDict[str, tuple[float, Hashable]] = OrderedDict()
        self._lock = Lock()

    def changed(self, key: str, signature: Hashable, *, terminal: bool = False) -> bool:
        now = self._clock()
        with self._lock:
            cutoff = now - self._ttl
            while self._items and next(iter(self._items.values()))[0] < cutoff:
                self._items.popitem(last=False)
            previous = self._items.pop(key, None)
            changed = previous is None or previous[1] != signature
            if not terminal:
                self._items[key] = (now, signature)
                while len(self._items) > self._max:
                    self._items.popitem(last=False)
            return changed

    def discard(self, key: str) -> None:
        with self._lock:
            self._items.pop(key, None)

    def size(self) -> int:
        with self._lock:
            return len(self._items)
