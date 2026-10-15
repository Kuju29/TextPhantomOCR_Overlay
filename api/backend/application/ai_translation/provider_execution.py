"""Admission, provider invocation, timing and cancellation for one request."""

from __future__ import annotations

import asyncio
import time
import contextvars
import hashlib
import threading
from dataclasses import dataclass
from contextlib import asynccontextmanager
from backend.ai import content_stream
from backend.ai.clients.base import ProviderGenerationCancelled

from fastapi import HTTPException

from backend import cancellation, trace
from backend.ai.accounting import receipt_scope
from backend.ai.rategate import rate_gate
from backend.ai.rate_policy import rate_bucket_identity
from backend.ai.translation.invocation import translate
from backend.api.errors import cancelled_payload, payload as error_payload
from backend.application.ai_translation.context import TranslationContext
from backend.application.ai_translation.provider_errors import raise_execution_error, trace_failure

@dataclass(frozen=True)
class ExecutionResult:
    result: dict
    admission_wait_ms: float
    provider_ms: float

def _cancelled(ctx: TranslationContext) -> bool:
    if cancellation.is_cancelled(ctx.payload):
        return True
    # Some lightweight/offline callers construct a context-shaped object
    # directly.  Preserve that compatibility; repair cancellation is an
    # optional extension, never a new requirement for ordinary translation.
    checker = getattr(ctx, "cancel_check", None)
    return bool(checker is not None and checker())

@asynccontextmanager
async def _admission_slot(gate, identity, cancel_check=None):
    """Cancel a queued acquire, never a running executor's slot ownership."""
    cancel_event = content_stream.cancellation_event()
    manager = gate.slot(identity)
    if cancel_event is None and cancel_check is None:
        async with manager:
            yield
        return
    entered = asyncio.create_task(manager.__aenter__())
    async def wait_cancelled():
        if cancel_check is None:
            await cancel_event.wait()
            return
        while not ((cancel_event is not None and cancel_event.is_set()) or cancel_check()):
            await asyncio.sleep(0.05)
    cancelled = asyncio.create_task(wait_cancelled())
    acquired = False
    try:
        completed, _ = await asyncio.wait((entered, cancelled), return_when=asyncio.FIRST_COMPLETED)
        if cancelled in completed:
            cancelled.result()
            entered.cancel()
            await asyncio.gather(entered, return_exceptions=True)
            acquired = not entered.cancelled() and entered.exception() is None
            error = ProviderGenerationCancelled("Translation cancelled while queued")
            error.preDispatchCancelled = True
            error.requestDispatched = False
            raise error
        await entered
        acquired = True
        yield
    finally:
        async def cleanup():
            cancelled.cancel()
            if not entered.done():
                entered.cancel()
            await asyncio.gather(cancelled, entered, return_exceptions=True)
            if acquired or (not entered.cancelled() and entered.exception() is None):
                await manager.__aexit__(None, None, None)
        # Repeated HTTP/task cancellation must not abandon a queued acquire or
        # leak wallet refs. Cleanup owns its own task and finishes before exit.
        cleaning = asyncio.create_task(cleanup())
        interrupted = False
        while not cleaning.done():
            try:
                await asyncio.shield(cleaning)
            except asyncio.CancelledError:
                interrupted = True
        cleaning.result()
        if interrupted:
            raise asyncio.CancelledError


async def run(ctx: TranslationContext, *, rate_wait_ms: float) -> ExecutionResult:
    # History dependency belongs OUTSIDE scarce AI admission slots.
    from backend.ai.translation_paths.store import async_execution_scope
    from backend.ai.translation_paths.store import ConversationError
    execution = None
    try:
        async with async_execution_scope(ctx.config, ctx.target_lang,
                                         lambda: _cancelled(ctx)):
            execution = await _run(ctx, rate_wait_ms=rate_wait_ms)
            return execution
    except ProviderGenerationCancelled as exc:
        # Private sample-lane cancellation may occur before _run admission or
        # just after its completed result. Preserve dispatch/usage evidence.
        raise_execution_error(ctx, exc, rate_wait_ms=rate_wait_ms,
            admission_wait_ms=execution.admission_wait_ms if execution else 0,
            provider_ms=execution.provider_ms if execution else 0)
    except ConversationError as exc:
        detail = error_payload(code=exc.code, message=str(exc), user_message=str(exc),
            origin="api", stage="conversation_wait", category="capacity", retryable=False,
            http_status=409, trace_id=ctx.trace_id, correlation=dict(ctx.correlation),
            extra={"providerAttempts":0,"generationAttempts":0,"requestDispatched":False})
        raise HTTPException(409,detail=detail) from exc

