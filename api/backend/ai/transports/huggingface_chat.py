"""Hugging Face router transport seam."""
from __future__ import annotations
from typing import Any, Callable
from backend.ai.clients.base import ChatResult
from backend.ai.prompt_cache import apply_chat_cache
from backend.ai.transports.openai_compat import execute_openai_compatible_request


def execute_huggingface_chat(
    *, url: str, headers: dict[str, str], payload: dict[str, Any], model: str,
    timeout: Any, timeout_policy: str, expected_ids: list[str] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    trace_event: str = "huggingface.generate",
    trace_file: str = "ai/providers/cloud_huggingface.py",
    trace_fields: dict[str, Any] | None = None,
) -> ChatResult:
    prepared, cache_policy = apply_chat_cache(
        payload, provider="huggingface", model=model, url=url, headers=headers,
    )
    return execute_openai_compatible_request(
        url=url, headers=headers, payload=prepared, model=model,
        provider_id="huggingface", timeout=timeout, timeout_policy=timeout_policy,
        expected_ids=expected_ids, cancel_check=cancel_check,
        trace_event=trace_event, trace_file=trace_file, trace_fields=trace_fields,
        cache_policy=cache_policy, cost_authoritative=False,
    )


__all__ = ["execute_huggingface_chat"]
