"""Provider-neutral failure labels for compact AI diagnostics."""

from __future__ import annotations

from dataclasses import dataclass

from backend.ai.errors import ModelOutputContractError


def classify(exc: BaseException) -> str:
    """Return a stable reason code while the trace keeps the original message.

    Provider clients use different exception classes and wording.  These labels
    let operators search TP_TRACE across Gemini, Anthropic, OpenAI-compatible,
    Hugging Face and local models without pretending the providers are alike.
    """
    if isinstance(exc, ModelOutputContractError):
        return "invalid_model_output"
    message = str(exc).lower()
    if "incomplete translation object" in message or (
        "incomplete" in message and "unit" in message
    ):
        return "incomplete_output"
    if "finish_reason" in message or "stop_reason" in message:
        return "generation_stopped"
    if "empty" in message and ("text" in message or "response" in message):
        return "empty_output"
    if "timed out" in message or "timeout" in message:
        return "provider_timeout"
    if "transport error" in message:
        return "provider_transport"
    if "http " in message:
        return "provider_http"
    if "json" in message or "schema" in message or "structured" in message:
        return "invalid_output_contract"
    return "provider_or_output_contract"


_RATE_LIMIT_MARKERS = (
    "429",
    "rate limit",
    "rate_limit",
    "ratelimit",
    "too many requests",
    "quota",
    "resource_exhausted",
    "resource exhausted",
    "overloaded",
)


def is_rate_limited(exc: BaseException) -> bool:
    """Whether the provider itself refused for rate or quota reasons."""
    message = str(exc).lower()
    return any(marker in message for marker in _RATE_LIMIT_MARKERS)


def retry_after_sec(exc: BaseException) -> float:
    """Seconds the provider asked us to wait, or 0 when it did not say."""
    import re

    match = re.search(r"retry[-_ ]?after[\"\':= ]+(\d+(?:\.\d+)?)", str(exc), re.IGNORECASE)
    return float(match.group(1)) if match else 0.0


@dataclass(frozen=True)
class ProviderHttpFailure:
    status: int
    code: str
    message: str
    retryable: bool
    retry_after: int = 0


def provider_http_failure(exc: BaseException) -> ProviderHttpFailure:
    """Map an upstream/provider failure without returning its raw message."""
    if is_rate_limited(exc):
        wait = retry_after_sec(exc)
        return ProviderHttpFailure(
            429, "provider_rate_limited",
            "The AI provider is rate limiting this request.", True,
            max(1, int(wait + 0.999)) if wait else 5,
        )
    reason = classify(exc)
    message = str(exc).lower()
    if any(marker in message for marker in (
        "prohibited_content", "prohibited content", "blocked this content",
        "blockreason", "safety",
    )):
        return ProviderHttpFailure(
            502, "provider_content_blocked",
            "The AI provider refused this content.", False,
        )
    provider_marked = any(marker in message for marker in (
        "provider", "gemini", "anthropic", "openai", "hugging face",
        "model output", "model response", "no candidates", "finishreason",
    ))
    if reason in {
        "invalid_model_output", "incomplete_output", "generation_stopped",
        "empty_output", "provider_timeout", "provider_transport",
        "provider_http", "invalid_output_contract",
    } or (reason == "provider_or_output_contract" and provider_marked):
        return ProviderHttpFailure(
            502, reason, "The AI provider could not complete this request.",
            reason in {"provider_timeout", "provider_transport", "provider_http"},
        )
    return ProviderHttpFailure(
        500, "internal_error", "The server could not complete this request.", False,
    )
