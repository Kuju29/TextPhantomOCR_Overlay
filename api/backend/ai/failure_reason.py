"""Provider-neutral failure labels for compact AI diagnostics."""

from __future__ import annotations

from dataclasses import dataclass

from backend.ai.errors import ModelOutputContractError
from backend.ai.clients.provider_error import (
    ProviderAdapterContractError, ProviderHttpError, ProviderTransportError,
    upstream_http_status, structured_upstream_http_status,
)

# Paid errors are wallet/settlement decisions, not an upstream rate-limit guess.
# Never automatically start a new paid operation after an uncertain result.
_PAID_ERRORS = {
    "DATABASE_UNAVAILABLE": (503, "paid_database_unavailable", "Paid Center could not confirm the operation because its database failed. Review the original operation and credit history before starting another."),
    "PAID_CENTER_UPGRADE_REQUIRED": (503, "paid_center_upgrade_required", "Paid API and Center are incompatible. Update and restart Center .62 or newer with this Source package. No new AI request or credit reservation was made."),
    "PAID_CENTER_UNAVAILABLE": (503, "paid_center_unavailable", "Paid Center readiness could not be verified. No new AI request or credit reservation was made."),
    "PAID_REQUEST_INVALID": (422, "paid_request_invalid", "Center rejected the Paid request format before AI dispatch or credit reservation. Contact support with the reference code."),
    "VALIDATION_ERROR": (422, "paid_request_invalid", "Center rejected the Paid request format before AI dispatch or credit reservation. Contact support with the reference code."),
    "AUTH_REQUIRED": (401, "paid_login_required", "Your Paid customer session expired or was revoked. Sign in again."),
    "PAID_CAPACITY_BUSY": (429, "paid_capacity_busy", "Paid is busy. No AI request or credit reservation was made; wait before starting another operation."),
    "PAID_PROVIDER_CAPACITY": (503, "paid_provider_capacity", "Paid AI capacity is full for the moment. Try again shortly; your TP balance is not the cause."),
    "PAID_PROVIDER_KEY_LIMIT": (503, "paid_provider_key_limit", "Paid is temporarily unavailable. Your TP balance is not the cause."),
    "PAID_PROVIDER_ROUTE": (502, "paid_provider_route", "This Paid model is unavailable. Contact support with the reference code."),
    "PAID_PROVIDER_AUTH": (502, "paid_provider_auth", "Paid is unavailable. Contact support with the reference code."),
    "PAID_PROVIDER_BALANCE": (502, "paid_provider_balance", "Paid is temporarily unavailable. Your TP balance is not the cause."),
    "PAID_PROVIDER_FORBIDDEN": (502, "paid_provider_forbidden", "Paid cannot complete this request. Contact support with the reference code."),
    "PAID_PROVIDER_REQUEST": (502, "paid_provider_request", "Paid did not accept this request. Contact support with the reference code."),
    "PAID_PROVIDER_LIMITED": (502, "paid_provider_limited", "The upstream provider limited this Paid request. Review the original operation before retrying."),
    "PAID_PROVIDER_FAILED": (502, "paid_provider_failed", "Paid upstream failure. Check whether this operation still has reserved credits before retrying."),
    "PROVIDER_UNAVAILABLE": (502, "paid_provider_failed", "Paid could not complete this request. Contact support with the reference code."),
    "INSUFFICIENT_CREDITS": (402, "paid_insufficient_credits", "Eligible Paid credits for this model are exhausted."),
    "PAID_CREDITS_RESERVED": (429, "paid_credits_reserved", "Eligible credits are reserved by another Paid operation. Wait for settlement or review that operation; no new AI request was sent."),
    "PAID_THINKING_UNSUPPORTED": (400, "paid_thinking_unsupported", "The selected Paid model cannot execute this Thinking choice."),
    "PAID_THINKING_UNVERIFIED": (400, "paid_thinking_unverified", "Thinking for this Paid model could not be verified. Contact support."),
    "PAID_OUTPUT_UNSUPPORTED": (400, "paid_output_unsupported", "This Paid model cannot provide a usable response size. Select another model or contact support."),
    "PAID_IMAGE_UNSUPPORTED": (400, "paid_image_unsupported", "Select a verified vision model or turn off Page image to AI."),
    "PAID_IMAGE_INVALID": (400, "paid_image_invalid", "Paid requires valid inline static image data."),
    "PAID_IMAGE_TOO_LARGE": (413, "paid_image_too_large", "The Paid image request exceeds its size limit."),
    "PAID_RATE_LIMITED": (429, "paid_rate_limited", "Too many Paid requests. Wait before starting a new operation."),
    "AI_NOT_CONFIGURED": (503, "paid_ai_not_configured", "Paid translation is not available yet."),
    "PAID_PAUSED": (503, "paid_paused", "The operator has paused Paid translation."),
    "PAID_REFUND_PENDING": (403, "paid_refund_pending", "Paid is temporarily paused while the refund is confirmed."),
    "PAID_ACCOUNT_RESTRICTED": (403, "paid_account_restricted", "Paid is restricted pending refund/dispute review."),
    "PAID_DAILY_BUDGET": (429, "paid_daily_budget", "The operator's Paid budget is fully allocated."),
    "PAID_BUSY": (429, "paid_pending_calls", "Review pending Paid requests before starting another."),
    "PROVIDER_OUTCOME_UNKNOWN": (503, "paid_outcome_pending", "The Paid outcome is unconfirmed. Review this operation; do not submit a new one."),
    "USAGE_UNCONFIRMED": (503, "paid_outcome_pending", "Provider cost is unconfirmed; the reservation is awaiting operator review."),
    "REQUEST_ALREADY_DISPATCHED": (409, "paid_already_dispatched", "This Paid operation was dispatched already. Review its history before submitting again."),
    "IDEMPOTENCY_CONFLICT": (409, "paid_operation_conflict", "This operation ID belongs to another request."),
    "MODEL_NOT_ALLOWED": (403, "paid_model_not_allowed", "This model is not enabled for Paid translation."),
    "MODEL_PRICE_UNVERIFIED": (503, "paid_price_unverified", "This Paid model is not available yet. Contact support."),
    "PAID_PRICE_REFRESHING": (503, "paid_price_refreshing", "Current Paid route prices are updating. No AI request or credit reservation was made; wait and check prices again."),
    "PAID_ROUTE_UNAVAILABLE": (503, "paid_route_unavailable", "No verified priced route supports these Paid options. No AI request or credit reservation was made."),
    "PAID_QUOTE_REQUIRED": (409, "paid_quote_required", "Start a new translation to check current prices. The original click price approval is unavailable; no new AI request or credit reservation was made."),
    "PAID_QUOTE_INVALID": (409, "paid_quote_invalid", "This Paid price quote is invalid. Check prices again; no AI request or credit reservation was made."),
    "PAID_QUOTE_STALE": (409, "paid_quote_stale", "The Paid price approval or options changed. Start a new translation to check prices; no new AI request or credit reservation was made."),
    "PAID_QUOTE_PRICE_CHANGED": (409, "paid_quote_price_changed", "The Paid route price changed from the click approval. Start a new translation to check prices; no new AI request or credit reservation was made."),
    "LEGACY_PAID_RECONCILIATION_REQUIRED": (503, "paid_reconciliation_required", "Earlier Paid requests are awaiting review. Contact support."),
    "LEDGER_UNAVAILABLE": (503, "paid_ledger_unavailable", "Paid credits are undergoing an integrity check."),
    "PROVIDER_OUTPUT_INVALID": (502, "paid_output_invalid", "The unusable Paid output was refunded and the operator notified."),
}

