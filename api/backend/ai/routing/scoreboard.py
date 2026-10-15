"""In-memory routing scoreboard (contract §3, §7 merge) and local cooldowns.

Local hourly buckets hold only observations the Center has NOT acknowledged
(standalone APIs never drain them). A push moves them to `inflight`; a
successful push drops them, a failed one puts them back. Routing reads
Center window counts + local delta + inflight, so nothing is counted twice.
Bounded: 30-day retention, at most 4096 keys (least recently seen go first)
and a hard bucket ceiling.
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict, deque
from copy import deepcopy
from typing import Any, Callable

from .score import TRANSPORT_FAILURES, VALIDATION_FAILURES, add_aggregate, empty_aggregate, latency_bucket

RETENTION_HOURS = 30 * 24
MAX_KEYS = 4096
MAX_BUCKETS = 100_000
MAX_CENTER_KEYS = 8192
PUSH_ROWS = 800              # the Center accepts ≤ 2000 buckets and ≤ 512 KB per push
PUSH_BYTES = 400 * 1024
FAILURES = (*VALIDATION_FAILURES, *TRANSPORT_FAILURES)

Key = tuple[str, str, str]


class Scoreboard:
    def __init__(self, *, clock: Callable[[], float] = time.time, max_keys: int = MAX_KEYS,
                 max_buckets: int = MAX_BUCKETS) -> None:
        self.clock = clock
        self.max_keys, self.max_buckets = max_keys, max_buckets
        self._lock = threading.RLock()
        self._local: OrderedDict[Key, dict[str, Any]] = OrderedDict()
        self._inflight: list[dict[str, Any]] = []
        self._inflight_id = ""
        self._center: dict[Key, dict[str, Any]] = {}
        self.center_version: str = ""
        self._cool: dict[Key, dict[str, Any]] = {}
        self.pending_n = 0
        self.pending_failure = False

    # -- observations -------------------------------------------------
    def hour(self) -> int:
        return int(self.clock() // 3600)

    def add(self, family: str, model: str, host: str, quant: str, outcome: str, *,
            latency_ms: float | None = None, in_tok: int | None = None, cached_tok: int | None = None,
            out_tok: int | None = None, cost_usd: float | None = None,
            cooldown: tuple[int, int, int] = (3, 10, 30)) -> None:
        key = (family, model, host)
        now = self.clock()
        hour = int(now // 3600)
        with self._lock:
            entry = self._local.pop(key, None) or {"quant": quant or "unknown", "buckets": {}}
            entry["quant"] = quant or entry.get("quant") or "unknown"
            entry["seen"] = now
            self._local[key] = entry
            bucket = entry["buckets"].setdefault(hour, empty_aggregate())
            bucket["n"] += 1
            bucket[outcome] = bucket.get(outcome, 0) + 1
            if isinstance(latency_ms, (int, float)) and not isinstance(latency_ms, bool) and latency_ms >= 0:
                bucket["lat_sum"] += int(round(latency_ms))  # Center accepts integers only
                bucket["lat_n"] += 1
                bucket["lat_hist"][latency_bucket(latency_ms)] += 1
            # cached_tok never exceeds in_tok (the Center rejects such a bucket).
            if not (isinstance(in_tok, int) and not isinstance(in_tok, bool) and in_tok >= 0):
                cached_tok = None
            elif isinstance(cached_tok, int) and not isinstance(cached_tok, bool):
                cached_tok = min(max(0, cached_tok), in_tok)
            for name, value in (("in_tok", in_tok), ("cached_tok", cached_tok), ("out_tok", out_tok)):
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    bucket[name] += value
            if isinstance(cost_usd, (int, float)) and not isinstance(cost_usd, bool) and cost_usd >= 0:
                bucket["cost_usd"] += float(cost_usd)
                bucket["cost_n"] += 1
            self.pending_n += 1
            if outcome in FAILURES:
                self.pending_failure = True
                self._note_failure(key, now, cooldown)
            self._trim(hour)

    def _note_failure(self, key: Key, now: float, cooldown: tuple[int, int, int]) -> None:
        failures, window_min, cool_min = cooldown
        state = self._cool.setdefault(key, {"fails": deque(maxlen=64), "until": 0.0})
        fails = state["fails"]
        fails.append(now)
        # Same rule as the Center: any `failures` failures within the window
        # (inclusive) cool the host until the latest of them + cool_min.
        while fails and fails[0] < now - window_min * 60:
            fails.popleft()
        if len(fails) >= failures:
            state["until"] = max(state["until"], now + cool_min * 60)
        if len(self._cool) > self.max_keys:
            for stale in [k for k, v in self._cool.items() if v["until"] <= now and not v["fails"]][:256]:
                self._cool.pop(stale, None)

    def _trim(self, hour: int) -> None:
        oldest = hour - RETENTION_HOURS
        total = 0
        for entry in self._local.values():
            for stale in [h for h in entry["buckets"] if h <= oldest]:
                entry["buckets"].pop(stale, None)
            total += len(entry["buckets"])
        for key in [k for k, e in self._local.items() if not e["buckets"]]:
            self._local.pop(key, None)
        while len(self._local) > self.max_keys or (total > self.max_buckets and self._local):
            _, evicted = self._local.popitem(last=False)
            total -= len(evicted["buckets"])

    def cooled(self, family: str, model: str) -> set[str]:
        now = self.clock()
        with self._lock:
            return {k[2] for k, v in self._cool.items() if k[0] == family and k[1] == model and v["until"] > now}

    # -- reading -----------------------------------------------------------
    def window(self, family: str, model: str, window_days: int = 7) -> dict[str, dict[str, Any]]:
        """{host: {quant, agg}} = Center window counts + unacknowledged local counts."""
        first = self.hour() - window_days * 24 + 1
        result: dict[str, dict[str, Any]] = {}
        with self._lock:
            for (fam, mod, host), row in self._center.items():
                if fam == family and mod == model:
                    item = result.setdefault(host, {"quant": row.get("quant") or "unknown", "agg": empty_aggregate()})
                    add_aggregate(item["agg"], row.get("agg"))
            for (fam, mod, host), entry in self._local.items():
                if fam == family and mod == model:
                    recent = [bucket for h, bucket in entry["buckets"].items() if h >= first]
                    if not recent:
                        continue
                    item = result.setdefault(host, {"quant": entry["quant"], "agg": empty_aggregate()})
                    item["quant"] = entry["quant"]
                    for bucket in recent:
                        add_aggregate(item["agg"], bucket)
            for row in self._inflight:
                if row["family"] == family and row["model"] == model and row["hour"] >= first:
                    item = result.setdefault(row["host"], {"quant": row["quant"], "agg": empty_aggregate()})
                    add_aggregate(item["agg"], row)
        return result

    def local_keys(self) -> int:
        with self._lock:
            return len(self._local)

    # -- exchange with the Center ------------------------------------------
    def take_push(self, limit: int = PUSH_ROWS, max_bytes: int = PUSH_BYTES) -> list[dict[str, Any]]:
        """Move the local delta to `inflight` and return it as contract §7 buckets.

        A batch left in flight by an uncertain failure (the Center may have stored
        it) is returned again unchanged with the same push id, so the Center can
        drop the repeat. Batches stay under the Center's body limit; the rest
        waits for later pushes."""
        import json
        import secrets
        with self._lock:
            if self._inflight:
                return deepcopy(self._inflight)
            self._trim(self.hour())
            rows, size = [], 64
            for (family, model, host), entry in list(self._local.items()):
                for hour, bucket in sorted(entry["buckets"].items()):
                    row = {"family": family, "model": model, "host": host,
                           "quant": entry["quant"], "hour": hour, **deepcopy(bucket)}
                    row_size = len(json.dumps(row, separators=(",", ":"))) + 1
                    if len(rows) >= limit or (rows and size + row_size > max_bytes):
                        break
                    rows.append(row)
                    size += row_size
            taken = {(r["family"], r["model"], r["host"], r["hour"]) for r in rows}
            for key, entry in list(self._local.items()):
                for hour in [h for h in entry["buckets"] if (*key, h) in taken]:
                    entry["buckets"].pop(hour, None)
                if not entry["buckets"]:
                    self._local.pop(key, None)
            self._inflight = rows
            self._inflight_id = secrets.token_hex(8) if rows else ""
            self.pending_n = sum(sum(b["n"] for b in e["buckets"].values()) for e in self._local.values())
            self.pending_failure = any(any(b.get(f) for f in FAILURES) for e in self._local.values()
                                       for b in e["buckets"].values())
            return deepcopy(rows)

    @property
    def push_id(self) -> str:
        return self._inflight_id

    def ack_push(self) -> None:
        with self._lock:
            self._inflight, self._inflight_id = [], ""

    def fail_push(self, uncertain: bool = False) -> None:
        """A failed push. `uncertain` (sent, no answer): keep the batch and its id
        for the next push; otherwise put the rows back into the local delta."""
        if uncertain:
            return
        with self._lock:
            rows, self._inflight, self._inflight_id = self._inflight, [], ""
            for row in rows:
                key = (row["family"], row["model"], row["host"])
                entry = self._local.setdefault(key, {"quant": row["quant"], "buckets": {}, "seen": self.clock()})
                bucket = entry["buckets"].setdefault(row["hour"], empty_aggregate())
                add_aggregate(bucket, row)
                self.pending_n += int(row.get("n") or 0)
                if any(row.get(f) for f in FAILURES):
                    self.pending_failure = True
            self._trim(self.hour())

    def set_center(self, version: str, keys: list[Any]) -> None:
        table: dict[Key, dict[str, Any]] = {}
        from .settings import host_label
        for row in keys if isinstance(keys, list) else []:
            if not isinstance(row, dict) or len(table) >= MAX_CENTER_KEYS:
                continue
            family, model, host = row.get("family"), row.get("model"), host_label(row.get("host"))
            if family not in ("openrouter", "huggingface") or not isinstance(model, str) or not model or not host:
                continue
            agg = row.get("agg") if isinstance(row.get("agg"), dict) else row
            table[(family, model[:160], host)] = {"quant": str(row.get("quant") or "unknown")[:16],
                                                   "agg": add_aggregate(empty_aggregate(), agg)}
        with self._lock:
            self._center = table
            self.center_version = str(version or "")[:80]

    def reset(self) -> None:
        with self._lock:
            self._local.clear(); self._inflight = []; self._inflight_id = ""; self._center = {}; self._cool.clear()
            self.center_version = ""; self.pending_n = 0; self.pending_failure = False


class StickyMap:
    """Conversation scope -> host that served it; 60 min sliding, bounded."""

    def __init__(self, *, clock: Callable[[], float] = time.time, ttl_s: float = 3600.0, limit: int = 4096) -> None:
        self.clock, self.ttl_s, self.limit = clock, ttl_s, limit
        self._lock = threading.Lock()
        self._map: OrderedDict[tuple[str, str, str], tuple[str, float]] = OrderedDict()

    def get(self, family: str, model: str, scope: str) -> str | None:
        if not scope:
            return None
        with self._lock:
            item = self._map.get((family, model, scope))
            if item is None or item[1] + self.ttl_s <= self.clock():
                self._map.pop((family, model, scope), None)
                return None
            return item[0]

    def set(self, family: str, model: str, scope: str, host: str) -> None:
        if not scope or not host:
            return
        with self._lock:
            key = (family, model, scope)
            self._map.pop(key, None)
            self._map[key] = (host, self.clock())
            while len(self._map) > self.limit:
                self._map.popitem(last=False)

    def drop(self, family: str, model: str, scope: str, host: str) -> None:
        with self._lock:
            item = self._map.get((family, model, scope))
            if item and item[0] == host:
                self._map.pop((family, model, scope), None)

    def clear(self) -> None:
        with self._lock:
            self._map.clear()


__all__ = ["Scoreboard", "StickyMap", "RETENTION_HOURS", "MAX_KEYS"]
