"""Use-driven exchange with the Center (contract §7). No timers, never blocking.

Every network call runs on a short-lived background thread started by a use
(an observation was recorded, a request is about to be routed, a Paid response
announced a newer version). Nothing pending and nothing to route ⇒ no request.
Without the shared gateway secret (or a Center URL) the API stays local-only.
"""
from __future__ import annotations

import secrets
import threading
import time
from typing import Any, Callable

PATH = "/api/gateway/routing-stats"
PEER = "0.0.0.0"  # No customer peer: the API itself is the actor.
PUSH_AT = 50
FAILURE_PUSH_EVERY_S = 120.0
IDLE_PUSH_EVERY_S = 3600.0
PULL_MAX_AGE_S = 3600.0
PULL_RETRY_S = 300.0
# A newer data version announced by a Paid response pulls only when the copy is at
# least this old (the version moves with every busy minute of Paid traffic);
# a newer settings version (admin change) pulls at once.
DATA_PULL_GAP_S = 900.0
PUSH_RETRY_S = 120.0
INSTANCE = secrets.token_hex(16)


def _default_secret() -> str:
    try:
        from backend.paid_center import gateway_key
        return gateway_key()
    except Exception:  # noqa: BLE001 - a misconfigured key means local-only stats
        return ""


def _default_base() -> str:
    try:
        from backend.paid_center import center_base_url
        return center_base_url()
    except Exception:  # noqa: BLE001
        return ""


def _default_client(timeout):
    from backend.ai.center_http import center_client
    return center_client(timeout)


def _spawn(fn: Callable[[], None]) -> None:
    threading.Thread(target=fn, name="tp-routing-sync", daemon=True).start()


def _newer(candidate: str, current: str) -> bool:
    if not candidate:
        return False
    try:
        return int(candidate) > int(current or -1)
    except ValueError:
        return candidate != current


class SyncClient:
    def __init__(self, board, *, secret: Callable[[], str] = _default_secret,
                 base: Callable[[], str] = _default_base, client=_default_client,
                 spawn: Callable[[Callable[[], None]], None] = _spawn,
                 clock: Callable[[], float] = time.monotonic, instance: str = INSTANCE,
                 on_settings: Callable[[Any], None] | None = None) -> None:
        self.board, self.secret, self.base, self.client = board, secret, base, client
        self.spawn, self.clock, self.instance = spawn, clock, instance
        self.on_settings = on_settings
        self._lock = threading.Lock()
        self._busy = False
        self.last_push = clock()
        self.last_failure_push = float("-inf")
        self.push_failed_at = float("-inf")
        self.pulled_at: float | None = None
        self.settings_version = ""
        self.pull_failed_at = float("-inf")
        self.requests = 0  # observable in tests

    def connected(self) -> bool:
        return bool(self.secret() and self.base())

    # -- triggers --------------------------------------------------------------
    def after_record(self) -> None:
        if not self.connected():
            return
        now = self.clock()
        with self._lock:
            retry = bool(self.board.push_id)  # a batch the Center may already hold
            if self._busy or (self.board.pending_n <= 0 and not retry) or now - self.push_failed_at < PUSH_RETRY_S:
                return
            due = (retry or self.board.pending_n >= PUSH_AT
                   or (self.board.pending_failure and now - self.last_failure_push >= FAILURE_PUSH_EVERY_S)
                   or now - self.last_push >= IDLE_PUSH_EVERY_S)
            if not due:
                return
            self._busy = True
        self.spawn(self._push)

    def before_route(self) -> None:
        if not self.connected():
            return
        now = self.clock()
        with self._lock:
            stale = self.pulled_at is None or now - self.pulled_at >= PULL_MAX_AGE_S
            if self._busy or not stale or now - self.pull_failed_at < PULL_RETRY_S:
                return
            self._busy = True
        self.spawn(self._pull)

    def note_version(self, version: Any, settings_version: Any = None) -> None:
        value = str(version or "").strip()[:80]
        settings_value = str(settings_version or "").strip()[:80]
        if not value or not _newer(value, self.board.center_version) or not self.connected():
            return
        now = self.clock()
        admin_change = bool(settings_value) and _newer(settings_value, self.settings_version)
        if not admin_change and self.pulled_at is not None and now - self.pulled_at < DATA_PULL_GAP_S:
            return
        with self._lock:
            if self._busy or now - self.pull_failed_at < PULL_RETRY_S:
                return
            self._busy = True
        self.spawn(self._pull)

    # -- network (background) ---------------------------------------------------
    def _headers(self, method: str, body: Any) -> dict[str, str]:
        from backend.gateway_proof import headers
        return {"Accept": "application/json", **headers(self.secret(), PEER, method, PATH, body)}

    def _push(self) -> None:
        failure_pending = self.board.pending_failure
        rows = self.board.take_push()
        ok = uncertain = False
        try:
            if not rows:
                ok = True
                return
            # push id: a repeat of a batch whose answer was lost is dropped by the Center.
            body = {"instance": self.instance, "push": self.board.push_id, "buckets": rows}
            import httpx
            self.requests += 1
            uncertain = True  # from here the Center may store the batch without us knowing
            with self.client(httpx.Timeout(8.0, connect=3.0)) as client:
                response = client.post(self.base() + PATH, json=body,
                                       headers={**self._headers("POST", body), "Content-Type": "application/json"})
            uncertain = False
            ok = 200 <= response.status_code < 300
            if ok:
                try:
                    data = response.json()
                except ValueError:
                    data = {}
                version = data.get("version") if isinstance(data, dict) else None
                if version is not None and _newer(str(version), self.board.center_version):
                    self.pulled_at = None  # next routing need pulls
        except Exception as exc:  # noqa: BLE001 - sync never breaks a translation; data stays local
            ok = False
            # Not connected at all: nothing was sent, the rows go back to the local delta.
            if uncertain and type(exc).__name__ in {"ConnectError", "ConnectTimeout"}:
                uncertain = False
        finally:
            now = self.clock()
            if ok:
                self.board.ack_push()
                self.last_push = now
                if failure_pending:
                    self.last_failure_push = now
            else:
                self.board.fail_push(uncertain=uncertain)
                self.push_failed_at = now
            with self._lock:
                self._busy = False

    def _pull(self) -> None:
        ok = False
        try:
            import httpx
            from urllib.parse import quote
            self.requests += 1
            with self.client(httpx.Timeout(8.0, connect=3.0)) as client:
                # First pull has no version: send no query (the Center expects an integer).
                query = "?version=" + quote(self.board.center_version) if self.board.center_version else ""
                response = client.get(self.base() + PATH + query, headers=self._headers("GET", None))
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, dict) and data.get("changed") is False:
                    ok = True
                elif isinstance(data, dict) and data.get("changed") is True:
                    if self.on_settings is not None and "settings" in data:
                        self.on_settings(data.get("settings"))
                    self.board.set_center(str(data.get("version") or ""), data.get("keys") or [])
                    self.settings_version = str(data.get("settings_version") or "")[:80]
                    ok = True
        except Exception:  # noqa: BLE001 - keep the previous copy and local data
            ok = False
        finally:
            now = self.clock()
            if ok:
                self.pulled_at = now
            else:
                self.pull_failed_at = now
            with self._lock:
                self._busy = False


__all__ = ["SyncClient", "INSTANCE", "PATH", "PUSH_AT"]
