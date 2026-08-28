"""Translation job endpoints.


``POST /translate`` enqueues a job and returns its id immediately;
``GET /translate/{id}?wait=25`` is a long-poll status endpoint.  The async
queue lives on ``app.state.job_queue`` (set up in ``main.py``).
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request

from backend.jobs.queue import IdempotencyConflict, JobQueue, QueueFull
from backend.jobs.admission import identity_of
from backend.api.errors import payload as error_payload
from backend.log import dbg
from backend import cancellation

router = APIRouter()

# Batch poll limits: bound request size and response payload. Full results are
# large (background image + HTML), so only a few are inlined per response; the
# rest are flagged ``result_ready`` and fetched individually by the client.
_POLL_MAX_IDS = 200
_POLL_MAX_INLINE_RESULTS = 3


def _job_queue(request: Request) -> JobQueue:
    return request.app.state.job_queue


def _owner_scope(request: Request, payload: dict[str, Any]) -> str:
    """Return the stable, credential-independent owner of a legacy job.

    The extension deliberately omits provider credentials from cancellation
    requests.  Ownership therefore comes only from its tab session, falling
    back to network caller/Origin/Authorization for legacy clients.  Provider
    credentials belong in the idempotency scope, never in job ownership.
    """
    session = cancellation.scope_of(payload)
    if not session:
        session = str(request.headers.get("x-tp-tab-session") or "").strip()
    if not session:
        query = getattr(request, "query_params", None)
        session = str(query.get("tp_tab_session") or "").strip() if query is not None else ""
    client = request.client.host if request.client else "unknown"
    origin = str(request.headers.get("origin") or "")[:256]
    authorization = str(request.headers.get("authorization") or "")
    auth_hash = hashlib.sha256(authorization.encode("utf-8")).hexdigest() if authorization else ""
    caller = session or f"{client}|{origin}|{auth_hash}"
    return "o:" + hashlib.sha256(caller.encode("utf-8")).hexdigest()[:20]


def _idempotency_scope(request: Request, payload: dict[str, Any]) -> str:
    """Scope retries by owner *and* hashed provider credential identity."""
    opaque = f"{_owner_scope(request, payload)}|{identity_of(payload)}"
    return "i:" + hashlib.sha256(opaque.encode("utf-8")).hexdigest()[:20]


def _semantic_fingerprint(payload: dict[str, Any]) -> str:
    """Hash output-affecting legacy input while excluding transport metadata.

    Secrets and retry/correlation fields cannot affect whether a completed
    translation is the same semantic request, and must never enter retained
    idempotency state even in raw form.
    """
    def clean(value: Any, path: tuple[str, ...] = ()) -> Any:
        if isinstance(value, dict):
            out: dict[str, Any] = {}
            for raw_key, item in value.items():
                key = str(raw_key)
                lower = key.lower()
                if lower in {
                    "idempotency_key", "apikey", "api_key", "authorization",
                    "tp_trace", "request_id", "operationid", "batch_id",
                    "batchid", "tp_tab_session", "session",
                }:
                    continue
                if path == () and lower == "rate":
                    continue
                out[key] = clean(item, (*path, key))
            return out
        if isinstance(value, list):
            return [clean(item, path) for item in value]
        return value

    canonical = json.dumps(
        clean(payload), ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _idempotency_token(scope: str, raw_key: str) -> str:
    """Combine owner and retry key into one non-reversible queue key."""
    return hashlib.sha256(f"{scope}:{raw_key}".encode("utf-8")).hexdigest()


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
    owner_scope = _owner_scope(request, payload)
    idempotency_scope = _idempotency_scope(request, payload)
    try:
        meta = await _job_queue(request).enqueue(
            payload,
            idempotency_token=_idempotency_token(idempotency_scope, raw_key) if raw_key else "",
            request_fingerprint=_semantic_fingerprint(payload) if raw_key else "",
            caller_scope=owner_scope,
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
    """Cancel queued / rate-gate-waiting jobs.

    Body accepts any of: ``job_ids`` (list), ``batch_id`` (str),
    ``tp_tab_session`` / ``session`` (str). Jobs already running finish; jobs
    still queued or waiting for a provider slot are dropped so a closed tab
    stops consuming provider budget.
    """
    raw_ids = payload.get("job_ids") or payload.get("ids") or []
    if not isinstance(raw_ids, list):
        raw_ids = [raw_ids]
    batch_id = cancellation.batch_id_of(payload)
    session = cancellation.scope_of(payload)
    cancellation.mark_batch(batch_id, session)
    result = await _job_queue(request).cancel(
        job_ids=raw_ids,
        batch_id=batch_id,
        session=session,
        caller_scope=_owner_scope(request, payload),
    )
    dbg("rest.cancel", {**result, "batch_id": batch_id})
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
    caller_scope = _owner_scope(request, payload)
    await jq.wait_any(ids, wait_sec=wait, caller_scope=caller_scope)

    jobs: list[dict[str, Any]] = []
    inlined = 0
    for jid in ids:
        rec = jq.get_scoped(jid, caller_scope=caller_scope)
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
    return await _job_queue(request).wait(
        job_id, wait_sec=wait, caller_scope=_owner_scope(request, {}),
    )
