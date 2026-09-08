"""Translation job endpoints.

``POST /translate`` enqueues a job and returns its id immediately;
``GET /translate/{id}?wait=25`` is a long-poll status endpoint.  The async
queue lives on ``app.state.job_queue`` (set up in ``main.py``).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request

from backend.jobs.queue import IdempotencyConflict, JobQueue, QueueFull
from backend.application import legacy_translation
from backend.api.errors import payload as error_payload
from backend.log import dbg
from backend import cancellation

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
    raw_key = str(idempotency_key or payload.get("idempotency_key") or "").strip()
    policy = legacy_translation.enqueue_policy(request, payload, raw_key)
    try:
        meta = await _job_queue(request).enqueue(
            payload,
            idempotency_token=policy.idempotency_token,
            request_fingerprint=policy.request_fingerprint,
            caller_scope=policy.owner_scope,
        )
    except IdempotencyConflict as exc:
        message = str(exc)
        raise HTTPException(status_code=409, detail=error_payload(
            code="idempotency_conflict",
            message=message,
            user_message=message,
            origin="client",
            stage="idempotency",
            category="input",
            retryable=False,
            http_status=409,
        )) from exc
    except QueueFull as exc:
        # 503 + Retry-After so the client can back off instead of failing hard.
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": "5"},
        ) from exc
    return meta

@router.post("/translate/cancel")
async def translate_cancel(payload: dict[str, Any], request: Request) -> dict:
    """Cancel selected queued, gate-waiting, or running jobs."""
    raw_ids, batch_id, session = legacy_translation.cancellation_selector(payload)
    cancellation.mark_batch(batch_id, session)
    result = await _job_queue(request).cancel(
        job_ids=raw_ids,
        batch_id=batch_id,
        session=session,
        caller_scope=legacy_translation.owner_scope(request, payload),
    )
    dbg("rest.cancel", {**result, "batch_id": batch_id})
    return result

@router.post("/translate/poll")
async def translate_poll(payload: dict[str, Any], request: Request) -> dict:
    """Long-poll a bounded batch and inline a bounded number of results."""
    ids = legacy_translation.poll_ids(payload)
    wait = float(payload.get("wait") or 0.0)
    jq = _job_queue(request)
    return await legacy_translation.poll_jobs(
        jq, ids, wait=wait,
        caller_scope=legacy_translation.owner_scope(request, payload),
        max_inline=legacy_translation.poll_inline_limit(payload),
    )

@router.get("/translate/{job_id}")
async def translate_status(
    job_id: str,
    request: Request,
    wait: float = Query(default=0.0, ge=0.0, le=25.0),
) -> dict:
    """Return status/result, optionally waiting for a state change."""
    return await _job_queue(request).wait(
        job_id, wait_sec=wait, caller_scope=legacy_translation.owner_scope(request, {}),
    )
