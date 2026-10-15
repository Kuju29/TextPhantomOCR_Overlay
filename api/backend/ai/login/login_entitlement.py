import hashlib
import threading
import time

import httpx
from backend.paid_center import require_center
from backend.ai.center_http import center_client
from .login_provider_registry import LoginError
from . import login_observability as diagnostic

# Center answers are cached briefly so each Login page does not ask again; a
# rejected token is cached too, so repeating a bad token costs no round trip.
# Keyed by a hash of the token (the token itself is never stored).
ALLOW_SECONDS = 60.0
DENY_SECONDS = 30.0
MAX_ENTRIES = 2048
_lock = threading.Lock()
_cache: dict[str, tuple[float, str | None, tuple | None]] = {}


def _key(bearer: str) -> str:
    return hashlib.sha256(("tp-login-entitlement\0" + bearer).encode()).hexdigest()


def _remember(key, owner=None, denied=None, *, now=None):
    now = time.monotonic() if now is None else now
    with _lock:
        if len(_cache) >= MAX_ENTRIES and key not in _cache:
            for stale in [k for k, v in _cache.items() if v[0] <= now] or [min(_cache, key=lambda k: _cache[k][0])]:
                _cache.pop(stale, None)
        _cache[key] = (now + (ALLOW_SECONDS if owner else DENY_SECONDS), owner, denied)


def clear() -> None:
    with _lock:
        _cache.clear()


def authorize(bearer):
    diagnostic.stage("entitlement")
    if not isinstance(bearer, str) or not 40 <= len(bearer) <= 100:
        raise LoginError("login_account_required", "Sign in to TextPhantom to use AI Login.", 401)
    key = _key(bearer)
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] <= time.monotonic():
            _cache.pop(key, None)
            hit = None
    if hit:
        diagnostic.emit("entitlement_cached")
        if hit[1]:
            return hit[1]
        code, message, status = hit[2]
        raise LoginError(code, message, status)
    try:
        base = require_center()
        with center_client(httpx.Timeout(12, connect=3)) as client:
            response = client.get(base + "/api/customer/addons/ai_login/entitlement", headers={"Authorization": "Bearer " + bearer})
        diagnostic.emit("center_response", upstreamStatus=response.status_code)
        if response.status_code == 401:
            _remember(key, denied=("login_account_required", "Sign in to TextPhantom again.", 401))
            error = LoginError("login_account_required", "Sign in to TextPhantom again.", 401)
            error.upstream_status = response.status_code
            raise error
        if response.status_code != 200:
            error = LoginError("login_center_unavailable", "AI Login cannot verify your access right now.", 503)
            error.upstream_status = response.status_code
            raise error
        data = response.json()
        if not isinstance(data, dict) or data.get("ok") is not True or not isinstance(data.get("user_id"), str):
            raise ValueError()
        if data.get("active") is not True or not isinstance(data.get("entitlement"), dict) or data["entitlement"].get("status") != "active":
            _remember(key, denied=("login_addon_required", "Your AI Login access is inactive. Contact support.", 403))
            raise LoginError("login_addon_required", "Your AI Login access is inactive. Contact support.", 403)
        _remember(key, owner=data["user_id"])
        return data["user_id"]
    except (httpx.HTTPError, RuntimeError, ValueError) as exc:
        if isinstance(exc, LoginError):
            raise
        # Center unavailable is never cached: the next request asks again.
        error = LoginError("login_center_unavailable", "AI Login cannot verify your access right now.", 503)
        error.cause_class = type(exc).__name__
        if "response" in locals():
            error.upstream_status = response.status_code
        raise error from None