def _paid_failure(exc):
    if getattr(exc, "provider", "") != "paid":
        return None
    # Only the Paid adapter supplies center_http_status after observing a
    # structured upstream_http_status. A verified provider 429 must retain
    # Retry-After through the ordinary rate-limit path. Wallet/admission 429s
    # and unconfirmed Paid errors keep their original financial semantics.
    outer = getattr(exc, 'center_http_status', None)
    if (isinstance(exc, ProviderHttpError) and
            getattr(exc, 'provider_code', '') == 'PAID_PROVIDER_LIMITED' and
            type(outer) is int and 400 <= outer <= 599 and
            structured_upstream_http_status(exc) == 429):
        return None
    if isinstance(exc, ProviderTransportError):
        if getattr(exc,'centerAdmissionRejected',False) is True and getattr(exc,'requestDispatched',None) is False:
            return (503,'paid_price_check_unavailable','Current Paid prices could not be verified. No new AI request or credit reservation was made; check the original operation again later.')
        return (503, "paid_outcome_pending", "The Paid outcome is unconfirmed. Reuse the original operation ID; do not start a new paid operation.")
    return _PAID_ERRORS.get(getattr(exc, "provider_code", ""))

def classify(exc: BaseException) -> str:
    """Return a stable reason code while the trace keeps the original message.

    Provider clients use different exception classes and wording.  These labels
    let operators search TP_TRACE across Gemini, Anthropic, OpenAI-compatible,
    Hugging Face and local models without pretending the providers are alike.
    """
    stop = getattr(exc, "stream_stop_code", None)
    if isinstance(stop, str) and stop in _STREAM_STOPS:
        return stop  # also for Paid: the Center reports the same stop codes
    paid = _paid_failure(exc)
    if paid:
        return paid[1]
    if isinstance(exc, ModelOutputContractError):
        code = getattr(exc, "code", "")
        if code in {"wrong_language_output", "AI_OUTPUT_CONTRACT_MISMATCH"}:
            return code
        return "invalid_model_output"
    if isinstance(exc, ProviderAdapterContractError):
        return "provider_client_contract_error"
    if isinstance(exc, ProviderTransportError):
        return "provider_transport"
    upstream_status = upstream_http_status(exc)
    if upstream_status == 504:
        return "provider_timeout"
    # Structured HTTP evidence first: 402 Payment Required is the provider's
    # billing answer, 404 on a provider call means the model (or its route)
    # does not exist for this account. Both have specific client messages
    # (old and new extensions: billing_required / provider_model_not_found).
    if upstream_status == 402:
        return "billing_required"
    if upstream_status == 404:
        return "provider_model_not_found"
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
        "user location is not supported", "unsupported_country_region_territory",
        "country, region, or territory not supported",
    )):
        return "provider_region_unsupported"
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
    if upstream_status is not None or isinstance(exc, ProviderHttpError) or "http " in message:
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
    # Structured HTTP evidence wins over incidental words/numbers in the
    # provider message or model ID. A 503 overload is not an account 429;
    # a 401 containing a model named 429 must remain an authentication error.
    if _paid_failure(exc):
        return False
    status = structured_upstream_http_status(exc)
    if status is not None:
        return status == 429
    if isinstance(exc, (ProviderTransportError, ProviderAdapterContractError)):
        return False
    message = str(exc).lower()
    return any(marker in message for marker in _RATE_LIMIT_MARKERS)

