"""Admission, provider invocation, timing and cancellation for one request."""

from __future__ import annotations

import asyncio
import time
import contextvars
import hashlib
from dataclasses import dataclass
from contextlib import asynccontextmanager
from backend.ai import content_stream
from backend.ai.clients.base import ProviderGenerationCancelled

from fastapi import HTTPException

from backend import cancellation, trace
from backend.ai.accounting import receipt_scope
from backend.ai.rategate import rate_gate
from backend.ai.translation.invocation import translate
from backend.api.errors import cancelled_payload
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
async def _admission_slot(gate, identity):
    """Cancel a queued acquire, never a running executor's slot ownership."""
    cancel_event = content_stream.cancellation_event()
    manager = gate.slot(identity)
    if cancel_event is None:
        async with manager:
            yield
        return
    entered = asyncio.create_task(manager.__aenter__())
    cancelled = asyncio.create_task(cancel_event.wait())
    acquired = False
    try:
        await asyncio.wait((entered, cancelled), return_when=asyncio.FIRST_COMPLETED)
        if cancel_event.is_set():
            entered.cancel()
            await asyncio.gather(entered, return_exceptions=True)
            acquired = not entered.cancelled() and entered.exception() is None
            raise ProviderGenerationCancelled("Translation cancelled while queued")
        await entered
        acquired = True
        yield
    finally:
        cancelled.cancel()
        await asyncio.gather(cancelled, return_exceptions=True)
        if not entered.done():
            entered.cancel()
            await asyncio.gather(entered, return_exceptions=True)
        if acquired or (entered.done() and not entered.cancelled() and entered.exception() is None):
            await manager.__aexit__(None, None, None)


async def run(ctx: TranslationContext, *, rate_wait_ms: float) -> ExecutionResult:
    # History dependency belongs OUTSIDE scarce AI admission slots.
    from backend.ai.translation_paths.store import async_execution_scope
    from backend.ai.translation_paths.store import ConversationError
    try:
        async with async_execution_scope(ctx.config, ctx.target_lang,
                                         lambda: _cancelled(ctx)):
            return await _run(ctx, rate_wait_ms=rate_wait_ms)
    except ConversationError as exc:
        from backend.api.errors import payload as error_payload
        detail = error_payload(code=exc.code, message=str(exc), user_message=str(exc),
            origin="api", stage="conversation_wait", category="capacity", retryable=False,
            http_status=409, trace_id=ctx.trace_id, correlation=dict(ctx.correlation),
            extra={"providerAttempts":0,"generationAttempts":0,"requestDispatched":False})
        raise HTTPException(409,detail=detail) from exc

async def _run(ctx: TranslationContext, *, rate_wait_ms: float) -> ExecutionResult:
    timing: dict[str, float] = {}

    def invoke() -> dict:
        with trace.scope(ctx.trace_id), receipt_scope("runsextension", ctx.payload.get("operationId", "")):
            started = time.perf_counter()
            try:
                return translate(ctx.marked, ctx.target_lang, ctx.config,
                                 cancel_check=lambda: _cancelled(ctx))
            finally:
                timing["provider_ms"] = round((time.perf_counter() - started) * 1000, 1)

    admission_started = time.perf_counter()
    admission_wait_ms = 0.0
    gate = ctx.request.app.state.ai_admission_gate
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
            result = await loop.run_in_executor(ctx.request.app.state.ai_executor, threaded_invoke)
        else:
            admission_note("waiting", final=False)
            async with _admission_slot(gate, ctx.identity):
                admission_wait_ms = round((time.perf_counter() - admission_started) * 1000, 1)
                admission_note("admitted", final=False, queue_wait_ms=admission_wait_ms)
                result = await loop.run_in_executor(ctx.request.app.state.ai_executor, threaded_invoke)
        if ctx.rate["enabled"] and not ctx.unlimited:
            rate_gate.report_success(ctx.resolved_provider, ctx.config.model, ctx.config.api_key)
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
        trace_failure(ctx, "cancelled", exc, 409, units=ctx.unit_count,
                      providerMs=provider_ms, providerAttempts=1)
        detail = cancelled_payload(trace_id=ctx.trace_id, stage="ai_cancel", correlation=dict(ctx.correlation))
        meta = result.get("meta", {}) if isinstance(result, dict) else {}
        if isinstance(meta.get("usage"), dict):
            detail.update(generationAttempts=meta.get("generation_attempts", 1), requestDispatched=True,
                          structuralDetails={"generationMeta": {"provider": meta.get("provider"),
                             "model": meta.get("model"), "usage": meta["usage"]}})
        raise HTTPException(409, detail=detail) from exc
    return ExecutionResult(result, admission_wait_ms, provider_ms)
