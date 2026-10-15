"""Operator-owned Center target and bounded HTTP proxy for customer identity."""
from urllib.parse import urlsplit
import httpx
from backend.config import settings
from backend import diagnostics
from time import perf_counter
from contextvars import ContextVar
from pathlib import Path
import re
import ipaddress
from backend.gateway_proof import AUTH_PATHS, headers as peer_headers
center_response_id = ContextVar("center_response_id", default="")
# One random id per extension install (browser profile). Only this exact shape is
# forwarded to Center, which stores only a keyed commitment. Never logged.
INSTALL_HEADER = "X-TP-Install"
_INSTALL = re.compile(r"[a-f0-9]{32}")


def install_id(value):
    return value if isinstance(value, str) and _INSTALL.fullmatch(value) else None
center_response_meta = ContextVar("center_response_meta", default=None)
# Opaque per-topic change tokens of the signed-in customer (support chat,
# account/balance, prices). Relayed unchanged; the extension fetches a topic only
# when its token changed. Only this exact shape passes.
CHANGES_HEADER = "X-TP-Changes"
center_changes = ContextVar("center_changes", default="")
_CHANGES = re.compile(r"v1(?:;[a-z]{1,16}=[a-f0-9]{6,32}){1,12}")


def valid_changes(value):
    return value if isinstance(value, str) and len(value) <= 400 and _CHANGES.fullmatch(value) else ""


async def authorize_replay(bearer, *, correlation=None):
    """A cached Paid answer still requires a current Center customer session."""
    from fastapi import HTTPException
    from backend.api.errors import payload as error_payload
    try:
        status, body = await customer_request("/api/customer/me", bearer=str(bearer or "").strip())
    except (httpx.HTTPError, TimeoutError):
        status, body = 503, {}
    if status == 200 and body.get("ok") is True:
        return
    if status == 401:
        code, message = "paid_login_required", "Your Paid session expired or was revoked. Sign in again."
    elif status == 503:
        code, message = "center_unavailable", "Center could not verify your Paid session. Try the original operation again later."
    else:
        status = 502
        code, message = "center_response_invalid", "Center could not confirm your Paid session."
    raise HTTPException(status, detail=error_payload(
        code=code, message=message, user_message=message, origin="center",
        stage="paid_replay_auth", category="authentication" if status == 401 else "availability",
        retryable=status == 503, http_status=status, correlation=correlation,
        extra={"providerAttempts": 0, "generationAttempts": 0, "requestDispatched": False}))


def center_base_url():
    raw = str(settings.center_url or "").strip().rstrip("/")
    if not raw:
        return ""
    parsed = urlsplit(raw)
    try:
        port = parsed.port
    except ValueError:
        raise RuntimeError("TP_CENTER_URL must have a valid port (1–65535)") from None
    if port == 0:
        raise RuntimeError("TP_CENTER_URL must have a valid port (1–65535)")
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or
            parsed.password or parsed.query or parsed.fragment or
            parsed.path not in {"", "/"}):
        raise RuntimeError("TP_CENTER_URL must be a plain Center origin without a path")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError("Remote TP_CENTER_URL requires HTTPS")
    return raw


def center_origin():
    url = urlsplit(center_base_url())
    return f"{url.scheme}://{url.netloc}"


def require_center():
    value = center_base_url()
    if not value:
        raise RuntimeError("Paid is not configured on this API")
    return value


def gateway_key():
    path = settings.center_gateway_key_file
    secret = settings.center_gateway_key
    if not path and not secret:
        return ''
    if path:
        try:
            file_secret = Path(path).read_text().strip()
        except (OSError, UnicodeError):
            raise RuntimeError('TP_CENTER_GATEWAY_KEY_FILE must point to the copied Center gateway.key') from None
        if secret and secret != file_secret:
            raise RuntimeError('TP_CENTER_GATEWAY_KEY conflicts with TP_CENTER_GATEWAY_KEY_FILE')
        secret = file_secret
    if not re.fullmatch(r'[a-f0-9]{64}', secret):
        raise RuntimeError('Center gateway key must contain exactly 64 lowercase hexadecimal characters')
    return secret


def trusted_proxy_hosts():
    hosts = [x.strip() for x in settings.trusted_proxy_ips.split(',') if x.strip()]
    try:
        if any(ipaddress.ip_network(x).prefixlen == 0 for x in hosts):
            raise ValueError()
    except ValueError:
        raise RuntimeError('TP_TRUSTED_PROXY_IPS requires explicit IPs/CIDRs; trust-all is not allowed') from None
    return hosts


async def customer_request(path, *, method="GET", body=None, bearer="", peer=None, timeout=15, install=None):
    center_response_id.set("")
    center_response_meta.set(None)
    center_changes.set("")
    base = require_center()
    headers = {"Accept": "application/json", **diagnostics.headers()}
    started = perf_counter()
    diagnostics.emit("center.request.started", method=method, path=path, origin=diagnostics.origin(base), authenticated=bool(bearer), connect_timeout_seconds=4, timeout_seconds=timeout)
    if method != "GET":
        headers.update({"Origin": center_origin(), "Content-Type": "application/json"})
    if bearer:
        headers["Authorization"] = "Bearer " + bearer
    if install_id(install):
        headers[INSTALL_HEADER] = install
    if peer is not None and path in AUTH_PATHS and (secret := gateway_key()):
        headers.update(peer_headers(secret, peer, method, path, body))
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=4), follow_redirects=False,
                                     trust_env=False) as client:
            response = await client.request(method, base + path, headers=headers, json=body)
    except (httpx.HTTPError, TimeoutError) as exc:
        center_response_meta.set({'response_kind': 'transport', 'error_type': type(exc).__name__})
        diagnostics.emit("center.request.failed", outcome="error", method=method, path=path,
            elapsed_ms=round((perf_counter()-started)*1000,2), **diagnostics.fault(exc))
        raise
    center_response_id.set(diagnostics.valid_id(response.headers.get("x-request-id", "")) or "")
    center_changes.set(valid_changes(response.headers.get("x-tp-changes", "")))
    status_code = response.status_code
    center_response_meta.set({'upstream_status': status_code, 'response_kind': 'json'})
    try:
        payload = response.json()
    except ValueError as exc:
        center_response_meta.set({'upstream_status': response.status_code,
                                  'response_kind': 'non_json', 'error_type': type(exc).__name__})
        diagnostics.emit("center.response.invalid", outcome="error", http_status=response.status_code, **diagnostics.fault(exc))
        status_code = 502
        payload = {"error": {"code": "CENTER_RESPONSE_INVALID", "message": "Center ตอบไม่ถูกต้อง"}}
    if not isinstance(payload, dict):
        center_response_meta.set({'upstream_status': response.status_code, 'response_kind': 'non_object'})
        status_code = 502
        payload = {"error": {"code": "CENTER_RESPONSE_INVALID", "message": "Center ตอบไม่ถูกต้อง"}}
    error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    diagnostics.emit("center.request.completed", outcome="received" if path.endswith("/auth/request") and status_code == 200 else "ok" if status_code < 400 else "rejected", method=method, path=path,
        http_status=status_code, upstream_http_status=response.status_code, error_code=error.get("code"), available=payload.get("available"),
        request_status=payload.get("request_status"), delivery_status=payload.get("delivery_status"),
        availability_code=payload.get("code"), center_request_id=response.headers.get("x-request-id"),
        center_trace_id=response.headers.get("x-tp-trace-id"), elapsed_ms=round((perf_counter()-started)*1000,2))
    return status_code, payload
