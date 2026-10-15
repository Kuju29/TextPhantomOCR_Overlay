"""Provider attempts -> observations, finalised with TextPhantom validation.

An attempt that failed at transport level (http_error/timeout/transport) is
final at once. An attempt that delivered an answer stays pending as
`unvalidated` until a validator reports its outcome:
- the API decoder/response mapping (format, empty, missing_ids) and the
  server-side job validator (also wrong_language) call finalize();
- the extension validates the script of extension-owned answers and returns
  the outcome with an opaque token issued in the result (feedback()).
Pending attempts that nobody finalises within PENDING_TTL_S become
`unvalidated` (lazy sweep, no timer). Paid attempts are never counted here
(the Center records them); their validated outcomes are queued as
`routing_feedback` for the next Paid request instead.
"""
from __future__ import annotations

import hashlib
import secrets
import threading
import time
from collections import OrderedDict, deque
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Callable, Iterator

from .score import OUTCOMES, TRANSPORT_FAILURES, VALIDATION_FAILURES
from .settings import host_label

PENDING_TTL_S = 15 * 60
AVOID_TTL_S = 30 * 60
MAX_PENDING = 4096
MAX_TOKENS = 4096
MAX_AVOID = 4096
MAX_PAID_FEEDBACK = 256
PAID_FEEDBACK_PER_REQUEST = 32
_collector: ContextVar[list | None] = ContextVar("tp_routing_attempts", default=None)


@contextmanager
def collect() -> Iterator[list[str]]:
    """Collect ids of attempts recorded by provider adapters in this generation."""
    attempts: list[str] = []
    token = _collector.set(attempts)
    try:
        yield attempts
    finally:
        _collector.reset(token)


def avoid_key(api_key: str, cache_context: Any) -> str:
    context = cache_context if hasattr(cache_context, "get") else {}
    scope = str(context.get("routingBatch") or context.get("operationId") or "")
    if not scope:
        return ""
    return hashlib.sha256((str(api_key or "") + "\0" + scope).encode()).hexdigest()[:32]


def credential_scope(api_key: str, scope: str) -> str:
    return hashlib.sha256((str(api_key or "") + "\0" + str(scope or "")).encode()).hexdigest()[:32] if scope else ""


