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

from backend.ai import content_stream
from backend.ai.clients.base import ProviderGenerationCancelled

SCHEMA = "tp.ai.stream/1"


async def respond(request: Request, invoke: Callable[..., Awaitable[dict]]):
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

    async def terminal(event):
        while not stopped.is_set():
            try:
                await asyncio.wait_for(events.put(event), timeout=0.1)
                return
            except asyncio.TimeoutError:
                continue

    async def produce():
        try:
            with content_stream.scope(deliver, cancel_event):
                body = await invoke(cancel_check=stopped.is_set)
            if not stopped.is_set():
                await terminal(("result", body))
        except Exception as exc:
            if not stopped.is_set():
                await terminal(("error", exc))

    producer = asyncio.create_task(produce())

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
            raise asyncio.CancelledError()
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
                if kind != "delta":
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
