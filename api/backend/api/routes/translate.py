"""Translation job endpoints.

``POST /translate`` enqueues a job and returns its id immediately;
``GET /translate/{id}`` is polled by the extension until the job is done.
The async queue lives on ``app.state.job_queue`` (set up in ``main.py``).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from backend.jobs.queue import JobQueue, QueueFull
from backend.log import dbg, event

router = APIRouter()


def _job_queue(request: Request) -> JobQueue:
    return request.app.state.job_queue


@router.post("/translate")
async def translate(payload: dict[str, Any], request: Request) -> dict:
    """Enqueue a translation job. Returns ``{"id": <job_id>}``."""
    dbg(
        "rest.enqueue",
        {
            "mode": str(payload.get("mode") or ""),
            "lang": str(payload.get("lang") or ""),
            "source": str(payload.get("source") or ""),
            "has_datauri": bool(payload.get("imageDataUri")),
            "has_src": bool(payload.get("src")),
        },
    )
    try:
        job_id = await _job_queue(request).enqueue(payload)
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
    return {"id": job_id}


@router.get("/translate/{job_id}")
async def translate_status(job_id: str, request: Request) -> dict:
    """Return a job's status / result.

    ``status`` is one of ``queued`` / ``running`` / ``done`` / ``error``.
    """
    return _job_queue(request).get(job_id)
