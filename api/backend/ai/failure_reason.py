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
    if any(marker in message for marker in (
        "billing required", "billing_required", "billing is past due",
        "payment required", "billing_hard_limit", "billing hard limit",
        "hard_limit_reached", "hard limit reached",
    )):
        return "billing_required"
    if any(marker in message for marker in (
        "insufficient credit", "insufficient_credit",
        "insufficient quota", "insufficient_quota",
        "credit balance", "token quota exhausted", "quota exhausted",
        "exceeded your current quota", "current quota exceeded",
    )):
        return "provider_quota_exhausted"
    if any(marker in message for marker in (
        "model_not_found", "model not found", "does not exist",
    )):
        return "provider_model_not_found"
    if any(marker in message for marker in (
        "model access", "does not have access", "not permitted to use",
        "permission denied for model",
    )):
        return "provider_model_access_denied"
    if any(marker in message for marker in (
        "prohibited_content", "prohibited content", "content_policy_violation",
        "blocked this content", "blockreason", "safety",
    )):
        return "provider_content_blocked"
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
    reason = classify(exc)
    if reason in {"provider_quota_exhausted", "billing_required"}:
        return ProviderHttpFailure(
            502, reason,
            "AI quota/credit is exhausted or billing is required.", False,
        )
    if is_rate_limited(exc):
        wait = retry_after_sec(exc)
        return ProviderHttpFailure(
            429, "provider_rate_limited",
            "The AI provider is rate limiting this request.", True,
            max(1, int(wait + 0.999)) if wait else 5,
        )
    # A permanent upstream 4xx must not invite an identical retry.  Keep the
    # existing outer 502 behaviour; upstreamStatus carries the real response.
    import re
    match = re.search(r"\bHTTP\s+(\d{3})\b", str(exc), re.IGNORECASE)
    upstream_status = int(match.group(1)) if match else None
    if upstream_status == 413:
        return ProviderHttpFailure(
            502, "provider_payload_too_large",
            "The AI provider rejected this request because it was too large.", False,
        )
    if reason == "provider_model_not_found":
        return ProviderHttpFailure(
            502, "provider_model_not_found",
            "The configured AI model was not found by the provider.", False,
        )
    if reason == "provider_model_access_denied":
        return ProviderHttpFailure(
            502, reason,
            "The configured account does not have access to this AI model.", False,
        )
    if reason == "provider_content_blocked":
        return ProviderHttpFailure(
            502, reason, "The AI provider refused this content.", False,
        )
    if upstream_status in (401, 403):
        return ProviderHttpFailure(
            502, "provider_auth_failed",
            "The AI provider rejected the configured credentials.", False,
        )
    if upstream_status is not None and 400 <= upstream_status < 500:
        return ProviderHttpFailure(
            502, "provider_http",
            "The AI provider rejected this request.", False,
        )
    message = str(exc).lower()
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
            reason in {"provider_timeout", "provider_transport"} or (
                reason == "provider_http" and upstream_status in (500, 502, 503, 504)
            ),
        )
    return ProviderHttpFailure(
        500, "internal_error", "The server could not complete this request.", False,
    )
