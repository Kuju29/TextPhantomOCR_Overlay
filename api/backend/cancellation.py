"""Short-lived batch cancellation state for synchronous split routes."""
from __future__ import annotations

import threading
import time
from typing import Any

_TTL = 30 * 60.0
_lock = threading.Lock()
_batches: dict[tuple[str, str], float] = {}


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


def scope_of(payload: dict[str, Any]) -> str:
    """Browser-owner scope; empty retains compatibility for legacy clients."""
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    return str(
        payload.get("tp_tab_session") or payload.get("session")
        or context.get("tp_tab_session") or ""
    ).strip()[:128]


def mark_batch(batch_id: str, scope: str = "") -> None:
    value = str(batch_id or "").strip()
    if not value:
        return
    now = time.monotonic()
    with _lock:
        for key in list(_batches):
            if now - _batches[key] > _TTL:
                _batches.pop(key, None)
        _batches[(str(scope or ""), value)] = now


def is_cancelled(payload: dict[str, Any]) -> bool:
    value = batch_id_of(payload)
    if not value:
        return False
    with _lock:
        at = _batches.get((scope_of(payload), value))
    return at is not None and time.monotonic() - at <= _TTL
