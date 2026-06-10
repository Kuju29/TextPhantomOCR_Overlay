"""WebSocket translation endpoint.

An alternative to the poll-based REST flow: the client sends
``{"type": "job", "id": ..., "payload": {...}}`` and gets back
``{"type": "result", ...}`` or ``{"type": "error", ...}``.  Each job runs
inline (in a worker thread) rather than going through the shared queue.
"""

from __future__ import annotations

import json
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.jobs.queue import JobQueue
from backend.log import dbg, event

router = APIRouter()


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    """Handle a translation WebSocket connection until the client disconnects."""
    await ws.accept()
    await ws.send_text(json.dumps({"type": "ack"}))

    job_queue: JobQueue = ws.app.state.job_queue

    try:
        while True:
            data = json.loads(await ws.receive_text())
            if data.get("type") != "job":
                continue

            job_id = str(data.get("id") or "")
            payload = data.get("payload") or {}
            summary = {
                "job_id": job_id,
                "mode": str(payload.get("mode") or ""),
                "lang": str(payload.get("lang") or ""),
                "source": str(payload.get("source") or ""),
            }
            dbg("ws.job", summary)
            t0 = time.perf_counter()
            try:
                result = await job_queue.run_inline(payload)
                await ws.send_text(json.dumps({"type": "result", "id": job_id, "result": result}))
                event("ws.translate.done", {**summary, "dt_ms": round((time.perf_counter() - t0) * 1000, 1)})
            except WebSocketDisconnect:
                return
            except Exception as e:  # noqa: BLE001 - report errors to the client
                event(
                    "ws.translate.error",
                    {
                        **summary,
                        "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
                        "error": str(e)[:240],
                    },
                    ok=False,
                )
                try:
                    await ws.send_text(json.dumps({"type": "error", "id": job_id, "error": str(e)}))
                except (WebSocketDisconnect, RuntimeError):
                    return
    except WebSocketDisconnect:
        return
