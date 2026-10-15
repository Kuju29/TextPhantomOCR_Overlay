"""Request ingress bounds for a shared API: body size and per-identity quotas.

Two pure-ASGI middlewares, applied before any route parses a body:

``BodyLimitMiddleware``
    Rejects a request whose body is larger than its route class allows, first by
    ``Content-Length`` (no byte is read) and then while the body streams (chunked
    uploads or a lying header). Without it a single 300 MB POST to
    ``/v1/translate`` was buffered and JSON-decoded in full (~990 MB RSS).

    Route classes (sizes in bytes, all overridable by environment):

    * image routes - the routes that carry one page image (data URI, multipart
      upload, support attachment, Login relay body). The cap is the base64 size
      of the largest image the API accepts (``TP_MAX_IMAGE_BYTES``, default
      24 MiB -> 32 MiB of base64) plus 2 MiB of JSON/multipart framing:
      34 MiB by default (``TP_MAX_IMAGE_BODY_BYTES``).
    * whole-job routes (``/translate``, ``/v1/translate``, runs:API): the
      extension posts its whole job payload, and for an inline ``data:`` image
      both ``src`` and ``imageDataUri`` hold the same data URI, so the image
      can legitimately appear twice: 2 x 32 MiB + 2 MiB = 66 MiB by default.
    The extension refuses fetched images above 25 MB before encoding and the API
    rejects decoded images above ``TP_MAX_IMAGE_BYTES``, so no legitimate
    request reaches these bounds.
    * diagnostic/decode routes that already bound their own content at 2 MiB:
      4 MiB, leaving room for JSON framing.
    * every other body: 2 MiB (``TP_MAX_JSON_BODY_BYTES``). Routes with smaller
      limits (logs 128 KiB, trace 512 KiB, support messages 32 KiB, repair runs
      2 MiB) keep enforcing them.

``IdentityQuotaMiddleware``
    A token bucket per caller identity on the expensive Lens/AI/translate routes
    so one caller cannot occupy the shared admission gates and pools. The
    identity is, in order: the extension install id (``X-TP-Install``, 32 hex),
    the client IP when it is trustworthy (see :func:`trusted_client_ip`), the
    tab session (``X-TP-Tab-Session``), or nothing. A trusted client IP also has
    its own, wider bucket so many installs behind one address still share a
    bound. Over-limit requests get ``429`` with ``Retry-After``.

    The same identity is published in a context variable for the pools that cap
    per-identity occupancy (job queue, conversations, repair runs).

Identities are client-chosen except a trusted IP. They make one ordinary user
unable to exhaust shared capacity by accident or with one client; an attacker
rotating ids is still bounded by the global pools and admission gates.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import os
import re
import threading
import time
from contextvars import ContextVar
from typing import Any

from fastapi import HTTPException

from backend.config import settings
from backend.deployment import env_flag, public_deployment

ERROR_SCHEMA = "tp.error/1"
MiB = 1024 * 1024
_INSTALL = re.compile(r"[a-f0-9]{32}")
_BODY_METHODS = {"POST", "PUT", "PATCH"}

JOB_ROUTES = frozenset({
    "/translate",
    "/v1/translate",
    "/v2/engine/runsapi/translate",
})
IMAGE_ROUTES = frozenset({
    "/v1/lens/raw",
    "/v2/engine/runsextension/lens/raw",
    "/v1/lens/fallback",
    "/v2/engine/runsextension/groups",
    "/v1/ai/translate",
    "/v2/engine/runsextension/ai/translate",
    "/v2/engine/runsextension/login/translate",
    "/paid/support/attachments",
    "/login/relay/result",
})
MEDIUM_ROUTES = frozenset({
    "/v1/lens/decode",
    "/v2/engine/runsextension/ai/local-wire-trace",
})
# Routes whose work occupies shared Lens / grouping / AI capacity.
QUOTA_ROUTES = frozenset({
    "/translate",
    "/v1/translate",
    "/v2/engine/runsapi/translate",
    "/v1/lens/raw",
    "/v2/engine/runsextension/lens/raw",
    "/v1/lens/fallback",
    "/v1/lens/decode",
    "/v2/engine/runsextension/groups",
    "/v1/ai/translate",
    "/v2/engine/runsextension/ai/translate",
    "/v2/engine/runsextension/login/translate",
    "/ai/resolve",
    "/v2/engine/runsextension/repair-runs",
})
# Routes that upload to Google Lens: their arrival is the "sign of use" that
# starts a non-blocking cookie refresh when the jar is near expiry.
LENS_ROUTES = frozenset({
    "/translate", "/v1/translate", "/v2/engine/runsapi/translate",
    "/v1/lens/raw", "/v2/engine/runsextension/lens/raw", "/v1/lens/fallback",
})
_REPAIR_TRANSLATE = re.compile(r"/v2/engine/runsextension/repair-runs/[^/]+/tasks/[^/]+/translate")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return default


# --- body size ---------------------------------------------------------------

def _image_b64_bytes() -> int:
    return 4 * math.ceil(int(settings.max_image_bytes) / 3)


def image_body_limit() -> int:
    """Base64 of the largest accepted image plus 2 MiB of request framing."""
    explicit = _env_int("TP_MAX_IMAGE_BODY_BYTES", 0)
    if explicit > 0:
        return explicit
    return _image_b64_bytes() + 2 * MiB


def job_body_limit() -> int:
    """Whole-job payloads may carry the inline image twice (src + imageDataUri)."""
    explicit = _env_int("TP_MAX_JOB_BODY_BYTES", 0)
    if explicit > 0:
        return explicit
    explicit_image = _env_int("TP_MAX_IMAGE_BODY_BYTES", 0)
    if explicit_image > 0:
        return 2 * explicit_image
    return 2 * _image_b64_bytes() + 2 * MiB


def json_body_limit() -> int:
    return max(64 * 1024, _env_int("TP_MAX_JSON_BODY_BYTES", 2 * MiB))


def body_limit_for(path: str) -> int:
    if path in JOB_ROUTES:
        return job_body_limit()
    if path in IMAGE_ROUTES:
        return image_body_limit()
    if path in MEDIUM_ROUTES:
        return max(4 * MiB, json_body_limit())
    return json_body_limit()


class BodyTooLarge(HTTPException):
    """Raised from ``receive``. An HTTPException so FastAPI's body parser (which
    turns other exceptions into a generic 400) and the app's handler keep 413."""

    def __init__(self, limit: int):
        super().__init__(status_code=413, detail=_too_large(limit), headers={"Connection": "close"})
        self.limit = limit


