"""Server-owned repair pool and one-shot dispatch with recoverable receipts."""
from __future__ import annotations

import asyncio
import hashlib
import json
from fastapi import APIRouter, HTTPException, Request
from backend import trace
from backend.application.repair_pool import state
from backend.application.repair_pool.store import store
from backend.application.ai_translation.orchestration import execute

router = APIRouter(prefix="/v2/engine/runsextension/repair-runs")
MAX_BODY_BYTES = 2 * 1024 * 1024
_running: set[asyncio.Task] = set()

def token(request: Request) -> str:
    return str(request.headers.get("x-tp-run-token") or "")

async def body(request: Request) -> dict:
    # Bound before decoding; never copy an unbounded request into the ledger.
    chunks, length = [], 0
    async for chunk in request.stream():
        length += len(chunk)
        if length > MAX_BODY_BYTES:
            raise HTTPException(413, detail={"code": "repair_request_too_large"})
        chunks.append(chunk)
    try:
        value = json.loads(b"".join(chunks))
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, detail={"code": "invalid_repair_request"}) from None

async def call(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except state.PoolError as error:
        raise HTTPException(error.status, detail={"code": error.code, "retryable": False}) from error

async def change(request: Request, run_id: str, action):
    value = await call(store.transact, run_id, token(request), action)
    trace.write("api", "api/routes/repair_runs.py", "repairPool", "note", {
        "runId": run_id, "phase": value.get("phase"), "repaired": value.get("repaired"),
        "pending": len(value.get("pending", [])), "unresolved": value.get("unresolved"),
    })
    return value

@router.post("")
async def register(request: Request):
    data = await body(request)
    caller = hashlib.sha256(f"{request.client.host if request.client else ''}|{request.headers.get('origin', '')}".encode()).hexdigest()
    return await call(store.register, data.get("runId"), token(request), data.get("manifest"), caller)

@router.get("/{run_id}")
async def status(run_id: str, request: Request):
    return await call(store.read, run_id, token(request))

@router.post("/{run_id}/pages")
async def page_done(run_id: str, request: Request):
    data = await body(request)
    return await change(request, run_id, lambda run: state.record_page(run, data))

@router.post("/{run_id}/seal")
async def seal(run_id: str, request: Request):
    return await change(request, run_id, state.seal)

@router.post("/{run_id}/claim")
async def claim(run_id: str, request: Request):
    data = await body(request)
    return await change(request, run_id, lambda run: state.claim(run, data))

@router.post("/{run_id}/tasks/{task_id}/start")
async def start(run_id: str, task_id: str, request: Request):
    data = await body(request)
    return await change(request, run_id, lambda run: state.begin(run, task_id, str(data.get("executor") or "")))

@router.post("/{run_id}/tasks/{task_id}/complete")
async def complete(run_id: str, task_id: str, request: Request):
    data = await body(request)
    return await change(request, run_id, lambda run: state.complete(run, task_id, data))

@router.post("/{run_id}/tasks/{task_id}/fail")
async def fail(run_id: str, task_id: str, request: Request):
    data = await body(request)
    return await change(request, run_id, lambda run: state.fail(run, task_id,
        str(data.get("reason") or "repair_failed"), data.get("unknown") is True))

@router.post("/{run_id}/cancel")
async def cancel(run_id: str, request: Request):
    return await change(request, run_id, state.cancel)

@router.delete("/{run_id}")
async def remove(run_id: str, request: Request):
    return await call(store.delete, run_id, token(request))

@router.post("/{run_id}/tasks/{task_id}/translate")
async def translate(run_id: str, task_id: str, request: Request):
    payload = await body(request)
    run_token = token(request)
    current = await call(store.read, run_id, run_token)
    task = next((x for x in current["tasks"] if x["id"] == task_id), None)
    if not task or task["route"] != "server":
        raise HTTPException(409, detail={"code": "repair_task_route_mismatch"})
    expected = [{"id": x["id"], "text": x["text"]} for x in task["units"]]
    if payload.get("units") != expected:
        raise HTTPException(409, detail={"code": "repair_task_source_mismatch"})
    begun = await call(store.transact, run_id, run_token,
                       lambda run: state.begin(run, task_id, task["executor"]))
    if not begun["dispatch"]:
        if begun.get("answer"):
            result = begun["answer"]
            return {**result, "replayed": True, "meta": {**result.get("meta", {}),
                "providerAttempts": 0, "generationAttempts": 0, "replayedFromLedger": True}}
        raise HTTPException(409, detail={"code": "repair_request_in_progress", "retryable": False})
    # The pool owns the single repair round; disable nested per-request repair.
    payload["repair"] = {"owner": "extension", "enabled": False,
        "reason": "wrong_target_script" if any(u.get("reason") == "wrong_language" for u in task["units"]) else ""}
    operation_id = f"repair:{run_id}:{task_id}"
    payload["operationId"] = operation_id

    async def generate():
        try:
            result = await execute(request, payload, operation_id)
            await asyncio.to_thread(store.transact, run_id, run_token,
                                    lambda run: state.answer_task(run, task_id, result))
            return result
        except BaseException as error:
            reason = error.detail.get("code", "repair_provider_error") if isinstance(error, HTTPException) and isinstance(error.detail, dict) else type(error).__name__
            try:
                await asyncio.to_thread(store.transact, run_id, run_token,
                    lambda run: state.fail(run, task_id, reason,
                                          isinstance(error, (asyncio.CancelledError, ConnectionError))))
            except Exception:
                pass  # retain running/unknown; never make it pending again
            raise

    # A client disconnect must not discard the cloud receipt or cause a new
    # provider call on reconnect. This task dies only with the API process.
    work = asyncio.create_task(generate())
    _running.add(work)
    def forget(done):
        _running.discard(done)
        if not done.cancelled():
            done.exception()  # consume failures even when the HTTP client disconnected
    work.add_done_callback(forget)
    return await asyncio.shield(work)
