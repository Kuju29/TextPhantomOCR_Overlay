"""Opt-in NDJSON delivery around the same authoritative translation execution.

Content events are provisional. Only result/error ends a request. The provider
continues to its protocol terminal so accounting and Conversation stay intact.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import threading
from collections.abc import Awaitable, Callable

from fastapi import HTTPException, Request
from starlette.responses import StreamingResponse
from starlette.requests import ClientDisconnect

from backend.ai import content_stream
from backend.ai.clients.base import ProviderGenerationCancelled

SCHEMA = "tp.ai.stream/1"
# A client that sends this header accepts `progress` rows (stream phase:
# waiting / thinking / writing / stalled / stopping). Older extensions reject
# unknown row types, so the API never sends them unasked.
PHASES_HEADER = "x-tp-stream-phases"
_PHASE_FIELDS = ("phase", "phaseElapsedMs", "elapsedMs", "linesDone", "linesTotal",
                 "thinkingLimitMs", "keepalive", "reason")
_PHASES = {"waiting", "thinking", "writing", "stalled", "stopping"}


def phases_requested(request: Request) -> bool:
    return str(request.headers.get(PHASES_HEADER, "")).strip() == "1"


def progress_row(event: dict) -> dict | None:
    """Bounded, content-free projection of one guard snapshot."""
    if not isinstance(event, dict) or event.get("phase") not in _PHASES:
        return None
    row = {}
    for name in _PHASE_FIELDS:
        value = event.get(name)
        if name == "phase" or name == "reason":
            if isinstance(value, str) and value:
                row[name] = value[:40]
        elif name == "keepalive":
            if value is True:
                row[name] = True
        elif type(value) is int and 0 <= value <= 86_400_000:
            row[name] = value
    return row


async def until_disconnect(request: Request, invoke: Callable[..., Awaitable[dict]]):
    """A plain JSON translation stops when its caller is gone.

    The body is already parsed, so the next ASGI message is the client's
    disconnect; otherwise the request would hold its admission slot and spend
    tokens nobody receives. The flag feeds the same cancel_check as
    /translate/cancel: a queued request leaves the queue, a provider stream is
    closed, a Login website wait ends. Paid work already dispatched to the
    Center is settled by the Center."""
    gone = threading.Event()

    async def watch():
        while True:
            message = await request.receive()
            if message["type"] == "http.disconnect":
                gone.set()
                return

    watcher = asyncio.create_task(watch())
    try:
        return await invoke(cancel_check=gone.is_set)
    finally:
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)


async def respond(request: Request, invoke: Callable[..., Awaitable[dict]], *, phases: bool = False):
    loop = asyncio.get_running_loop()
    events: asyncio.Queue = asyncio.Queue(maxsize=128)
    stopped = threading.Event()
    cancel_event = asyncio.Event()

    def stop():
        stopped.set()
        cancel_event.set()

    def deliver(text: str) -> None:
        if stopped.is_set():
            raise ProviderGenerationCancelled("Translation stream disconnected")
        pending = asyncio.run_coroutine_threadsafe(events.put(("delta", text)), loop)
        try:
            while True:
                try:
                    pending.result(timeout=0.1)
                    return
                except concurrent.futures.TimeoutError:
                    if stopped.is_set():
                        raise ProviderGenerationCancelled("Translation stream disconnected")
        finally:
            if not pending.done():
                pending.cancel()

    def report(event: dict) -> None:
        # Called from transport reader/watcher threads. Never blocks or raises:
        # a full queue drops a progress row (the next one supersedes it).
        row = progress_row(event)
        if row is None or stopped.is_set():
            return

        def put():
            try:
                events.put_nowait(("progress", row))
            except asyncio.QueueFull:
                pass
        try:
            loop.call_soon_threadsafe(put)
        except RuntimeError:
            pass  # Loop closed: the response is already gone.

    async def terminal(event):
        while not stopped.is_set():
            try:
                await asyncio.wait_for(events.put(event), timeout=0.1)
                return
            except asyncio.TimeoutError:
                continue

    async def produce():
        try:
            with content_stream.scope(deliver, cancel_event, report if phases else None):
                body = await invoke(cancel_check=stopped.is_set)
            if not stopped.is_set():
                await terminal(("result", body))
        except Exception as exc:
            if not stopped.is_set():
                await terminal(("error", exc))

    _producer = asyncio.create_task(produce())  # held so the task is not garbage-collected

    async def disconnected():
        while True:
            message = await request.receive()
            if message["type"] == "http.disconnect":
                return

    # Preserve ordinary HTTP validation/admission errors before any content was
    # delivered. Monitor disconnect here; StreamingResponse owns it afterwards.
    disconnect = asyncio.create_task(disconnected())
    first_event = asyncio.create_task(events.get())
    try:
        done, _ = await asyncio.wait((first_event, disconnect), return_when=asyncio.FIRST_COMPLETED)
        if disconnect in done:
            stop()
            raise ClientDisconnect()
        first = first_event.result()
    except BaseException:
        stop()
        raise
    finally:
        disconnect.cancel()
        first_event.cancel()
        await asyncio.gather(disconnect, first_event, return_exceptions=True)
    if first[0] == "error":
        raise first[1]

    async def body_stream():
        event = first
        sequence = 0
        try:
            while True:
                kind, value = event
                sequence += 1
                row = {"schema": SCHEMA, "sequence": sequence, "type": kind}
                if kind == "delta":
                    row["text"] = value
                elif kind == "progress":
                    row.update(value)
                elif kind == "result":
                    row["body"] = value
                else:
                    status = value.status_code if isinstance(value, HTTPException) else 500
                    detail = value.detail if isinstance(value, HTTPException) else {
                        "code": "ai_stream_execution_failed", "message": "Translation execution failed",
                        "origin": "api", "stage": "translation_stream", "retryable": False,
                    }
                    row.update(status=status, body={"detail": detail})
                yield json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
                if kind not in ("delta", "progress"):
                    break
                event = await events.get()
        finally:
            stop()
            # Do not cancel the execution coroutine: its executor thread must
            # unwind cooperatively before releasing admission/history ownership.

    class OwnedStreamingResponse(StreamingResponse):
        async def __call__(self, scope, receive, send):
            try:
                await super().__call__(scope, receive, send)
            finally:
                stop()

    return OwnedStreamingResponse(body_stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
