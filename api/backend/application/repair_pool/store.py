"""Bounded SQLite repair ledger; transactions are offloaded by HTTP routes.

WAL + BEGIN IMMEDIATE makes claiming a unit atomic across API workers. A task
which may already have called a provider is NEVER put back in the pending pool.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable
from . import state

DEFAULT_PATH = Path(__file__).resolve().parents[3] / "data" / "repair-pool.sqlite3"
TTL = 24 * 60 * 60

class RepairStore:
    def __init__(self, path: str | Path | None = None, now: Callable = time.time):
        self.path = Path(path or os.environ.get("TP_REPAIR_STATE_FILE") or DEFAULT_PATH)
        self.now = now

    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(str(self.path), timeout=5)
        try:
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("PRAGMA secure_delete=ON")
            con.execute("CREATE TABLE IF NOT EXISTS repair_runs (id TEXT PRIMARY KEY, secret TEXT NOT NULL, "
                        "caller TEXT NOT NULL, expires REAL NOT NULL, data TEXT NOT NULL)")
            with con:
                yield con
        finally:
            con.close()

    @staticmethod
    def secret(token: str) -> str:
        if not re.fullmatch(r"[a-f0-9]{64}", str(token)):
            raise state.PoolError("invalid_repair_session_token", 401)
        return hashlib.sha256(token.encode()).hexdigest()

    def register(self, run_id: str, token: str, manifest: list, caller: str) -> dict:
        hashed = self.secret(token)
        run = state.new_run(run_id, manifest, self.now())
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            con.execute("DELETE FROM repair_runs WHERE expires < ?", (self.now(),))
            old = con.execute("SELECT secret, data FROM repair_runs WHERE id=?", (run_id,)).fetchone()
            if old:
                if not hmac.compare_digest(old[0], hashed):
                    raise state.PoolError("repair_run_not_found", 404)
                previous = json.loads(old[1])
                if previous["manifest"] != run["manifest"]:
                    raise state.PoolError("repair_manifest_conflict")
                return state.view(previous)
            count, size = con.execute("SELECT COUNT(*), COALESCE(SUM(length(data)),0) FROM repair_runs").fetchone()
            caller_count = con.execute("SELECT COUNT(*) FROM repair_runs WHERE caller=?", (caller,)).fetchone()[0]
            if count >= 512 or size >= 128 * 1024 * 1024 or caller_count >= 64:
                raise state.PoolError("repair_store_capacity", 503)
            con.execute("INSERT INTO repair_runs VALUES (?,?,?,?,?)", (run_id, hashed, caller,
                        self.now() + TTL, json.dumps(run, ensure_ascii=False)))
        return state.view(run)

    def transact(self, run_id: str, token: str, action: Callable) -> dict:
        hashed = self.secret(token)
        state.identifier(run_id)
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            row = con.execute("SELECT secret, expires, data FROM repair_runs WHERE id=?", (run_id,)).fetchone()
            if not row or row[1] < self.now() or not hmac.compare_digest(row[0], hashed):
                raise state.PoolError("repair_run_not_found", 404)
            run = json.loads(row[2])
            result = action(run)
            run["updatedAt"] = self.now()
            data = json.dumps(run, ensure_ascii=False, separators=(",", ":"))
            if len(data.encode()) > state.MAX_RUN_BYTES:
                raise state.PoolError("repair_run_size_limit", 413)
            total = con.execute("SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) FROM repair_runs").fetchone()[0]
            if total - len(row[2].encode()) + len(data.encode()) > 128 * 1024 * 1024:
                raise state.PoolError("repair_store_capacity", 503)
            con.execute("UPDATE repair_runs SET data=? WHERE id=?", (data, run_id))
            return result

    def read(self, run_id: str, token: str) -> dict:
        # Uses the same ownership/expiry checks, and gives a coherent snapshot.
        return self.transact(run_id, token, state.view)

    def delete(self, run_id: str, token: str) -> dict:
        self.read(run_id, token)
        with self.connect() as con:
            con.execute("DELETE FROM repair_runs WHERE id=? AND secret=?", (run_id, self.secret(token)))
        return {"deleted": True}

store = RepairStore()
