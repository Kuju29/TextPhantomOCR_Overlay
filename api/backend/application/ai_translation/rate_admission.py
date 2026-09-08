"""Rate-gate admission for one translation request."""

import time

from backend import cancellation
from backend.ai.rategate import rate_gate
from backend.config import settings

async def acquire(*, rate: dict, unlimited: bool, provider: str, config,
                  context: dict, payload: dict, idempotency_key: str | None) -> tuple[dict, float]:
    started = time.perf_counter()
    entry = (rate_gate.snapshot(provider, config.model, config.api_key)
             if rate["enabled"] and not unlimited else {})
    if rate["enabled"] and not unlimited:
        await rate_gate.acquire(
            provider, config.model, config.api_key,
            session=str(context.get("tp_tab_session") or context.get("tp_trace") or ""),
            job_id=str(payload.get("operationId") or idempotency_key or f"ai-v1-{time.time_ns()}"),
            deadline_sec=settings.rate_max_wait_sec,
            max_waiters=settings.rate_max_waiters_per_bucket,
            rpm_override=rate["rpm"] or None, burst_override=rate["burst"] or None,
            cancel_check=lambda: cancellation.is_cancelled(payload),
        )
    return entry, round((time.perf_counter() - started) * 1000, 1)
