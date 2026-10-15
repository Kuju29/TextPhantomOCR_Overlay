"""Bounded native-provider HTTPS; no redirects, environment proxies or replay."""
import json
from urllib.parse import urlsplit
import httpx
from .login_provider_contract import LoginError
from . import login_observability as diagnostic

ORIGINS = frozenset({"auth.openai.com", "api.openai.com", "oauth2.googleapis.com",
    "www.googleapis.com", "generativelanguage.googleapis.com", "openrouter.ai", "huggingface.co", "router.huggingface.co"})
MAX_RESPONSE = 8*1024*1024
PROVIDER_REASONS = frozenset({"invalid_grant", "invalid_client", "invalid_scope", "access_denied", "invalid_request", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused", "http_rejected", "transport_error", "invalid_response", "SERVICE_DISABLED", "BILLING_DISABLED", "CONSUMER_INVALID", "USER_PROJECT_DENIED", "PROJECT_INVALID", "IAM_PERMISSION_DENIED", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "API_KEY_INVALID", "PERMISSION_DENIED", "UNAUTHENTICATED", "RESOURCE_EXHAUSTED", "INVALID_ARGUMENT", "NOT_FOUND", "FAILED_PRECONDITION", "INTERNAL", "UNAVAILABLE"})
PROVIDER_REASONS |= frozenset({'deepseek_envelope_invalid', 'deepseek_business_status_missing',
    'deepseek_business_data_invalid', 'deepseek_session_id_missing', 'deepseek_session_id_invalid', 'deepseek_session_id_conflict',
    'deepseek_endpoint_rejected', 'deepseek_business_rejected'})
PROVIDER_REASONS |= frozenset({'browser_challenge_header', 'browser_challenge_platform', 'browser_challenge_title'})
PROVIDER_REASONS |= frozenset({'native_preparation_required', 'native_preparation_rejected', 'native_preparation_missing'})
PROVIDER_REASONS |= frozenset({'provider_error_reply'})
PROVIDER_REASONS |= frozenset({'provider_server_error', 'provider_overloaded'})

def provider_reason(raw):
    """Extract only public structured enums; never descriptions or metadata."""
    try:
        data = json.loads(raw)
        error = data.get("error") if isinstance(data, dict) else None
        if isinstance(error, str):
            return error if error in PROVIDER_REASONS else "http_rejected"
        if isinstance(error, dict):
            details = error.get("details")
            for detail in details if isinstance(details, list) else []:
                if isinstance(detail, dict) and detail.get("@type") == "type.googleapis.com/google.rpc.ErrorInfo" and detail.get("reason") in PROVIDER_REASONS:
                    return detail["reason"]
            if error.get("status") in PROVIDER_REASONS:
                return error["status"]
    except (ValueError, TypeError):
        pass
    return "http_rejected"


def request(url, *, method="GET", body=None, form=None, headers=None, query=None, inference=False, sse=False, oauth=False):
    try:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname not in ORIGINS or parsed.port not in (None, 443) or parsed.username or parsed.password or parsed.fragment:
            raise ValueError()
    except ValueError:
        raise LoginError("login_provider_contract", "Invalid Login provider request.", 503) from None
    request_headers = {"Accept": "text/event-stream" if sse else "application/json", **(headers or {})}
    stage = "inference" if inference else "token_refresh" if form and form.get("grant_type") == "refresh_token" else "token_exchange" if oauth else "model_catalogue" if "/models" in parsed.path else "identity" if "userinfo" in parsed.path else "grant_validation" if parsed.path.endswith("/key") else "provider_metadata"
    diagnostic.stage(stage)
    try:
        with httpx.Client(timeout=httpx.Timeout(250 if inference else 25, connect=10), trust_env=False, follow_redirects=False) as client:
            with client.stream(method, url, params=query, json=body, data=form, headers=request_headers) as response:
                diagnostic.emit("provider_response", upstreamStatus=response.status_code)
                raw = bytearray()
                for chunk in response.iter_bytes():
                    if len(raw)+len(chunk) > MAX_RESPONSE:
                        raise ValueError()
                    raw.extend(chunk)
                if not 200 <= response.status_code < 300:
                    status = response.status_code
                    terminal = False
                    if oauth:
                        try:
                            detail = json.loads(raw)
                            reason = detail.get("error") if isinstance(detail, dict) else None
                        except ValueError:
                            reason = None
                        terminal = isinstance(reason, str) and reason in {"invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"}
                        code, message, mapped = ("login_session_expired", "Sign in to your AI account again.", 401) if terminal else ("login_setup_required", "This API needs a valid provider Login configuration.", 503) if reason == "invalid_client" else ("login_provider_unavailable", "The provider did not accept this sign-in. Start a new attempt.", 503)
                    else:
                        code, message, mapped = ("login_quota_exceeded", "Your AI account quota is unavailable. Try again later.", 429) if status in {402, 429} else ("login_session_expired", "Sign in to your AI account again.", 401) if status == 401 else ("login_provider_access_denied", "The provider denied this grant. Check account/project permissions and API billing.", 403) if status == 403 else ("login_model_unavailable", "The selected Login model is unavailable.", 502) if status in {400, 404} else ("login_provider_unavailable", "AI Login is temporarily unavailable.", 503)
                    error = LoginError(code, message, mapped)
                    error.stage = stage
                    error.requestDispatched = inference
                    error.oauth_terminal = terminal
                    error.upstream_status = status
                    error.provider_reason = provider_reason(raw)
                    raise error
                if sse:
                    return bytes(raw)
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise ValueError()
                return data
    except LoginError:
        raise
    except (httpx.HTTPError, ValueError, TypeError) as cause:
        error = LoginError("login_provider_unavailable", "AI Login could not confirm the response. This request will not be replayed automatically.", 503)
        error.stage = stage
        if "response" in locals():
            error.upstream_status = response.status_code
        error.requestDispatched = inference
        error.oauth_ambiguous = oauth
        error.cause_class = type(cause).__name__
        error.provider_reason = "transport_error" if isinstance(cause, httpx.HTTPError) else "invalid_response"
        raise error from None


def events(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_RESPONSE:
        raise LoginError("login_response_invalid", "Invalid AI Login stream.", 502)
    try:
        text = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
        records = text.split("\n\n")
        if records[-1].strip():
            raise ValueError()
        for record in records[:-1]:
            data = "\n".join(line[5:].lstrip(" ") for line in record.split("\n") if line.startswith("data:"))
            if not data or data == "[DONE]":
                continue
            value = json.loads(data)
            if not isinstance(value, dict):
                raise ValueError()
            yield value
    except (UnicodeError, ValueError):
        raise LoginError("login_response_invalid", "Invalid AI Login stream.", 502) from None