async def _run(ctx: TranslationContext, *, rate_wait_ms: float) -> ExecutionResult:
    timing: dict[str, float] = {}
    task_cancelled = threading.Event()

    def invoke() -> dict:
        with trace.scope(ctx.trace_id), receipt_scope("runsextension", ctx.payload.get("operationId", "")):
            started = time.perf_counter()
            try:
                return translate(ctx.marked, ctx.target_lang, ctx.config,
                                 cancel_check=lambda: task_cancelled.is_set() or _cancelled(ctx))
            finally:
                timing["provider_ms"] = round((time.perf_counter() - started) * 1000, 1)

    admission_started = time.perf_counter()
    admission_wait_ms = 0.0
    async def await_provider(future):
        try:
            return await asyncio.shield(future)
        except asyncio.CancelledError:
            # An executor/network thread outlives the cancelled HTTP task.
            # Keep its admission and Conversation ownership until it exits.
            task_cancelled.set()
            while not future.done():
                try:
                    await asyncio.shield(future)
                except asyncio.CancelledError:
                    continue
                except BaseException:
                    break
            if future.done() and not future.cancelled():
                future.exception()
            raise
    # AI Login waits on the person's own browser, so it uses its own lane
    # and never holds one of the AI slots Paid/Manual users share. App states
    # built without that lane (offline harnesses) keep the shared one.
    state = ctx.request.app.state
    login_lane = ctx.resolved_provider == "login" and getattr(state, "login_admission_gate", None) is not None
    gate = state.login_admission_gate if login_lane else state.ai_admission_gate
    executor = state.login_executor if login_lane else state.ai_executor
    opaque_owner = "owner:" + hashlib.sha256(str(ctx.identity).encode("utf-8")).hexdigest()[:16]
    def admission_note(event: str, *, final: bool, queue_wait_ms: float = 0.0,
                       outcome: str = "progress") -> None:
        # Admission telemetry is optional: lightweight/test-compatible gates only
        # promise ``slot`` and must not fail a real provider request because they
        # do not expose production queue statistics.
        try:
            stats_fn = getattr(gate, "stats", None)
            stats = stats_fn() if callable(stats_fn) else None
            trace.write("api", "application/ai_translation/provider_execution.py", "fairAdmission", "..", {
                "event": event, "owner": opaque_owner, "outcome": outcome,
                "severity": "info", "retryable": False, "final": final,
                "scope": {**dict(ctx.correlation), "owner": opaque_owner},
                "running": getattr(stats, "running", None),
                "limit": getattr(stats, "limit", None),
                "waiters": getattr(stats, "waiting", None),
                "queueWaitMs": queue_wait_ms,
            }, trace_id=ctx.trace_id)
        except Exception:
            return
    try:
        loop = asyncio.get_running_loop()
        caller_context = contextvars.copy_context()
        threaded_invoke = lambda: caller_context.run(invoke)
        if ctx.unlimited:
            result = await await_provider(loop.run_in_executor(executor, threaded_invoke))
        else:
            admission_note("waiting", final=False)
            async with _admission_slot(gate, ctx.identity, lambda: _cancelled(ctx)):
                admission_wait_ms = round((time.perf_counter() - admission_started) * 1000, 1)
                admission_note("admitted", final=False, queue_wait_ms=admission_wait_ms)
                result = await await_provider(loop.run_in_executor(executor, threaded_invoke))
        if ctx.rate["enabled"] and not ctx.unlimited:
            rate_gate.report_success(ctx.resolved_provider, ctx.config.model,
                rate_bucket_identity(ctx.rate, base_url=ctx.config.base_url, api_key=ctx.config.api_key))
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt, SystemExit, asyncio.CancelledError)):
            if not ctx.unlimited:
                admission_note("released", final=True, queue_wait_ms=admission_wait_ms, outcome="cancelled")
            raise
        if not ctx.unlimited:
            admission_note("released", final=True, queue_wait_ms=admission_wait_ms, outcome="failed")
        raise_execution_error(ctx, exc, rate_wait_ms=rate_wait_ms,
                              admission_wait_ms=admission_wait_ms,
                              provider_ms=timing.get("provider_ms", 0.0))
    provider_ms = timing.get("provider_ms", 0.0)
    if not ctx.unlimited:
        admission_note("released", final=True, queue_wait_ms=admission_wait_ms, outcome="succeeded")
    if _cancelled(ctx):
        exc = RuntimeError("batch was cancelled while AI was running")
        meta = result.get("meta", {}) if isinstance(result, dict) else {}
        usage = meta.get("usage")
        retained_paid = (ctx.config.provider == ctx.resolved_provider == meta.get("provider") == "paid"
            and meta.get("centerOperationReplayed") is True and meta.get("requestDispatched") is False
            and type(meta.get("generationAttempts")) is int and meta["generationAttempts"] == 0
            and type(meta.get("providerAttempts")) is int and meta["providerAttempts"] == 0
            and isinstance(usage, dict) and usage.get("centerOperationReplayed") is True)
        attempts = 0 if retained_paid else int(meta.get("generation_attempts", 1))
        trace_failure(ctx, "cancelled", exc, 409, units=ctx.unit_count,
                      providerMs=provider_ms, providerAttempts=0 if retained_paid else 1,
                      generationAttempts=attempts)
        detail = cancelled_payload(trace_id=ctx.trace_id, stage="ai_cancel", correlation=dict(ctx.correlation))
        if isinstance(usage, dict):
            generation_meta = {"provider": meta.get("provider"), "model": meta.get("model"), "usage": usage}
            if retained_paid:
                from backend.ai.usage import aggregate_usage
                historical = dict(usage)
                current_usage = aggregate_usage([])
                current_usage.update(retainedGenerations=[historical], centerOperationReplayed=True,
                    inputTokens=0, outputTokens=0, totalTokens=0, source=None, usageStatus='not_dispatched')
                generation_meta.update(usage=current_usage, centerOperationReplayed=True, requestDispatched=False,
                                       generationAttempts=0, providerAttempts=0)
            detail.update(generationAttempts=attempts, requestDispatched=not retained_paid,
                          structuralDetails={"generationMeta": generation_meta})
            if retained_paid:
                detail.update(providerAttempts=0, centerOperationReplayed=True)
        raise HTTPException(409, detail=detail) from exc
    return ExecutionResult(result, admission_wait_ms, provider_ms)
