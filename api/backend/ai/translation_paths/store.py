"""Bounded private history for one API process; restart begins empty.

No filesystem state is read or written. A condition reserves each conversation
lane without holding a lock across provider work. This is not provider KV cache.
"""
from __future__ import annotations
from contextlib import contextmanager, asynccontextmanager, closing
from contextvars import ContextVar
from pathlib import Path
import asyncio
import hashlib
import hmac
import json
import os
import secrets
import copy
import threading
import time

from .mode import scope_material, POLICY

MAX_SESSIONS = 256
MAX_HISTORY_CHARS = 1_000_000
MAX_TOTAL_HISTORY_CHARS = 16_000_000
LEASE_SECONDS = 180
WAIT_SECONDS = 600
_current = ContextVar("tp_conversation_lease", default=None)
_stores = {}
_stores_lock = threading.Lock()


class ConversationError(RuntimeError):
    code = "ai_conversation_state_error"
    requestDispatched = False
    providerAttempts = generationAttempts = 0


class Store:
    """Bounded process-lifetime history. Paths are compatibility labels only."""
    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.secret = secrets.token_bytes(32)
        self.wakeup = threading.Condition(threading.RLock())
        self._rows = {}
        self._async_waiters = set()

    def key(self, material):
        return hmac.new(self.secret, material.encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def _evictable(row, now):
        if row["active"] and row["until"] > now:
            return False
        from backend.application.repair_pool.store import store as repair_store
        row["workflows"] = repair_store.active_workflows(row.get("workflows", ()))
        if row["workflows"]:
            return False
        # No lifecycle contract: do not silently discard retained history merely
        # because no request holds the lane. New admission fails clearly instead.
        return row.get("managed", False) or not (row["revision"] or row["chars"] or row.get("blocked"))

    def try_acquire(self, key, page_ids=()):
        from backend.application.repair_pool.store import store as repair_store
        workflows = repair_store.active_for_pages(page_ids)
        now = time.monotonic()
        with self.wakeup:
            row = self._rows.get(key)
            if row and row.get("blocked"):
                error = ConversationError("Conversation history could not be retained within capacity; no provider request was sent")
                error.code = "ai_conversation_history_capacity"
                raise error
            if row and row["active"] and row["until"] > now:
                return None
            if row is None:
                if len(self._rows) >= MAX_SESSIONS:
                    idle = [(r["updated"], k) for k, r in self._rows.items()
                            if self._evictable(r, now)]
                    if not idle:
                        error = ConversationError("Conversation history capacity is busy; active workflows were preserved and no provider request was sent")
                        error.code = "ai_conversation_capacity"
                        raise error
                    del self._rows[min(idle)[1]]
                row = {"history": [], "prefix": "", "revision": 0,
                       "active": None, "until": 0, "updated": now, "chars": 0}
                self._rows[key] = row
            row["workflows"] = repair_store.active_workflows(row.get("workflows", ())) | workflows
            row["managed"] = row.get("managed", False) or bool(workflows)
            reason = "expired_lane_recovered" if row["active"] else "ready"
            token = secrets.token_hex(16)
            row.update(active=token, until=now + LEASE_SECONDS, updated=now)
            return Lease(self, key, token, copy.deepcopy(row["history"]),
                         row["prefix"], row["revision"], reason)

    def wait_available(self, key, timeout):
        # Check and wait under the acquisition lock: release cannot be missed.
        with self.wakeup:
            row = self._rows.get(key)
            remaining = row["until"] - time.monotonic() if row and row["active"] else 0
            if remaining > 0:
                self.wakeup.wait(min(timeout, remaining))

    async def async_wait_available(self, key, timeout):
        loop = asyncio.get_running_loop()
        ready = asyncio.Event()
        registration = (loop, ready)
        with self.wakeup:
            row = self._rows.get(key)
            remaining = row["until"] - time.monotonic() if row and row["active"] else 0
            if remaining <= 0:
                return
            self._async_waiters.add(registration)
        try:
            await asyncio.wait_for(ready.wait(), min(timeout, remaining))
        except asyncio.TimeoutError:
            pass
        finally:
            with self.wakeup:
                self._async_waiters.discard(registration)

    def renew(self, lease):
        with self.wakeup:
            row = self._rows.get(lease.key)
            if not row or row["active"] != lease.token or row["until"] <= time.monotonic():
                return False
            row["until"] = time.monotonic() + LEASE_SECONDS
            return True

    def release(self, lease, *, commit=False):
        encoded = json.dumps(lease.history, ensure_ascii=False, separators=(",", ":"))
        if len(encoded) > MAX_HISTORY_CHARS:
            commit = False
            lease.commit_status = "history_storage_limit"
        with self.wakeup:
            row = self._rows.get(lease.key)
            if not row or row["active"] != lease.token or row["until"] <= time.monotonic():
                lease.commit_status = "stale_lease_not_committed"
                return False
            if commit:
                excess = sum(r["chars"] for r in self._rows.values()) - row["chars"] + len(encoded) - MAX_TOTAL_HISTORY_CHARS
                if excess > 0:
                    now = time.monotonic()
                    idle = sorted((r["updated"], key, r["chars"])
                                  for key, r in self._rows.items()
                                  if key != lease.key and r["chars"] > 0
                                  and self._evictable(r, now))
                    # Check feasibility before discarding any cached history.
                    # Current and live scopes are never victims of admission.
                    if sum(chars for _, _, chars in idle) < excess:
                        commit = False
                        lease.commit_status = "history_storage_limit"
                    else:
                        for _, key, chars in idle:
                            del self._rows[key]
                            excess -= chars
                            if excess <= 0:
                                break
            if lease.commit_status == "history_storage_limit":
                # Keep the last committed bytes and fence continuation. Do not
                # hide a billed result or call the model again with stale history.
                row["blocked"] = "history_storage_limit"
            if commit:
                row.update(history=copy.deepcopy(lease.history), prefix=lease.prefix,
                           revision=row["revision"] + 1, chars=len(encoded))
                lease.commit_status = "branched_without_new_turn" if getattr(lease, "branch_only", False) else "committed"
            row.update(active=None, until=0, updated=time.monotonic())
            self.wakeup.notify_all()
            for loop, ready in tuple(self._async_waiters):
                try:
                    loop.call_soon_threadsafe(ready.set)
                except RuntimeError:
                    self._async_waiters.discard((loop, ready))
            return True


class Lease:
    def __init__(self, store=None, key="", token="", history=None, prefix="", revision=0, reason="scope_missing"):
        self.store, self.key, self.token = store, key, token
        self.history, self.prefix, self.revision = history or [], prefix, revision
        self.reason, self.wait_ms = reason, 0.0
        self.dirty = False
        self.commit_status = "not_applicable"
        self._stop = threading.Event()
        self._heartbeat = None
        self.lost = False
        self.evidence = None

    def start(self):
        if self.store:
            def renew():
                while not self._stop.wait(LEASE_SECONDS / 3):
                    try:
                        if not self.store.renew(self):
                            self.lost = True
                            return
                    except (RuntimeError, OSError):
                        self.lost = True
                        return
            self._heartbeat = threading.Thread(target=renew, name="tp-conversation-lease", daemon=True)
            self._heartbeat.start()
        return self

    def close(self, commit):
        self.succeeded = bool(commit)
        self._stop.set()
        if self._heartbeat:
            self._heartbeat.join(timeout=6)
        if not commit or self.lost:
            self.commit_status = "not_committed_cancelled_or_failed"
        if self.store:
            try:
                self.store.release(self, commit=commit and self.dirty and not self.lost)
            except (RuntimeError, OSError):
                # Do not hide a billed successful response or provoke a retry.
                self.commit_status = "not_committed_storage_error"
                try:
                    self.store.release(self, commit=False)
                except (RuntimeError, OSError):
                    pass  # fenced watchdog releases the lane on the next request
        elif self.dirty:
            self.commit_status = "ephemeral_not_retained"
        if self.evidence is not None:
            self.evidence["commitStatus"] = self.commit_status


def store():
    path = str(Path(os.getenv("TP_CONVERSATION_STATE_FILE") or Path(__file__).resolve().parents[3] / "data" / "ai-conversations.sqlite3").resolve())
    with _stores_lock:
        if path not in _stores:
            _stores[path] = Store(path)
        return _stores[path]


def cancelled(check):
    if callable(check) and check():
        from backend.ai.clients.base import ProviderGenerationCancelled
        raise ProviderGenerationCancelled("Conversation request cancelled before provider dispatch")


def _page_ids(ai):
    descriptor = ai.conversation or {}
    return tuple({str(row.get("pageId")) for row in descriptor.get("origins", ()) if row.get("pageId")}
                 | ({str(descriptor["pageId"])} if descriptor.get("pageId") else set()))


def _candidate(ai, target_lang):
    material = scope_material(ai, target_lang)
    if material is None:
        return None, None
    db = store()
    return db, db.key(material)


def current():
    return _current.get()


def scope_evidence(ai, key, phase, lease=None):
    from .conversation import emit
    evidence = {"schema":"tp.conversation/1", "mode":"conversation", "path":"conversation",
        "policy":POLICY, "phase":phase,
        "scope":key[:24] if key else "ephemeral",
        "scopeStatus":lease.reason if lease else "ready" if key else "scope_missing",
        "branch":(ai.conversation or {}).get("branch", "initial"),
        "orderPolicy":(ai.conversation or {}).get("orderPolicy", "request_arrival"),
        "commitStatus":"not_applicable", "queueWaitMs":lease.wait_ms if lease else 0,
        "storage":"api_memory" if key else "ephemeral", "legacyFallback":False,
        "providerCallsAdded":0}
    if lease is not None:
        lease.evidence = evidence
    emit(evidence)


def finalize_evidence(lease):
    if lease.evidence is not None:
        from .conversation import emit
        from backend.ai import wire_trace
        lease.evidence["phase"] = "finished" if getattr(lease, "succeeded", False) else "failed"
        emit(lease.evidence)
        if getattr(lease, "decoded", None):
            wire_trace.write_json("06_parsed_records.json", {
                "aiTextFull":lease.decoded.get("aiTextFull", ""), "meta":lease.decoded.get("meta", {})})


@contextmanager
def execution_scope(ai, target_lang, cancel_check=None):
    if getattr(ai, "translation_mode", "independent") != "conversation" or current() is not None:
        yield current()
        return
    started = time.monotonic()
    db, key = _candidate(ai, target_lang)
    scope_evidence(ai, key, "queued")
    lease = None
    while lease is None:
        cancelled(cancel_check)
        lease = db.try_acquire(key, _page_ids(ai)) if db else Lease()
        if lease is not None:
            break
        if time.monotonic()-started > WAIT_SECONDS:
            error = ConversationError("Timed out waiting for the preceding conversation turn; no provider request was sent")
            error.code = "ai_conversation_wait_timeout"
            raise error
        # Notification wakes immediately; the bound only checks cancellation.
        db.wait_available(key, 0.1 if callable(cancel_check) else LEASE_SECONDS)
    lease.wait_ms = max(0, (time.monotonic()-started)*1000)
    scope_evidence(ai, key, "acquired", lease)
    lease.start()
    marker = _current.set(lease)
    ok = False
    try:
        cancelled(cancel_check)
        yield lease
        cancelled(cancel_check)
        ok = True
    finally:
        _current.reset(marker)
        lease.close(ok)
        finalize_evidence(lease)


@asynccontextmanager
async def async_execution_scope(ai, target_lang, cancel_check=None):
    if getattr(ai, "translation_mode", "independent") != "conversation":
        yield None
        return
    started = time.monotonic()
    db, key = await asyncio.to_thread(_candidate, ai, target_lang)
    scope_evidence(ai, key, "queued")
    lease = None
    try:
        while lease is None:
            cancelled(cancel_check)
            # shield the short transaction so task cancellation cannot leave an
            # acquired lease behind between thread completion and assignment.
            task = asyncio.create_task(asyncio.to_thread(db.try_acquire, key, _page_ids(ai))) if db else None
            try:
                lease = await asyncio.shield(task) if task else Lease()
            except asyncio.CancelledError:
                if task:
                    acquired = await task
                    if acquired:
                        await asyncio.to_thread(acquired.close, False)
                raise
            if lease is not None:
                break
            if time.monotonic()-started > WAIT_SECONDS:
                error = ConversationError("Timed out waiting for the preceding conversation turn; no provider request was sent")
                error.code = "ai_conversation_wait_timeout"
                raise error
            await db.async_wait_available(key, 0.1 if callable(cancel_check) else LEASE_SECONDS)
        lease.wait_ms = max(0, (time.monotonic()-started)*1000)
        scope_evidence(ai, key, "acquired", lease)
        lease.start()
        marker = _current.set(lease)
        ok = False
        try:
            cancelled(cancel_check)
            yield lease
            cancelled(cancel_check)
            ok = True
        finally:
            _current.reset(marker)
            if not ok:
                lease.lost = True
            await asyncio.shield(asyncio.to_thread(lease.close, ok))
            finalize_evidence(lease)
    except BaseException:
        raise
