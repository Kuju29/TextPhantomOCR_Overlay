"""Compatibility entry point for generic OpenAI-compatible providers.

Named providers with provider-specific behavior use dedicated transport seams
(openrouter_chat.py, huggingface_chat.py, deepseek_chat.py, openai_cloud_chat.py).
This module stays as the small generic adapter used by local/custom OpenAI-style
runtimes so existing integrations do not depend on a cloud provider module.
"""
from __future__ import annotations
from typing import Any, Callable
from urllib.parse import urlsplit

import httpx
from backend.ai.clients.base import ChatResult
from backend.ai import wire_trace
from backend.ai.prompt_cache import apply_chat_cache
from backend.ai.transports.openai_compat import execute_openai_compatible_request
from backend.ai.transports.openai_compat.streaming import JsonClosureGate as _JsonClosureGate, JsonObjectCompletionDetector as _JsonObjectCompletionDetector, WireStreamCapture as _WireStreamCapture


def execute_chat_completion(
    *, url: str, headers: dict[str, str], payload: dict[str, Any],
    model: str, provider_id: str, timeout: Any,
    timeout_policy: str, expected_ids: list[str] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    trace_event: str = "ai.chat.generate", trace_file: str = "ai/transports/openai_chat.py",
    trace_fields: dict[str, Any] | None = None,
) -> ChatResult:
    prepared, cache_policy = apply_chat_cache(
        payload, provider=provider_id, model=model, url=url, headers=headers,
    )
    return execute_openai_compatible_request(
        url=url, headers=headers, payload=prepared, model=model,
        provider_id=provider_id, timeout=timeout, timeout_policy=timeout_policy,
        expected_ids=expected_ids, cancel_check=cancel_check,
        trace_event=trace_event, trace_file=trace_file, trace_fields=trace_fields,
        cache_policy=cache_policy,
        cost_authoritative=(provider_id == "openrouter" and urlsplit(url).hostname == "openrouter.ai"),
    )


__all__ = ["execute_chat_completion", "_JsonClosureGate", "_JsonObjectCompletionDetector", "_WireStreamCapture"]
