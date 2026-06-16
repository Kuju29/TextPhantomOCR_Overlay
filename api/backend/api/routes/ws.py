"""WebSocket job-event endpoint.

The socket is now an event channel for the same shared queue used by REST.
Clients should submit jobs with REST for the fastest first response, then
``subscribe`` to the returned job id.  For backward compatibility, the socket
also accepts old ``job`` messages, but those are enqueued instead of run inline.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.jobs.queue import JobQueue, QueueFull
from backend.log import dbg, event

router = APIRouter()


def _job_ids(data: dict) -> list[str]:
    ids: list[str] = []
    raw = data.get("ids") if "ids" in data else data.get("id")
    if isinstance(raw, list):
        ids = [str(x or "").strip() for x in raw]
    else:
        ids = [str(raw or "").strip()]
    return [x for x in ids if x]


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    """Handle one event-channel WebSocket connection."""
    await ws.accept()
    job_queue: JobQueue = ws.app.state.job_queue
    event_q = job_queue.create_event_queue()
    subscribed: set[str] = set()

    async def send_loop() -> None:
        while True:
            msg = await event_q.get()
            await ws.send_text(json.dumps(msg))

    sender = asyncio.create_task(send_loop())
    try:
        await ws.send_text(json.dumps({"type": "ack", "mode": "events"}))

        while True:
            data = json.loads(await ws.receive_text())
            msg_type = str(data.get("type") or "").strip().lower()

            if msg_type in ("ping", "keepalive"):
                await ws.send_text(json.dumps({"type": "pong"}))
                continue

            if msg_type in ("subscribe", "sub"):
                for jid in _job_ids(data):
                    subscribed.add(jid)
                    job_queue.subscribe(event_q, jid)
                    # Send the current state immediately so a result that
                    # finished before subscribe is not missed.
                    rec = job_queue.get(jid)
                    if rec.get("status") == "done":
                        await ws.send_text(json.dumps({"type": "result", "id": jid, "result": rec.get("result")}))
                    elif rec.get("status") == "error":
                        await ws.send_text(json.dumps({"type": "error", "id": jid, "error": rec.get("result") or "Unknown error"}))
                    else:
                        await ws.send_text(json.dumps({
                            "type": "job.status",
                            "id": jid,
                            "status": rec.get("status"),
                            "queue_position": rec.get("queue_position"),
                            "queue_depth": rec.get("queue_depth"),
                            "poll_after_ms": rec.get("poll_after_ms"),
                            "recommended_client_concurrency": rec.get("recommended_client_concurrency"),
                        }))
                continue

            if msg_type in ("unsubscribe", "unsub"):
                for jid in _job_ids(data):
                    subscribed.discard(jid)
                    job_queue.unsubscribe(event_q, jid)
                continue

            if msg_type == "job":
                # Backward-compatible path: do NOT run inline.  Enqueue through
                # the same queue/backpressure as REST and subscribe to updates.
                payload = data.get("payload") or {}
                client_id = str(data.get("id") or "").strip()
                idem = str(data.get("idempotency_key") or client_id or payload.get("idempotency_key") or "").strip()
                try:
                    meta = await job_queue.enqueue(payload, idempotency_key=idem or None)
                except QueueFull as exc:
                    await ws.send_text(json.dumps({"type": "error", "id": client_id, "error": str(exc)}))
                    event("ws.translate.busy", {"error": str(exc)}, ok=False)
                    continue
                jid = str(meta.get("id") or "")
                if jid:
                    subscribed.add(jid)
                    job_queue.subscribe(event_q, jid)
                dbg("ws.job.enqueued", {"client_id": client_id, "job_id": jid})
                await ws.send_text(json.dumps({"type": "submitted", "client_id": client_id, **meta}))
                continue

            await ws.send_text(json.dumps({"type": "error", "error": "unknown ws message type"}))
    except WebSocketDisconnect:
        return
    finally:
        sender.cancel()
        job_queue.close_event_queue(event_q)
        try:
            await sender
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