def retry_after_sec(exc: BaseException) -> float:
    """Seconds the provider asked us to wait, or 0 when it did not say."""
    import re

    structured = getattr(exc, "retry_after_sec", None)
    if isinstance(structured, (int, float)) and not isinstance(structured, bool) and 0 < structured <= 3600:
        return float(structured)

    match = re.search(r"retry[-_ ]?after[\"\':= ]+(\d+(?:\.\d+)?)", str(exc), re.IGNORECASE)
    return float(match.group(1)) if match else 0.0

@dataclass(frozen=True)
class ProviderHttpFailure:
    status: int
    code: str
    message: str
    retryable: bool
    retry_after: int = 0

# Phase-aware stream stops (transports/stream_progress.py). Only a stall
# invites a retry: a model that thought past its budget or wrote without
# completing lines would very likely do the same again.
_STREAM_STOPS = {
    "ai_provider_stalled": ("The AI provider stopped responding (no reasoning or text).", True),
    "ai_thinking_too_long": ("The AI model thought past its time budget without starting the answer.", False),
    "ai_output_no_progress": ("The AI model kept writing without completing another line.", False),
    "ai_stream_ceiling": ("The AI response exceeded the safety time ceiling.", False),
}

def provider_http_failure(exc: BaseException) -> ProviderHttpFailure:
    """Map an upstream/provider failure without returning its raw message."""
    paid = _paid_failure(exc)
    stop = getattr(exc, "stream_stop_code", None)
    if paid and stop in _STREAM_STOPS:
        # The Center stopped the stream (credit released, nothing charged):
        # show why, keeping the Paid status and no automatic retry.
        return ProviderHttpFailure(paid[0], stop, _STREAM_STOPS[stop][0], False)
    if paid:
        return ProviderHttpFailure(*paid, False)
    reason = classify(exc)
    if reason in _STREAM_STOPS:
        message, retryable = _STREAM_STOPS[reason]
        return ProviderHttpFailure(502, reason, message, retryable)
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
    upstream_status = upstream_http_status(exc)
    if upstream_status == 504:
        return ProviderHttpFailure(
            502, "provider_timeout",
            "The AI provider returned HTTP 504 (gateway timeout).", True,
        )
    if upstream_status == 413:
        return ProviderHttpFailure(
            502, "provider_payload_too_large",
            "The AI provider rejected this request because it was too large.", False,
        )
    if reason == "provider_model_not_found":
        return ProviderHttpFailure(
            502, "provider_model_not_found",
            "The configured AI model was not found or is not available (model not found or not available).",
            False,
        )
    if reason == "provider_model_access_denied":
        return ProviderHttpFailure(
            502, reason,
            "The configured account does not have access to this AI model.", False,
        )
    if reason == "provider_region_unsupported":
        return ProviderHttpFailure(
            502, reason, "The AI provider does not serve this account's region.", False,
        )
    if reason == "provider_content_blocked":
        return ProviderHttpFailure(
            502, reason, "The AI provider refused this content.", False,
        )
    if reason == "provider_client_contract_error":
        return ProviderHttpFailure(
            500, reason,
            "A TextPhantom provider adapter is incompatible with the router.", False,
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
        "invalid_model_output", "wrong_language_output", "incomplete_output", "generation_stopped",
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
