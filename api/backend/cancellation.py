"""Short-lived batch cancellation state for synchronous split routes."""
from __future__ import annotations

import threading
import time
from typing import Any

_TTL = 30 * 60.0
_lock = threading.Lock()
_batches: dict[str, float] = {}


def batch_id_of(payload: dict[str, Any]) -> str:
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    return str(
        payload.get("batch_id")
        or payload.get("batchId")
        or metadata.get("batch_id")
        or context.get("batch_id")
        or ""
    ).strip()


def mark_batch(batch_id: str) -> None:
    value = str(batch_id or "").strip()
    if not value:
        return
    now = time.monotonic()
    with _lock:
        for key in list(_batches):
            if now - _batches[key] > _TTL:
                _batches.pop(key, None)
        _batches[value] = now


def is_cancelled(payload: dict[str, Any]) -> bool:
    value = batch_id_of(payload)
    if not value:
        return False
    with _lock:
        at = _batches.get(value)
    return at is not None and time.monotonic() - at <= _TTL
