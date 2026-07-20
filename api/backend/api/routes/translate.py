"""Translation job endpoints.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

``POST /translate`` enqueues a job and returns its id immediately;
``GET /translate/{id}?wait=25`` is a long-poll status endpoint.  The async
queue lives on ``app.state.job_queue`` (set up in ``main.py``).
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request

from backend.jobs.queue import JobQueue, QueueFull
from backend.log import dbg, event

router = APIRouter()

# Batch poll limits: bound request size and response payload. Full results are
# large (background image + HTML), so only a few are inlined per response; the
# rest are flagged ``result_ready`` and fetched individually by the client.
_POLL_MAX_IDS = 200
_POLL_MAX_INLINE_RESULTS = 3


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


@router.post("/translate/cancel")
async def translate_cancel(payload: dict[str, Any], request: Request) -> dict:
    """Cancel queued / rate-gate-waiting jobs.

    Body accepts any of: ``job_ids`` (list), ``batch_id`` (str),
    ``tp_tab_session`` / ``session`` (str). Jobs already running finish; jobs
    still queued or waiting for a provider slot are dropped so a closed tab
    stops consuming provider budget.
    """
    raw_ids = payload.get("job_ids") or payload.get("ids") or []
    if not isinstance(raw_ids, list):
        raw_ids = [raw_ids]
    result = await _job_queue(request).cancel(
        job_ids=raw_ids,
        batch_id=str(payload.get("batch_id") or ""),
        session=str(payload.get("tp_tab_session") or payload.get("session") or ""),
    )
    dbg("rest.cancel", {**result, "batch_id": str(payload.get("batch_id") or "")})
    return result


@router.post("/translate/poll")
async def translate_poll(payload: dict[str, Any], request: Request) -> dict:
    """Batch long-poll: one request tracks a whole batch of jobs.

    Body: ``{"ids": [...], "wait": 20, "max_results": 3}``. Waits until at
    least one id is terminal (or timeout), then returns every id's status.
    ``done`` jobs beyond ``max_results`` omit the (large) result payload and
    carry ``result_ready: true`` — the client fetches those individually via
    ``GET /translate/{id}`` (instant, the result is already available).

    This replaces N per-job long-poll connections with 1 request per batch,
    which is the main client-side result-latency fix for large batches.
    """
    raw_ids = payload.get("ids") or []
    if not isinstance(raw_ids, list):
        raw_ids = [raw_ids]
    ids = [str(j) for j in raw_ids if str(j or "").strip()][:_POLL_MAX_IDS]
    if not ids:
        return {"jobs": [], "server_time": time.time()}

    wait = float(payload.get("wait") or 0.0)
    try:
        max_inline = int(payload.get("max_results") or _POLL_MAX_INLINE_RESULTS)
    except (TypeError, ValueError):
        max_inline = _POLL_MAX_INLINE_RESULTS
    max_inline = max(1, min(10, max_inline))

    jq = _job_queue(request)
    await jq.wait_any(ids, wait_sec=wait)

    jobs: list[dict[str, Any]] = []
    inlined = 0
    for jid in ids:
        rec = jq.get(jid)
        if str(rec.get("status") or "") == "done" and rec.get("result") is not None:
            if inlined < max_inline:
                inlined += 1
            else:
                rec = {k: v for k, v in rec.items() if k != "result"}
                rec["result_ready"] = True
        jobs.append(rec)
    return {"jobs": jobs, "server_time": time.time()}


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
