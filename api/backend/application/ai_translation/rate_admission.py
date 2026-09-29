"""Rate-gate admission for one translation request."""

import time

from backend import cancellation
from backend.ai.rategate import rate_gate
from backend.ai.rate_policy import rate_bucket_identity
from backend.config import settings

async def acquire(*, rate: dict, unlimited: bool, provider: str, config,
                  context: dict, payload: dict, idempotency_key: str | None, cancel_check=None) -> tuple[dict, float]:
    started = time.perf_counter()
    rate_key = rate_bucket_identity(rate, base_url=config.base_url, api_key=config.api_key)
    entry = (rate_gate.snapshot(provider, config.model, rate_key, manual_local=rate.get("local", False),
                                manual_override=True, rpm_override=rate["rpm"], burst_override=rate["burst"])
             if rate["enabled"] else {})
    # The local-peer bypass concerns shared API capacity, not a request cap
    # the user explicitly enabled for this provider.
    if rate["enabled"]:
        await rate_gate.acquire(
            provider, config.model, rate_key,
            session=str(context.get("tp_tab_session") or context.get("tp_trace") or ""),
            job_id=str(payload.get("operationId") or idempotency_key or f"ai-v1-{time.time_ns()}"),
            deadline_sec=settings.rate_max_wait_sec,
            max_waiters=settings.rate_max_waiters_per_bucket,
            rpm_override=rate["rpm"] or None, burst_override=rate["burst"] or None,
            manual_local=rate.get("local", False),
            cancel_check=lambda: cancellation.is_cancelled(payload) or bool(cancel_check and cancel_check()),
        )
    return entry, round((time.perf_counter() - started) * 1000, 1)
