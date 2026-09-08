"""Caller-scoped idempotency for translation requests."""

from dataclasses import dataclass
from typing import Any
from fastapi import Request

import hashlib, asyncio

from backend.application import ai_request, idempotency
from backend.jobs.admission import identity_of

class IdempotencyConflict(ValueError):
    pass

@dataclass(frozen=True)
class Reservation:
    key: str
    request_hash: str
    replay: dict[str, Any] | None = None

async def reserve(request: Request, payload: dict, raw_key: str | None) -> Reservation:
    request_hash = ai_request.request_fingerprint(payload)
    raw_key = str(raw_key or "").strip()
    if not raw_key:
        return Reservation("", request_hash)
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    key = f"{_caller_scope(request, payload)}:{key_hash}"
    state, cached = idempotency.reserve(key, request_hash)
    if state == "mismatch":
        raise IdempotencyConflict("Idempotency-Key was already used with a different request.")
    while state == "wait":
        cached = await asyncio.shield(cached)
        state, cached = (("hit", cached) if cached is not None
                         else idempotency.reserve(key, request_hash))
    if state == "mismatch":
        raise IdempotencyConflict("Idempotency-Key payload changed while retrying")
    if state == "hit" and cached is not None:
        meta = cached.get("meta") if isinstance(cached.get("meta"), dict) else {}
        return Reservation(key, request_hash, {
            **cached,
            "meta": {**meta, "providerAttempts": 0, "generationAttempts": 0,
                     "httpAttempts": 0, "replayedFromLedger": True},
            "replayed": True,
        })
    if state == "owner":
        task = asyncio.current_task()
        if task is not None:
            task.add_done_callback(
                lambda _task, k=key, h=request_hash, f=cached: idempotency.release(k, h, f)
            )
    return Reservation(key, request_hash)

def store(reservation: Reservation, body: dict) -> None:
    if reservation.key:
        idempotency.store(reservation.key, reservation.request_hash, body)

def _caller_scope(request: Request, payload: dict) -> str:
    provider = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
    identity = identity_of({
        "ai": {"api_key": str(provider.get("apiKey") or "")},
        "context": payload.get("context") if isinstance(payload.get("context"), dict) else {},
    })
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    session = str(context.get("tp_tab_session") or "")[:128]
    client = request.client.host if request.client else "unknown"
    origin = str(request.headers.get("origin") or "")[:256]
    auth = str(request.headers.get("authorization") or "")
    auth_hash = hashlib.sha256(auth.encode()).hexdigest()[:16] if auth else ""
    caller = session or f"{client}|{origin}|{auth_hash}"
    return "c:" + hashlib.sha256(f"{identity}|{caller}".encode()).hexdigest()[:20]