class Observations:
    def __init__(self, board, sticky, *, settings: Callable[[], dict] | None = None,
                 after_record: Callable[[], None] | None = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        from . import settings as settings_module
        self.board, self.sticky = board, sticky
        self.settings = settings or settings_module.current
        self.after_record = after_record or (lambda: None)
        self.clock = clock
        self._lock = threading.RLock()
        self._pending: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._tokens: OrderedDict[str, tuple[list[str], float]] = OrderedDict()
        self._avoid: OrderedDict[tuple[str, str, str], list[tuple[str, float]]] = OrderedDict()
        self._paid_feedback: deque[dict[str, str]] = deque(maxlen=MAX_PAID_FEEDBACK)

    # -- recording ----------------------------------------------------------------
    def record(self, family: str, model: str, host: str, quant: str, outcome: str, *,
               latency_ms: float | None = None, in_tok: int | None = None, cached_tok: int | None = None,
               out_tok: int | None = None, cost_usd: float | None = None, scope: str = "",
               avoid: str = "", paid_operation: str = "", owner: str = "", units: int = 0) -> str | None:
        """Record one attempt. Returns an attempt id when validation is still pending."""
        if outcome not in OUTCOMES:
            return None
        if family == "paid":
            label = str(host or "").strip()[:80]
            if outcome in TRANSPORT_FAILURES or not paid_operation:
                return None
            row = {"family": "paid", "model": str(model)[:160], "host": label, "paid_operation": paid_operation,
                   "owner": owner, "avoid": avoid, "scope": scope, "units": units, "at": self.clock()}
        else:
            label = host_label(host)
            if not label or not model:
                return None
            row = {"family": family, "model": str(model)[:160], "host": label, "quant": quant or "unknown",
                   "latency_ms": latency_ms, "in_tok": in_tok, "cached_tok": cached_tok, "out_tok": out_tok,
                   "cost_usd": cost_usd, "scope": scope, "avoid": avoid, "units": units, "at": self.clock()}
            if outcome != "unvalidated":
                self._commit(row, outcome)
                return None
        attempt = secrets.token_hex(12)
        with self._lock:
            self._sweep()
            self._pending[attempt] = row
            while len(self._pending) > MAX_PENDING:
                _, oldest = self._pending.popitem(last=False)
                self._commit(oldest, "unvalidated")
        current = _collector.get()
        if current is not None:
            current.append(attempt)
        return attempt

    def _commit(self, row: dict[str, Any], outcome: str) -> None:
        failed = outcome in VALIDATION_FAILURES or outcome in TRANSPORT_FAILURES
        if outcome in VALIDATION_FAILURES and row.get("avoid"):
            self._remember_avoid(row["family"], row["model"], row["avoid"], row["host"],
                                 units=int(row.get("units") or 0), outcome=outcome)
        if failed and row.get("scope"):
            self.sticky.drop(row["family"], row["model"], row["scope"], row["host"])
        if row["family"] == "paid":
            if outcome == "ok" or outcome in VALIDATION_FAILURES:
                with self._lock:
                    # Kept per Paid credential: the Center applies feedback only to
                    # operations of the customer sending it, so it rides only on that
                    # customer's next Paid request (never another customer's).
                    self._paid_feedback.append({"owner": row.get("owner") or "",
                                                "operation_id": row["paid_operation"], "outcome": outcome})
            return
        settings = self.settings()
        self.board.add(row["family"], row["model"], row["host"], row.get("quant") or "unknown", outcome,
                       latency_ms=row.get("latency_ms"), in_tok=row.get("in_tok"),
                       cached_tok=row.get("cached_tok"), out_tok=row.get("out_tok"),
                       cost_usd=row.get("cost_usd"),
                       cooldown=(settings["cooldown_failures"], settings["cooldown_window_min"],
                                 settings["cooldown_min"]))
        try:
            self.after_record()
        except Exception:  # noqa: BLE001 - sync is best effort
            pass

    def finalize(self, attempts: list[str] | tuple[str, ...] | None, outcome: str) -> int:
        """Finalise pending attempts with a validation outcome. Returns how many."""
        if outcome not in OUTCOMES:
            return 0
        done = 0
        for attempt in list(attempts or []):
            with self._lock:
                row = self._pending.pop(str(attempt), None)
            if row is not None:
                self._commit(row, outcome)
                done += 1
        return done

    def issue_token(self, attempts: list[str]) -> str:
        with self._lock:
            live = [a for a in attempts if a in self._pending]
            if not live:
                return ""
            token = secrets.token_hex(16)
            self._tokens[token] = (live, self.clock())
            while len(self._tokens) > MAX_TOKENS:
                self._tokens.popitem(last=False)
            return token

    def feedback(self, items: Any) -> int:
        """Extension-reported outcomes: [{token, outcome}] (unknown tokens are ignored)."""
        done = 0
        for item in (items if isinstance(items, list) else [])[:PAID_FEEDBACK_PER_REQUEST]:
            if not isinstance(item, dict):
                continue
            token, outcome = str(item.get("token") or "")[:64], item.get("outcome")
            if outcome not in ("ok", *VALIDATION_FAILURES):
                continue
            with self._lock:
                entry = self._tokens.pop(token, None)
            if entry is not None:
                done += self.finalize(entry[0], outcome)
        return done

    def _sweep(self) -> None:
        now = self.clock()
        expired = []
        with self._lock:
            while self._pending:
                _attempt, row = next(iter(self._pending.items()))
                if row["at"] + PENDING_TTL_S > now:
                    break
                self._pending.popitem(last=False)
                expired.append(row)
            while self._tokens and next(iter(self._tokens.values()))[1] + PENDING_TTL_S <= now:
                self._tokens.popitem(last=False)
        for row in expired:
            self._commit(row, "unvalidated")

    def sweep(self) -> None:
        self._sweep()

    # -- repair avoidance ----------------------------------------------------------
    def _remember_avoid(self, family: str, model: str, key: str, host: str, *,
                        units: int = 0, outcome: str = "") -> None:
        now = self.clock()
        with self._lock:
            entry_key = (family, model, key)
            hosts = [row for row in self._avoid.pop(entry_key, []) if row[1] + AVOID_TTL_S > now and row[0] != host]
            self._avoid[entry_key] = (hosts + [(host, now, max(0, units), outcome)])[-4:]
            while len(self._avoid) > MAX_AVOID:
                self._avoid.popitem(last=False)

    def avoid_hosts(self, family: str, model: str, key: str, repair_units: int | None = None) -> list[str]:
        """Hosts a repair should skip. A repair of a few lines (a name or a sound
        effect the check flagged) stays on the same host: switching would lose the
        Conversation's prompt cache for a small fix. The host is skipped when its
        whole answer was unusable (empty / broken format) or the repair covers at
        least half of that answer's lines (e.g. a page answered in another language)."""
        if not key:
            return []
        now = self.clock()
        with self._lock:
            rows = [row for row in self._avoid.get((family, model, key), []) if row[1] + AVOID_TTL_S > now]
        return [row[0] for row in rows
                if row[3] in {"empty", "format"} or not row[2] or repair_units is None
                or repair_units * 2 >= row[2]]

    # -- Paid feedback --------------------------------------------------------------
    def take_paid_feedback(self, owner: str = "", limit: int = PAID_FEEDBACK_PER_REQUEST) -> list[dict[str, str]]:
        """Up to `limit` outcomes of this credential's earlier Paid operations (owner removed)."""
        with self._lock:
            mine = [item for item in self._paid_feedback if item.get("owner", "") == owner][:limit]
            if not mine:
                return []
            taken = {id(item) for item in mine}
            kept = [item for item in self._paid_feedback if id(item) not in taken]
            self._paid_feedback.clear()
            self._paid_feedback.extend(kept)
            return [{"operation_id": item["operation_id"], "outcome": item["outcome"]} for item in mine]

    def return_paid_feedback(self, items: list[dict[str, str]], owner: str = "") -> None:
        with self._lock:
            for item in reversed(items):
                if len(self._paid_feedback) < MAX_PAID_FEEDBACK:
                    self._paid_feedback.appendleft({"owner": owner, **item})

    def pending_count(self) -> int:
        with self._lock:
            return len(self._pending)

    def reset(self) -> None:
        with self._lock:
            self._pending.clear(); self._tokens.clear(); self._avoid.clear(); self._paid_feedback.clear()


__all__ = ["Observations", "collect", "avoid_key", "credential_scope", "PENDING_TTL_S"]
