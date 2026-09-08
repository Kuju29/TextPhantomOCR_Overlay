"""Application policy for the legacy queued translation endpoints."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import json, hashlib, time

from backend import cancellation
from backend.jobs.admission import identity_of

POLL_MAX_IDS = 200
POLL_MAX_INLINE_RESULTS = 3

def owner_scope(request: Any, payload: dict[str, Any]) -> str:
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

def idempotency_scope(request: Any, payload: dict[str, Any]) -> str:
    opaque = f"{owner_scope(request, payload)}|{identity_of(payload)}"
    return "i:" + hashlib.sha256(opaque.encode("utf-8")).hexdigest()[:20]

def semantic_fingerprint(payload: dict[str, Any]) -> str:
    excluded = {
        "idempotency_key", "apikey", "api_key", "authorization", "tp_trace",
        "request_id", "operationid", "batch_id", "batchid", "tp_tab_session", "session",
    }

    def clean(value: Any, path: tuple[str, ...] = ()) -> Any:
        if isinstance(value, dict):
            output: dict[str, Any] = {}
            for raw_key, item in value.items():
                key = str(raw_key)
                if key.lower() in excluded or (not path and key.lower() == "rate"):
                    continue
                output[key] = clean(item, (*path, key))
            return output
        if isinstance(value, list):
            return [clean(item, path) for item in value]
        return value

    canonical = json.dumps(clean(payload), ensure_ascii=False, sort_keys=True,
                           separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

def idempotency_token(scope: str, raw_key: str) -> str:
    return hashlib.sha256(f"{scope}:{raw_key}".encode("utf-8")).hexdigest()

@dataclass(frozen=True, slots=True)
class EnqueuePolicy:
    owner_scope: str
    idempotency_token: str
    request_fingerprint: str

def enqueue_policy(request: Any, payload: dict[str, Any], raw_key: str) -> EnqueuePolicy:
    owner = owner_scope(request, payload)
    if not raw_key:
        return EnqueuePolicy(owner, "", "")
    scope = idempotency_scope(request, payload)
    return EnqueuePolicy(owner, idempotency_token(scope, raw_key), semantic_fingerprint(payload))

def poll_ids(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("ids") or []
    if not isinstance(raw, list):
        raw = [raw]
    return [str(item) for item in raw if str(item or "").strip()][:POLL_MAX_IDS]

def poll_inline_limit(payload: dict[str, Any]) -> int:
    try:
        requested = int(payload.get("max_results") or POLL_MAX_INLINE_RESULTS)
    except (TypeError, ValueError):
        requested = POLL_MAX_INLINE_RESULTS
    return max(1, min(10, requested))

async def poll_jobs(queue: Any, ids: list[str], *, wait: float,
                    caller_scope: str, max_inline: int) -> dict[str, Any]:
    if not ids:
        return {"jobs": [], "server_time": time.time()}
    await queue.wait_any(ids, wait_sec=wait, caller_scope=caller_scope)
    jobs: list[dict[str, Any]] = []
    inlined = 0
    for job_id in ids:
        record = queue.get_scoped(job_id, caller_scope=caller_scope)
        if str(record.get("status") or "") == "done" and record.get("result") is not None:
            if inlined < max_inline:
                inlined += 1
            else:
                record = {key: value for key, value in record.items() if key != "result"}
                record["result_ready"] = True
        jobs.append(record)
    return {"jobs": jobs, "server_time": time.time()}

def cancellation_selector(payload: dict[str, Any]) -> tuple[list[Any], str, str]:
    raw_ids = payload.get("job_ids") or payload.get("ids") or []
    if not isinstance(raw_ids, list):
        raw_ids = [raw_ids]
    return raw_ids, cancellation.batch_id_of(payload), cancellation.scope_of(payload)
