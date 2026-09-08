"""Shared types for AI chat clients.
Every client exposes a ``generate(api_key, model, system_text, user_parts)``
function returning :class:`ChatResult` — a ``(text, used_model)`` pair.  The
``used_model`` may differ from the requested one (e.g. a Hugging Face router
fallback).
"""

from __future__ import annotations
from typing import Any, NamedTuple

import re

from backend.ai.errors import ModelOutputContractError

class ChatResult(NamedTuple):
    text: str
    used_model: str
    # Provider-reported values only. ``None`` means unavailable; callers must
    # never estimate missing token counts or silently turn them into zero.
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    finish_reason: str | None = None
    provider_ms: float | None = None
    parse_ms: float | None = None
    usage_source: str | None = None
    thinking_tokens: int | None = None
    # Positive provider/protocol evidence that generation ended normally.
    # False/None must never make a missing terminal marker acceptable.
    terminal_completed: bool | None = None
    terminal_evidence: str | None = None
    prompt_eval_ms: float | None = None
    usage_status: str | None = None
    first_all_ids_ms: float | None = None
    early_completion_ms: float | None = None
    terminal_ms: float | None = None
    thinking_applied: str | None = None
    requested_output_tokens: int | None = None
    upstream_provider: str | None = None
    cached_input_tokens: int | None = None
    usage_details: dict[str, Any] | None = None
    cache_policy: dict[str, Any] | None = None

class LineCompletionDetector:
    """Detect an exact, closed records/1 set without trusting marker count."""
    def __init__(self, expected_ids: list[str] | tuple[str, ...] | None) -> None:
        self.expected = list(expected_ids or [])
        self.first_all_ids_ms: float | None = None

    def inspect(self, content: str, elapsed_ms: float) -> str | None:
        if not self.expected:
            return None
        # Match the records decoder: exactly one LF/CRLF is formatting, but
        # extra blank records and a lone terminal CR remain invalid.
        source = re.sub(r"\r?\n\Z", "", str(content or ""))
        source = source.replace("\r\n", "\n").replace("\r", "\n")
        if any(separator in source for separator in ("\u0085", "\u2028", "\u2029")):
            return None
        record_lines = source.split("\n")
        matches = [re.fullmatch(r"[ \t]*<<TP_(P\d+):(.*)>>[ \t]*", line)
                   for line in record_lines]
        received = [match.group(1) for match in matches if match]
        if self.first_all_ids_ms is None and set(received) == set(self.expected):
            self.first_all_ids_ms = elapsed_ms
        if len(matches) == len(self.expected) and all(matches):
            values = [match.group(2).strip() for match in matches if match]
            nested = any(re.search(r"<<TP_P\d+:", value) for value in values)
            if (len(set(received)) == len(received)
                    and set(received) == set(self.expected)
                    and all(values) and not nested):
                return "all_id_records_closed"
        return None

def token_usage(
    raw: Any,
    *,
    input_keys: tuple[str, ...],
    output_keys: tuple[str, ...],
    total_keys: tuple[str, ...],
) -> tuple[int | None, int | None, int | None]:
    """Read non-negative integer token counts without estimating values."""
    data = raw if isinstance(raw, dict) else {}

    def pick(keys: tuple[str, ...]) -> int | None:
        for key in keys:
            value = data.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                return value
        return None

    return pick(input_keys), pick(output_keys), pick(total_keys)

def usage_meta(result: ChatResult) -> dict[str, Any]:
    if result.usage_details is not None:
        return dict(result.usage_details)
    meta = {
        "inputTokens": result.input_tokens,
        "outputTokens": result.output_tokens,
        "totalTokens": result.total_tokens,
        "source": result.usage_source,
    }
    if result.thinking_tokens is not None:
        meta["thinkingTokens"] = result.thinking_tokens
    if result.cached_input_tokens is not None:
        meta["cachedInputTokens"] = result.cached_input_tokens
    if result.usage_status:
        meta["usageStatus"] = result.usage_status
    return meta

class ProviderOutputError(ModelOutputContractError):
    """A charged provider response that failed before a usable ChatResult.

    The attached details are deliberately limited to billing/diagnostic
    metadata. Prompt text and raw provider responses must never be included.
    """

class OutputBudgetExhausted(ProviderOutputError):
    """The provider spent its completion budget before returning a complete answer."""

class ProviderGenerationCancelled(RuntimeError):
    """Provider stream stopped because the owning TextPhantom job was cancelled."""

def provider_output_error(
    message: str,
    *,
    provider: str,
    model: str,
    input_tokens: int | None,
    output_tokens: int | None,
    total_tokens: int | None,
    finish_reason: str | None,
    provider_ms: float | None,
    parse_ms: float | None,
    timeout_policy: str,
    response_shape: str = "provider_response",
    usage_details: dict | None = None,
) -> ProviderOutputError:
    usage = {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": total_tokens,
        "source": (
            "provider"
            if any(value is not None for value in (input_tokens, output_tokens, total_tokens))
            else None
        ),
    }
    if usage_details is not None:
        usage = dict(usage_details)
    error_type = (
        OutputBudgetExhausted
        if str(finish_reason or "").strip().lower()
        in {"length", "max_tokens", "max_output_tokens"}
        else ProviderOutputError
    )
    return error_type(
        message,
        response_shape=response_shape,
        resolvedProvider=provider,
        resolvedModel=model,
        generationMeta={
            "usage": usage,
            "finish_reason": finish_reason,
            "provider_ms": provider_ms,
            "provider_parse_ms": parse_ms,
            "timeout_policy": timeout_policy,
        },
    )