def _error(status: int, code: str, message: str, *, stage: str, category: str,
           retryable: bool, extra: dict[str, Any] | None = None) -> dict:
    from backend.api.errors import payload
    return payload(code=code, message=message, user_message=message, origin="client",
                   stage=stage, category=category, retryable=retryable,
                   http_status=status, extra=extra or {})


async def _send_json(send, status: int, detail: dict, headers: dict[str, str] | None = None) -> None:
    body = json.dumps({"detail": detail}, ensure_ascii=False).encode()
    raw = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
           (b"cache-control", b"no-store"), (b"x-tp-error-schema", ERROR_SCHEMA.encode()),
           (b"connection", b"close")]
    raw += [(k.lower().encode(), str(v).encode()) for k, v in (headers or {}).items()]
    await send({"type": "http.response.start", "status": status, "headers": raw})
    await send({"type": "http.response.body", "body": body})


def _too_large(limit: int) -> dict:
    return _error(413, "request_too_large",
                  f"The request body is larger than this route accepts ({limit} bytes).",
                  stage="ingress_body_limit", category="input", retryable=False,
                  extra={"maxBytes": limit})


class BodyLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("method") not in _BODY_METHODS:
            return await self.app(scope, receive, send)
        limit = body_limit_for(scope.get("path") or "")
        declared = None
        for key, value in scope.get("headers") or ():
            if key == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    declared = -1
                break
        if declared is not None and (declared < 0 or declared > limit):
            if declared < 0:
                return await _send_json(send, 400, _error(
                    400, "invalid_content_length", "Content-Length is not a valid number.",
                    stage="ingress_body_limit", category="input", retryable=False))
            return await _send_json(send, 413, _too_large(limit))

        received = 0
        started = False

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body") or b"")
                if received > limit:
                    raise BodyTooLarge(limit)
            return message

        async def tracking_send(message):
            nonlocal started
            if message.get("type") == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except BodyTooLarge as exc:
            if started:
                raise
            await _send_json(send, 413, _too_large(exc.limit))


