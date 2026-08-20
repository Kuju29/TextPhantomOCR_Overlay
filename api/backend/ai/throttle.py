"""Rate-limit handling for the Hugging Face router.


Optional Hugging Face account pacing around the OpenAI-compatible client.

By default TextPhantom imposes NO HF-specific concurrency or spacing limit; the
provider's real 429/503 response is authoritative and the browser adapts to it.
Operators who know an account's quota can opt in with ``HF_AI_MAX_CONCURRENCY``
and/or ``HF_AI_MIN_INTERVAL_SEC``. There is still exactly one provider attempt.

Non-HF providers bypass all of this.

Per key, not per server
-----------------------
When optional pacing is configured it belongs to a Hugging Face ACCOUNT, and
every request carries its own key. A single process-wide semaphore made users
wait for each other's quota, so configured gates remain per key. Two users never
block each other; users sharing one key share only the explicit account cap.
The table is bounded and keyed by a hash rather than the secret itself.
"""

from __future__ import annotations

import hashlib
import time
from collections import OrderedDict
from threading import Lock, Semaphore

from backend.ai.clients import openai_compat
from backend.ai.clients.base import ChatResult
from backend.config import settings

# How many distinct keys keep their own gate. Past this the least recently used
# entry is dropped; the only cost of a drop is that key briefly getting a fresh
# spacing clock.
_MAX_TRACKED_KEYS = 512


class _KeyGate:
    """One account's concurrency slot and spacing clock."""

    __slots__ = ("semaphore", "interval_lock", "last_call_ts")

    def __init__(self, concurrency: int) -> None:
        self.semaphore = Semaphore(max(1, concurrency)) if concurrency > 0 else None
        self.interval_lock = Lock()
        self.last_call_ts = 0.0


_gates: "OrderedDict[str, _KeyGate]" = OrderedDict()
_gates_lock = Lock()


def _gate_for(api_key: str) -> _KeyGate:
    """The gate for one key. Hashed, so no key is held in a live dict."""
    ident = hashlib.sha256((api_key or "").encode("utf-8")).hexdigest()[:16]
    with _gates_lock:
        gate = _gates.get(ident)
        if gate is None:
            gate = _KeyGate(settings.hf_max_concurrency)
            _gates[ident] = gate
            while len(_gates) > _MAX_TRACKED_KEYS:
                _gates.popitem(last=False)
        else:
            _gates.move_to_end(ident)
        return gate


def _reset_for_tests() -> None:
    with _gates_lock:
        _gates.clear()


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


def _wait_for_interval(gate: _KeyGate) -> None:
    """Space THIS key's calls at least ``hf_min_interval_sec`` apart."""
    if settings.hf_min_interval_sec <= 0:
        return
    with gate.interval_lock:
        now = time.time()
        wait = settings.hf_min_interval_sec - (now - gate.last_call_ts)
        if wait > 0:
            time.sleep(wait)
        gate.last_call_ts = time.time()


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
    response_schema: dict | None = None,
) -> ChatResult:
    """Call the HF OpenAI-compatible client exactly once behind its rate gate.

    The historical function name is kept as a public compatibility boundary.
    A 429/503 or any other provider error is now returned immediately; the
    caller can see the failure without hidden token use, delay, or model swap.
    """
    gate = _gate_for(api_key)

    def _call() -> ChatResult:
        _wait_for_interval(gate)
        return openai_compat.generate(
            api_key,
            base_url,
            model,
            system_text,
            user_parts,
            allow_hf_fallback=allow_hf_fallback,
            image_b64=image_b64,
            image_mime=image_mime,
            response_schema=response_schema,
        )

    if gate.semaphore is None:
        return _call()
    with gate.semaphore:
        return _call()
