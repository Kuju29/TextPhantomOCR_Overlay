"""Process-memory OAuth credentials. Restart deliberately requires sign-in."""
from copy import deepcopy
import hashlib
import secrets
import time
from threading import RLock
from backend.paid_center import center_base_url
from .login_provider_contract import LoginError

_lock = RLock()
_state = {"schema": 3, "sessions": {}, "credentials": {}}
MAX_ACTIVE = 1024
MAX_INACTIVE = 256
# A full store must not refuse new connections until a restart: at the limit,
# the least recently used session idle this long gives way (its owner sees
# "sign in again"); sessions unused for IDLE_EXPIRE end on their own.
IDLE_EVICT_SECONDS = 24 * 3600
IDLE_EXPIRE_SECONDS = 7 * 24 * 3600


def _touch(row, now=None):
    row["used_at"] = time.monotonic() if now is None else now


def _deactivate(key):
    row = _state["sessions"].get(key)
    if not row:
        return
    row["active"] = False
    credential = _state["credentials"].get(row["credential"])
    if credential and credential["owner"] == row["owner"]:
        del _state["credentials"][row["credential"]]


def _expire_idle(now):
    for key, row in list(_state["sessions"].items()):
        if row["active"] and now - row.get("used_at", now) >= IDLE_EXPIRE_SECONDS:
            _deactivate(key)

def active_session_ids():
    with _lock:
        return {key for key, row in _state["sessions"].items() if row["active"]}

def owner_scope(owner):
    return hashlib.sha256((center_base_url()+"\0"+owner).encode()).hexdigest()

def clear():
    with _lock:
        _state["sessions"].clear()
        _state["credentials"].clear()


def owned(owner, provider=None):
    scope = owner_scope(owner)
    with _lock:
        return [dict(row) for row in _state["sessions"].values() if row["owner"] == scope
                and (provider is None or row["provider"] == provider) and row["active"]]

def get(session_id, owner, *, allow_inactive=False):
    with _lock:
        row = _state["sessions"].get(session_id)
        now = time.monotonic()
        if row and row["active"] and now - row.get("used_at", now) >= IDLE_EXPIRE_SECONDS:
            _deactivate(session_id)
        if not row or row["owner"] != owner_scope(owner) or (not allow_inactive and not row["active"]):
            raise LoginError("login_session_expired", "The API session ended. Sign in to your AI account again.", 401)
        if row["active"]:
            _touch(row, now)
        return dict(row)

def bind_native(owner, provider, identity, tokens):
    credential = "lgc_"+hashlib.sha256((provider+"\0"+identity).encode()).hexdigest()
    scope = owner_scope(owner)
    with _lock:
        rows, credentials = _state["sessions"], _state["credentials"]
        if any(row["active"] and row["credential"] == credential and row["owner"] != scope for row in rows.values()):
            raise LoginError("login_account_in_use", "This AI connection is already linked to another TextPhantom account.", 409)
        now = time.monotonic()
        _expire_idle(now)
        replacing = any(row["active"] and row["owner"] == scope and row["provider"] == provider for row in rows.values())
        if not replacing and len(credentials) >= MAX_ACTIVE:
            idle = sorted((row.get("used_at", now), key) for key, row in rows.items()
                          if row["active"] and now - row.get("used_at", now) >= IDLE_EVICT_SECONDS)
            if not idle:
                raise LoginError("login_capacity_reached", "The API has reached its active Login session limit.", 503)
            _deactivate(idle[0][1])
        for row in rows.values():
            if row["owner"] == scope and row["provider"] == provider:
                row["active"] = False
        for key, row in list(credentials.items()):
            if row["owner"] == scope and row["provider"] == provider:
                del credentials[key]
        inactive = [key for key, row in rows.items() if not row["active"]]
        for key in inactive[:-MAX_INACTIVE]:
            del rows[key]
        session_id = "lgs_"+secrets.token_hex(24)
        session = {"id": session_id, "owner": scope, "provider": provider, "credential": credential,
                   "prefix": "native", "account_id": hashlib.sha256((provider+"\0"+identity).encode()).hexdigest()[:32], "active": True,
                   "used_at": now}
        rows[session_id] = session
        credentials[credential] = {"owner": scope, "provider": provider, "tokens": deepcopy(tokens), "revision": secrets.token_hex(16)}
        return dict(session)

def _credential(session):
    current = _state["sessions"].get(session["id"])
    row = _state["credentials"].get(session["credential"])
    if not current or not current["active"] or any(current.get(k) != session.get(k) for k in ("owner", "provider", "credential")) or not row or row["owner"] != session["owner"] or row["provider"] != session["provider"]:
        raise LoginError("login_session_expired", "Sign in to your AI account again.", 401)
    return row

def credential_for_session(session):
    with _lock:
        row = _credential(session)
        current = _state["sessions"].get(session["id"])
        if current:
            _touch(current)
        return deepcopy(row)

def update_native(session, revision, tokens):
    with _lock:
        row = _credential(session)
        if row["revision"] != revision:
            raise LoginError("login_session_expired", "Sign in to your AI account again.", 401)
        row.update(tokens=deepcopy(tokens), revision=secrets.token_hex(16))

def invalidate_native(session, *, revision=None):
    with _lock:
        current = _state["sessions"].get(session["id"])
        if not current or current["owner"] != session["owner"] or not current["active"]:
            return False
        credential = _state["credentials"].get(session["credential"])
        if revision is not None and (not credential or credential["revision"] != revision):
            return False
        current["active"] = False
        if credential and credential["owner"] == session["owner"]:
            del _state["credentials"][session["credential"]]
        return True

def ready():
    return True