# --- caller identity -----------------------------------------------------------

_identity: ContextVar[str | None] = ContextVar("tp_caller_identity", default=None)


def current_identity() -> str | None:
    """Opaque quota identity of the request being served (``None`` if unknown)."""
    return _identity.get()


def _header(scope, name: bytes) -> str:
    for key, value in scope.get("headers") or ():
        if key == name:
            try:
                return value.decode("latin-1")
            except UnicodeDecodeError:
                return ""
    return ""


def _proxy_networks() -> list:
    from backend.paid_center import trusted_proxy_hosts
    out = []
    for item in trusted_proxy_hosts():
        try:
            out.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            continue
    return out


def trusted_client_ip(host: str | None) -> str | None:
    """The caller's IP only when it is evidence, never a shared proxy address.

    * ``TP_TRUSTED_PROXY_IPS`` configured: Uvicorn's proxy middleware already
      replaced the peer with the forwarded client when (and only when) the TCP
      peer is one of those proxies. An address that is still a proxy is not a
      client.
    * Public deployment without trusted proxies (a HF Space): every request
      arrives from the platform proxy, so no client IP is known.
    * Private deployment, no proxies: the TCP peer is the client only when it
      is a global address; a loopback/private/Docker-bridge peer is typically a
      local reverse proxy shared by everyone behind it.
    """
    try:
        ip = ipaddress.ip_address(str(host or ""))
    except ValueError:
        return None
    networks = _proxy_networks()
    if any(ip in net for net in networks):
        return None
    if networks:
        return str(ip)
    if public_deployment():
        return None
    return str(ip) if ip.is_global else None


def install_id(value: str | None) -> str | None:
    return value if isinstance(value, str) and _INSTALL.fullmatch(value) else None


def _opaque(kind: str, value: str) -> str:
    return kind + ":" + hashlib.sha256((kind + "\0" + value).encode()).hexdigest()[:24]


def resolve_identity(scope) -> tuple[str | None, str | None]:
    """``(identity, trusted_ip)`` for an ASGI HTTP scope."""
    client = scope.get("client") or (None, None)
    ip = trusted_client_ip(client[0] if client else None)
    install = install_id(_header(scope, b"x-tp-install").strip())
    if install:
        return _opaque("install", install), ip
    if ip:
        return _opaque("ip", ip), ip
    tab = _header(scope, b"x-tp-tab-session").strip()[:160]
    if tab:
        return _opaque("tab", tab), ip
    return None, ip


# --- token buckets ------------------------------------------------------------

