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

TTL = 24 * 60 * 60
MAX_RUNS = 512
MAX_CALLER_RUNS = 64
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

    def _prune(self):
        now = self.now()
        for run_id in [key for key, row in self._runs.items() if row["expires"] < now]:
            self._drop(run_id)

    def _owned(self, run_id, hashed):
        state.identifier(run_id)
        row = self._runs.get(run_id)
        if row and row["expires"] < self.now():
            self._drop(run_id)
            row = None
        if not row or not hmac.compare_digest(row["secret"], hashed):
            raise state.PoolError("repair_run_not_found", 404)
        return row

    def register(self, run_id: str, token: str, manifest: list, caller: str) -> dict:
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
            if len(self._runs) >= MAX_RUNS or self._bytes + size > MAX_BYTES or sum(
                    row["caller"] == caller for row in self._runs.values()) >= MAX_CALLER_RUNS:
                raise state.PoolError("repair_store_capacity", 503)
            self._runs[run_id] = dict(secret=hashed, caller=caller, expires=self.now() + TTL,
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
            if self._bytes - row["size"] + size > MAX_BYTES:
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
                    and row["expires"] >= now and row["phase"] in ("collecting", "repairing")}

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
