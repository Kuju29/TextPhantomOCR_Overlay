"""Cancellation-aware mechanics for native, non-streaming provider calls."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

import httpx

from backend.ai.clients.base import ProviderGenerationCancelled
from backend.ai import accounting


def post_json(
    url: str,
    *,
    json: dict[str, Any],
    headers: dict[str, str] | None,
    timeout: Any,
    cancel_check: Callable[[], bool] | None,
    provider: str,
    model: str,
    trace_file: str,
) -> httpx.Response:
    """POST once and close the live client when its owning job is cancelled."""
    if cancel_check is not None and cancel_check():
        raise ProviderGenerationCancelled(f"{provider} generation was cancelled")
    started = time.perf_counter()
    stop = threading.Event()
    cancelled = threading.Event()
    client = httpx.Client(timeout=timeout)

    def watch() -> None:
        while not stop.wait(0.05):
            if cancel_check is not None and cancel_check():
                cancelled.set()
                try:
                    client.close()
                except Exception:
                    pass
                return

    watcher = threading.Thread(target=watch, daemon=True) if cancel_check is not None else None
    if watcher:
        watcher.start()
    try:
        accounting.mark_dispatched()
        stream_method = getattr(client, "stream", None)
        if callable(stream_method) and type(client).__module__.startswith("httpx"):
            from backend import trace
            with stream_method("POST", url, json=json, headers=headers) as response:
                trace.note(f"{provider}.generate.response_headers", {
                    "stage": "provider_response_headers", "provider": provider,
                    "model": model, "status": getattr(response, "status_code", None),
                    "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
                }, file=trace_file)
                response.read()
        else:
            response = client.post(url, json=json, headers=headers)
        try:
            data = response.json()
            field = "usageMetadata" if provider == "gemini" else "usage"
            accounting.observe(data.get(field), provider, complete=True,
                response_id=str(data.get("id") or data.get("responseId") or ""),
                http_status=response.status_code)
        except (ValueError, AttributeError): pass
        if cancelled.is_set() or (cancel_check is not None and cancel_check()):
            raise ProviderGenerationCancelled(f"{provider} generation was cancelled")
        return response
    except Exception as exc:
        if cancelled.is_set() or (cancel_check is not None and cancel_check()):
            from backend import trace
            trace.note(f"{provider}.generate.cancelled", {
                "stage": "provider_cancelled", "provider": provider, "model": model,
                "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
            }, file=trace_file)
            raise ProviderGenerationCancelled(f"{provider} generation was cancelled") from exc
        raise
    finally:
        stop.set()
        if watcher:
            watcher.join(timeout=0.2)
        try:
            client.close()
        except Exception:
            pass


__all__ = ["post_json"]
