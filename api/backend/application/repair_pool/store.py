"""Bounded, private repair state for one API process; restart begins empty.

Atomic transitions retain in-session duplicate protection without disk journals.
The lock covers state transitions only, never provider generation.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import threading
import time
from pathlib import Path
from typing import Callable
from . import state

# Capacity is shared by every user, so finished or abandoned runs must not
# hold it for long.
# - TTL: hard lifetime of any run. 6 h matches the extension checkpoint TTL
#   (translation-session-store ttlMs): after that no extension can resume it.
# - TERMINAL_IDLE: done/cancelled runs only serve late duplicate requests; they
#   expire after 1 h without use.
# - IDLE_EVICT: under capacity pressure, a collecting/repairing run untouched
#   for this long is treated as abandoned (its extension stopped: blocked,
#   unavailable or closed) and may give its slot, oldest first. A run used within
#   IDLE_EVICT is active and is never evicted; the caller then gets 503.
TTL = 6 * 60 * 60
TERMINAL_IDLE = 60 * 60
IDLE_EVICT = 60 * 60
TERMINAL_PHASES = ("done", "cancelled")
MAX_RUNS = 512
MAX_CALLER_RUNS = 64
# One browser (X-TP-Install / trusted client IP) across all of its tab sessions:
# a quarter of the shared pool, so a single identity cannot occupy all of it.
MAX_IDENTITY_RUNS = 128
MAX_BYTES = 128 * 1024 * 1024

class RepairStore:
    def __init__(self, path: str | Path | None = None, now: Callable = time.time):
        # Kept for constructor compatibility; never read, create or remove it.
        self.path = Path(path) if path else None
        self.now = now
        self._lock = threading.RLock()
        self._runs = {}
        self._page_runs = {}  # bounded by existing run/manifest limits
        self._bytes = 0

    @staticmethod
    def secret(token: str) -> str:
        if not re.fullmatch(r"[a-f0-9]{64}", str(token)):
            raise state.PoolError("invalid_repair_session_token", 401)
        return hashlib.sha256(token.encode()).hexdigest()

    def _drop(self, run_id):
        row = self._runs.pop(run_id, None)
        if row:
            self._bytes -= row["size"]
            for page in row.get("manifest", ()):
                owners = self._page_runs.get(page)
                if owners is not None:
                    owners.discard(run_id)
                    if not owners:
                        self._page_runs.pop(page, None)

    @staticmethod
    def _expired(row, now):
        return row["expires"] < now or (
            row["phase"] in TERMINAL_PHASES and now - row.get("updated", 0) >= TERMINAL_IDLE)

    def _prune(self):
        now = self.now()
        for run_id in [key for key, row in self._runs.items() if self._expired(row, now)]:
            self._drop(run_id)

    def _victims(self, *, caller=None, keep=None):
        """Evictable runs, oldest first: terminal runs, then runs idle >= IDLE_EVICT."""
        now = self.now()
        rows = [(run_id, row) for run_id, row in self._runs.items()
                if run_id != keep and (caller is None or row["caller"] == caller)]
        terminal = sorted((row.get("updated", 0), run_id) for run_id, row in rows if row["phase"] in TERMINAL_PHASES)
        idle = sorted((row.get("updated", 0), run_id) for run_id, row in rows
                      if row["phase"] not in TERMINAL_PHASES and now - row.get("updated", 0) >= IDLE_EVICT)
        return [run_id for _, run_id in terminal + idle]

    def _make_room(self, *, runs=0, size=0, caller=None, keep=None, identity=None):
        """Evict oldest terminal/idle runs until the requested room exists; never active runs."""
        def held_by(key, value):
            return sum(row.get(key) == value for row in self._runs.values())

        def short():
            return (len(self._runs) + runs > MAX_RUNS or self._bytes + size > MAX_BYTES or (
                caller is not None and runs and held_by("caller", caller) + runs > MAX_CALLER_RUNS) or (
                identity and runs and held_by("identity", identity) + runs > MAX_IDENTITY_RUNS))
        if not short():
            return True
        # Caller/identity caps first from their own runs, then global caps from anyone's.
        if caller is not None and runs and held_by("caller", caller) + runs > MAX_CALLER_RUNS:
            for run_id in self._victims(caller=caller, keep=keep):
                self._drop(run_id)
                if held_by("caller", caller) + runs <= MAX_CALLER_RUNS:
                    break
        if identity and runs and held_by("identity", identity) + runs > MAX_IDENTITY_RUNS:
            for run_id in self._victims(keep=keep):
                if self._runs.get(run_id, {}).get("identity") != identity:
                    continue
                self._drop(run_id)
                if held_by("identity", identity) + runs <= MAX_IDENTITY_RUNS:
                    break
        for run_id in self._victims(keep=keep):
            if not short():
                break
            self._drop(run_id)
        return not short()

    def _owned(self, run_id, hashed):
        state.identifier(run_id)
        row = self._runs.get(run_id)
        if row and self._expired(row, self.now()):
            self._drop(run_id)
            row = None
        if not row or not hmac.compare_digest(row["secret"], hashed):
            raise state.PoolError("repair_run_not_found", 404)
        row["updated"] = self.now()
        return row

    def register(self, run_id: str, token: str, manifest: list, caller: str,
                 identity: str | None = None) -> dict:
        hashed = self.secret(token)
        run = state.new_run(run_id, manifest, self.now())
        with self._lock:
            self._prune()
            old = self._runs.get(run_id)
            if old:
                if not hmac.compare_digest(old["secret"], hashed):
                    raise state.PoolError("repair_run_not_found", 404)
                previous = json.loads(old["data"])
                if previous["manifest"] != run["manifest"]:
                    raise state.PoolError("repair_manifest_conflict")
                return state.view(previous)
            data = json.dumps(run, ensure_ascii=False, separators=(",", ":"))
            size = len(data.encode())
            if not self._make_room(runs=1, size=size, caller=caller, identity=identity):
                if identity and sum(r.get("identity") == identity for r in self._runs.values()) >= MAX_IDENTITY_RUNS:
                    raise state.PoolError("repair_identity_capacity", 429)
                raise state.PoolError("repair_store_capacity", 503)
            self._runs[run_id] = dict(secret=hashed, caller=caller, identity=identity or None, expires=self.now() + TTL, updated=self.now(),
                                      data=data, size=size, phase=run["phase"], manifest=tuple(run["manifest"]))
            for page in run["manifest"]:
                self._page_runs.setdefault(page, set()).add(run_id)
            self._bytes += size
            return state.view(run)

    def transact(self, run_id: str, token: str, action: Callable) -> dict:
        hashed = self.secret(token)
        with self._lock:
            row = self._owned(run_id, hashed)
            # Decode a private working copy: exceptions cannot partially commit.
            run = json.loads(row["data"])
            result = action(run)
            run["updatedAt"] = self.now()
            data = json.dumps(run, ensure_ascii=False, separators=(",", ":"))
            size = len(data.encode())
            if size > state.MAX_RUN_BYTES:
                raise state.PoolError("repair_run_size_limit", 413)
            if self._bytes - row["size"] + size > MAX_BYTES and not self._make_room(
                    size=size - row["size"], keep=run_id):
                raise state.PoolError("repair_store_capacity", 503)
            self._bytes += size - row["size"]
            row.update(data=data, size=size, phase=run["phase"])
            return result

    def read(self, run_id: str, token: str) -> dict:
        hashed = self.secret(token)
        with self._lock:
            return state.view(json.loads(self._owned(run_id, hashed)["data"]))

    def active_for_pages(self, page_ids) -> set[str]:
        """Internal lifecycle lookup only; never exposes source, key or run token."""
        with self._lock:
            candidates = {run_id for page in page_ids for run_id in self._page_runs.get(page, ())}
            return self.active_workflows(candidates)

    def active_workflows(self, run_ids) -> set[str]:
        with self._lock:
            now = self.now()
            return {run_id for run_id in run_ids
                    if (row := self._runs.get(run_id)) is not None
                    and not self._expired(row, now) and row["phase"] in ("collecting", "repairing")}

    def is_cancelled(self, run_id: str, token: str) -> bool:
        hashed = self.secret(token)
        with self._lock:
            try:
                row = self._owned(run_id, hashed)
            except state.PoolError as exc:
                if str(exc) == "repair_run_not_found":
                    return True
                raise
            return json.loads(row["data"]).get("phase") == "cancelled"

    def delete(self, run_id: str, token: str) -> dict:
        hashed = self.secret(token)
        with self._lock:
            self._owned(run_id, hashed)
            self._drop(run_id)
            return {"deleted": True}

store = RepairStore()
