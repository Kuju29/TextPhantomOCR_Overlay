"""Rate-limit handling for the Hugging Face router.

Free HF inference is aggressively rate-limited.  This module wraps the
OpenAI-compatible client with:

- a concurrency semaphore (``HF_AI_MAX_CONCURRENCY``),
- a minimum spacing between calls (``HF_AI_MIN_INTERVAL_SEC``),
- exponential backoff on 429/503 responses (``HF_AI_MAX_RETRIES``).

Non-HF providers bypass all of this.
"""

from __future__ import annotations

import time
from threading import Lock, Semaphore

from backend.ai.clients import openai_compat
from backend.ai.clients.base import ChatResult
from backend.config import settings
from backend.log import dbg

_semaphore = Semaphore(settings.hf_max_concurrency)
_interval_lock = Lock()
_last_call_ts = 0.0


def is_rate_limited_error(message: str) -> bool:
    """True when an error string looks like an HF throttle/overload response."""
    t = (message or "").lower()
    if "rate limit" in t or "ratelimit" in t or "too many requests" in t:
        return True
    if "http 429" in t or " 429" in t:
        return True
    if "http 503" in t or " 503" in t or "overloaded" in t or "temporarily" in t:
        return True
    return False


def _wait_for_interval() -> None:
    """Sleep so that calls are spaced at least ``hf_min_interval_sec`` apart."""
    if settings.hf_min_interval_sec <= 0:
        return
    global _last_call_ts  # noqa: PLW0603
    with _interval_lock:
        now = time.time()
        wait = settings.hf_min_interval_sec - (now - _last_call_ts)
        if wait > 0:
            time.sleep(wait)
        _last_call_ts = time.time()


def generate_with_backoff(
    api_key: str,
    base_url: str,
    model: str,
    system_text: str,
    user_parts: list[str],
    *,
    allow_hf_fallback: bool = False,
    image_b64: str = "",
    image_mime: str = "image/jpeg",
) -> ChatResult:
    """Call the OpenAI-compatible client, retrying on HF rate-limit errors."""
    last_error: Exception | None = None
    for attempt in range(settings.hf_max_retries):
        try:
            with _semaphore:
                _wait_for_interval()
                return openai_compat.generate(
                    api_key,
                    base_url,
                    model,
                    system_text,
                    user_parts,
                    allow_hf_fallback=allow_hf_fallback,
                    image_b64=image_b64,
                    image_mime=image_mime,
                )
        except Exception as e:  # noqa: BLE001 - we re-raise unless it's a throttle
            last_error = e
            if not is_rate_limited_error(str(e)):
                raise
            delay = min(
                15.0,
                max(
                    settings.hf_min_interval_sec,
                    settings.hf_retry_base_sec * (2 ** min(attempt, 4)),
                ),
            )
            dbg("ai.hf.backoff", {"attempt": attempt + 1, "delay_sec": round(delay, 2), "err": str(e)[:240]})
            time.sleep(delay)

    if last_error is not None:
        raise last_error
    raise RuntimeError("hf_backoff_failed")
