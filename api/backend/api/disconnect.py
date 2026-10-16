"""Notice when the HTTP client goes away, so queued work is not wasted.

The waiting queue has no count limit and no deadline (backend/jobs/admission.py),
so a request whose client gave up (tab closed, extension timeout, user
cancelled) must leave the queue by itself. :class:`DisconnectWatch` listens on
the ASGI ``receive`` channel after the body has been read: the next message the
server can deliver is ``http.disconnect``. When it arrives the watch flips
``gone`` and, when given the request payload, marks it in
``backend.cancellation`` so every existing ``is_cancelled(payload)`` check
(gate waiters, rate gate, pipeline stage boundaries) stops the work.

:class:`ClientDisconnected` is answered by an app exception handler with a 499
that nobody reads but the log does (``request.client_disconnected``), instead of
a generic error line.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from backend import cancellation


class ClientDisconnected(Exception):
    """The HTTP client is gone; the answer is a logged 499."""

    def __init__(self, stage: str = "request", *, waited_ms: float | None = None,
                 detail: str = "") -> None:
        super().__init__(f"client disconnected during {stage}")
        self.stage = stage
        self.waited_ms = waited_ms
        self.detail = detail


class DisconnectWatch:
    """``async with DisconnectWatch(request, payload) as watch: ... watch.gone``."""

    def __init__(self, request: Any, payload: Any = None) -> None:
        self._request = request
        self._payload = payload
        self._task: asyncio.Task | None = None
        self.gone = False
        self.gone_at: float | None = None
        self.started = time.perf_counter()

    def check(self) -> bool:
        """Sync predicate for gate waiters: client gone or batch cancelled."""
        if self.gone:
            return True
        return bool(self._payload is not None and cancellation.is_cancelled(self._payload))

    async def _listen(self) -> None:
        receive = getattr(self._request, "receive", None)
        if receive is None:
            return
        try:
            while True:
                message = await receive()
                if message.get("type") == "http.disconnect":
                    self.gone = True
                    self.gone_at = time.perf_counter()
                    if self._payload is not None:
                        cancellation.mark_gone(self._payload)
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            # A receive channel that cannot be read (test client, closed
            # transport) simply means no disconnect evidence.
            return

    async def __aenter__(self) -> "DisconnectWatch":
        self._task = asyncio.create_task(self._listen(), name="tp-disconnect-watch")
        return self

    async def __aexit__(self, *_exc) -> bool:
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except BaseException:
                pass
        if self._payload is not None:
            cancellation.forget_gone(self._payload)
        return False


def request_body_bytes(request: Any, payload: Any = None) -> int:
    """Bytes this request keeps in memory while it waits (body size)."""
    try:
        declared = int(getattr(request, "headers", {}).get("content-length") or 0)
    except (TypeError, ValueError):
        declared = 0
    if declared > 0:
        return declared
    if isinstance(payload, dict):
        return sum(len(str(payload.get(k) or "")) for k in ("imageDataUri", "src")) + 1024
    return 0