class TokenBuckets:
    """Bounded in-memory token buckets keyed by an opaque identity."""

    def __init__(self, *, max_keys: int = 50_000, clock=time.monotonic):
        self._rows: dict[str, list[float]] = {}
        self._lock = threading.Lock()
        self._max_keys = max_keys
        self._clock = clock

    def take(self, key: str, *, burst: float, rate: float, cost: float = 1.0) -> float:
        """Spend ``cost``; return 0 when allowed, else seconds until it would be."""
        now = self._clock()
        with self._lock:
            row = self._rows.get(key)
            if row is None:
                if len(self._rows) >= self._max_keys:
                    self._prune(now, burst, rate)
                row = self._rows[key] = [burst, now]
            tokens = min(burst, row[0] + (now - row[1]) * rate)
            row[1] = now
            if tokens >= cost:
                row[0] = tokens - cost
                return 0.0
            row[0] = tokens
            return (cost - tokens) / rate if rate > 0 else 60.0

    def _prune(self, now: float, burst: float, rate: float) -> None:
        # Full buckets carry no state; drop them first, then the oldest rows.
        full = [k for k, (tokens, at) in self._rows.items()
                if rate <= 0 or tokens + (now - at) * rate >= burst]
        for key in full:
            del self._rows[key]
        while len(self._rows) >= self._max_keys:
            self._rows.pop(next(iter(self._rows)))

    def clear(self) -> None:
        with self._lock:
            self._rows.clear()


buckets = TokenBuckets()


def quota_policy() -> dict[str, float] | None:
    """Current bucket sizes, or ``None`` when quotas are switched off."""
    enabled = env_flag("TP_IDENTITY_QUOTAS")
    if enabled is False:
        return None
    rate = max(0.0, _env_float("TP_IDENTITY_RATE_PER_SEC", 4.0))
    if rate <= 0:
        return None
    return {
        "burst": max(1.0, _env_float("TP_IDENTITY_BURST", 240.0)),
        "rate": rate,
        "ip_burst": max(1.0, _env_float("TP_IP_BURST", 960.0)),
        "ip_rate": max(0.01, _env_float("TP_IP_RATE_PER_SEC", 16.0)),
        # Requests that carry no identity at all share one bucket only when the
        # operator asks for it: until every client sends X-TP-Install, a shared
        # anonymous bucket would throttle all users together.
        "anonymous_burst": max(1.0, _env_float("TP_ANONYMOUS_BURST", 480.0)),
        "anonymous_rate": max(0.0, _env_float("TP_ANONYMOUS_RATE_PER_SEC", 0.0)),
    }


def is_quota_route(path: str) -> bool:
    return path in QUOTA_ROUTES or bool(_REPAIR_TRANSLATE.fullmatch(path))


def _loopback_private_caller(scope) -> bool:
    """The desktop launcher / personal API: a loopback peer of a private deployment."""
    if public_deployment():
        return False
    client = scope.get("client") or (None, None)
    try:
        return ipaddress.ip_address(str(client[0] or "")).is_loopback
    except ValueError:
        return False


class IdentityQuotaMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        identity, ip = resolve_identity(scope)
        local = _loopback_private_caller(scope)
        # The desktop launcher / a personal API on loopback is its only tenant:
        # no per-identity bucket or pool share, exactly as before.
        token = _identity.set(None if local else identity)
        try:
            if scope.get("method") == "POST" and is_quota_route(scope.get("path") or ""):
                policy = quota_policy()
                if policy is not None and not local:
                    wait = 0.0
                    if identity:
                        wait = buckets.take(identity, burst=policy["burst"], rate=policy["rate"])
                    elif policy["anonymous_rate"] > 0:
                        wait = buckets.take("anonymous", burst=policy["anonymous_burst"],
                                            rate=policy["anonymous_rate"])
                    if not wait and ip and identity and not identity.startswith("ip:"):
                        wait = buckets.take("ipbucket:" + ip, burst=policy["ip_burst"],
                                            rate=policy["ip_rate"])
                    if wait:
                        retry = max(1, math.ceil(wait))
                        return await _send_json(send, 429, _error(
                            429, "identity_rate_limited",
                            "Too many translation requests from this browser; retry shortly.",
                            stage="ingress_quota", category="admission", retryable=True,
                            extra={"retryAfterSeconds": retry}), {"Retry-After": str(retry)})
                if scope.get("path") in LENS_ROUTES:
                    from backend.lens import cookie as lens_cookie
                    lens_cookie.prefetch()
            return await self.app(scope, receive, send)
        finally:
            _identity.reset(token)
