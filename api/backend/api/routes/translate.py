"""Translation job endpoints.

``POST /translate`` enqueues a job and returns its id immediately;
``GET /translate/{id}?wait=25`` is a long-poll status endpoint.  The async
queue lives on ``app.state.job_queue`` (set up in ``main.py``).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request

from backend.jobs.queue import JobQueue, QueueFull
from backend.log import dbg, event

router = APIRouter()


def _job_queue(request: Request) -> JobQueue:
    return request.app.state.job_queue


@router.post("/translate")
async def translate(
    payload: dict[str, Any],
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    """Enqueue a translation job. Returns ``{"id": <job_id>}`` plus hints."""
    dbg(
        "rest.enqueue",
        {
            "mode": str(payload.get("mode") or ""),
            "lang": str(payload.get("lang") or ""),
            "source": str(payload.get("source") or ""),
            "has_datauri": bool(payload.get("imageDataUri")),
            "has_src": bool(payload.get("src")),
            "idem": bool(idempotency_key or payload.get("idempotency_key")),
        },
    )
    try:
        meta = await _job_queue(request).enqueue(payload, idempotency_key=idempotency_key)
    except QueueFull as exc:
        event(
            "translate.busy",
            {
                "mode": str(payload.get("mode") or ""),
                "lang": str(payload.get("lang") or ""),
                "source": str(payload.get("source") or ""),
                "error": str(exc),
            },
            ok=False,
        )
        # 503 + Retry-After so the client can back off instead of failing hard.
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": "5"},
        ) from exc
    return meta


@router.get("/translate/{job_id}")
async def translate_status(
    job_id: str,
    request: Request,
    wait: float = Query(default=0.0, ge=0.0, le=25.0),
) -> dict:
    """Return a job's status / result.

    ``status`` is one of ``queued`` / ``running`` / ``done`` / ``error``.
    Passing ``wait`` turns this into a long-poll endpoint: the server waits
    until the job status changes or the timeout elapses.
    """
    return await _job_queue(request).wait(job_id, wait_sec=wait)
