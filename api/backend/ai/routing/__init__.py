"""Provider routing by measured results (shared routing contract with the Center).

Process-wide state: one scoreboard, one stickiness map, one pending-attempt
table and one use-driven Center sync client. Routing never waits for the
Center: decisions use whatever is in memory now.
"""
from __future__ import annotations

from typing import Any, Callable

from . import settings
from .observations import Observations, avoid_key, collect, credential_scope
from .score import choose
from .scoreboard import Scoreboard, StickyMap
from .sync import SyncClient

BOARD = Scoreboard()
STICKY = StickyMap()
SYNC = SyncClient(BOARD, on_settings=settings.apply_center)
OBS = Observations(BOARD, STICKY, after_record=SYNC.after_record)


def decide(family: str, model: str, candidates: list[dict[str, Any]], *, scope: str = "",
           avoid: list[str] | tuple[str, ...] = (), rng: Callable[[], float] | None = None) -> dict[str, Any]:
    """Order the candidate hosts for one request (contract §5)."""
    SYNC.before_route()
    OBS.sweep()
    mode, rules, current = settings.for_model(family, model)
    window = BOARD.window(family, model, current["window_days"])
    enriched = []
    for candidate in candidates:
        seen = window.get(candidate["host"]) or {}
        quant = candidate.get("quant") or "unknown"
        if quant == "unknown" and seen.get("quant"):
            quant = seen["quant"]
        enriched.append({**candidate, "quant": quant, "agg": seen.get("agg")})
    decision = choose(enriched, mode=mode, model_rules=rules, no_fp4=current["no_fp4"],
                      explore=current["explore"], min_samples=current["min_samples"],
                      weights=current["weights"], cooled=BOARD.cooled(family, model),
                      sticky=STICKY.get(family, model, scope), avoid=avoid, rng=rng)
    return decision


def trace_summary(decision: dict[str, Any] | None, **extra: Any) -> dict[str, Any]:
    """Bounded (≤ 12 keys) trace object for a routing decision."""
    decision = decision or {}
    row = {"mode": decision.get("mode"), "host": decision.get("chosen"), "reason": decision.get("reason"),
           "candidates": decision.get("candidates", 0), "order": list(decision.get("order") or [])[:6],
           "ignore": list(decision.get("ignore") or [])[:4], "only": bool(decision.get("only"))}
    row.update({k: v for k, v in extra.items() if v is not None})
    return dict(list(row.items())[:12])


def record(*args, **kwargs):
    return OBS.record(*args, **kwargs)


def finalize(attempts, outcome: str) -> int:
    return OBS.finalize(attempts, outcome)


def issue_token(attempts: list[str]) -> str:
    return OBS.issue_token(attempts)


def feedback(items: Any) -> int:
    return OBS.feedback(items)


def avoid_hosts(family: str, model: str, key: str, repair_units: int | None = None) -> list[str]:
    return OBS.avoid_hosts(family, model, key, repair_units)


def remember_sticky(family: str, model: str, scope: str, host: str) -> None:
    STICKY.set(family, model, scope, settings.host_label(host) if family != "paid" else host)


def note_center_version(version: Any, settings_version: Any = None) -> None:
    SYNC.note_version(version, settings_version)


def reset() -> None:
    """Tests only: forget everything learned in this process."""
    BOARD.reset(); STICKY.clear(); OBS.reset(); settings.reset()


__all__ = ["BOARD", "STICKY", "SYNC", "OBS", "decide", "trace_summary", "record", "finalize", "issue_token",
           "feedback", "avoid_hosts", "avoid_key", "credential_scope", "collect", "remember_sticky",
           "note_center_version", "reset"]
