"""Routing settings (contract §6): env defaults until the Center's copy is pulled."""
from __future__ import annotations

import os
import re
import threading
from copy import deepcopy
from typing import Any

from .score import DEFAULT_WEIGHTS

HOST = re.compile(r"^[a-z0-9][a-z0-9_.:/-]{0,79}$")
MODES = ("stats", "auto", "manual")
_lock = threading.Lock()
_center: dict[str, Any] | None = None


def host_label(value: Any) -> str:
    """Contract §1 host label (lower-cased) or '' when it does not qualify."""
    text = str(value or "").strip().lower()
    return text if HOST.fullmatch(text) else ""


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() not in {"0", "false", "off", "no"}


def _fraction(raw: Any, default: float) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return value if 0.0 <= value <= 1.0 else default


def env_defaults() -> dict[str, Any]:
    mode = str(os.environ.get("TP_ROUTING_MODE") or "stats").strip().lower()
    return {
        "mode_default": mode if mode in MODES else "stats",
        "no_fp4": _flag("TP_ROUTING_NO_FP4", True),
        "explore": _fraction(os.environ.get("TP_ROUTING_EXPLORE"), 0.05),
        "min_samples": 20, "window_days": 7, "cooldown_failures": 3,
        "cooldown_window_min": 10, "cooldown_min": 30,
        "weights": dict(DEFAULT_WEIGHTS), "models": {},
    }


def _int(value: Any, default: int, low: int, high: int) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and low <= value <= high else default


def _model_rules(raw: Any) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    mode = raw.get("mode")
    blocked = [h for h in (host_label(x) for x in raw.get("blocked") or []) if h][:64]
    order = [h for h in (host_label(x) for x in raw.get("manual_order") or []) if h][:32]
    return {"mode": mode if mode in MODES else None, "blocked": blocked,
            "pinned": host_label(raw.get("pinned")) or None,
            "manual_order": list(dict.fromkeys(order)), "manual_fallback": raw.get("manual_fallback") is True}


def normalize(raw: Any) -> dict[str, Any]:
    """Center settings -> the same shape as env_defaults(); invalid fields keep defaults.

    `models` is accepted as {model_id: rules} or [{model, family?, ...rules}];
    a key `family:model` targets one family only."""
    base = env_defaults()
    raw = raw if isinstance(raw, dict) else {}
    result = dict(base)
    if raw.get("mode_default") in MODES:
        result["mode_default"] = raw["mode_default"]
    if isinstance(raw.get("no_fp4"), bool):
        result["no_fp4"] = raw["no_fp4"]
    result["explore"] = _fraction(raw.get("explore"), base["explore"]) if "explore" in raw else base["explore"]
    result["min_samples"] = _int(raw.get("min_samples"), 20, 1, 100000)
    result["window_days"] = _int(raw.get("window_days"), 7, 1, 30)
    result["cooldown_failures"] = _int(raw.get("cooldown_failures"), 3, 1, 1000)
    result["cooldown_window_min"] = _int(raw.get("cooldown_window_min"), 10, 1, 1440)
    result["cooldown_min"] = _int(raw.get("cooldown_min"), 30, 0, 1440)
    weights = raw.get("weights") if isinstance(raw.get("weights"), dict) else {}
    result["weights"] = {k: float(weights[k]) if isinstance(weights.get(k), (int, float)) and not isinstance(weights.get(k), bool)
                         and 0 <= weights[k] <= 10 else v for k, v in DEFAULT_WEIGHTS.items()}
    models: dict[str, Any] = {}
    entries = raw.get("models")
    if isinstance(entries, dict):
        items = list(entries.items())
    elif isinstance(entries, list):
        items = [((f"{e['family']}:{e['model']}" if e.get("family") else e.get("model")), e)
                 for e in entries if isinstance(e, dict) and isinstance(e.get("model"), str)]
    else:
        items = []
    for key, value in items[:2048]:
        if isinstance(key, str) and 0 < len(key) <= 200:
            models[key] = _model_rules(value)
    result["models"] = models
    return result


def apply_center(raw: Any) -> None:
    global _center
    value = normalize(raw)
    with _lock:
        _center = value


def current() -> dict[str, Any]:
    with _lock:
        if _center is not None:
            return deepcopy(_center)
    return env_defaults()


def for_model(family: str, model: str, settings: dict[str, Any] | None = None) -> tuple[str, dict[str, Any], dict[str, Any]]:
    """(mode, model rules, globals) for one model."""
    settings = settings or current()
    models = settings.get("models") or {}
    rules = models.get(f"{family}:{model}") or models.get(model) or _model_rules({})
    mode = rules.get("mode") or settings["mode_default"]
    return mode, rules, settings


def reset() -> None:
    global _center
    with _lock:
        _center = None


__all__ = ["host_label", "env_defaults", "normalize", "apply_center", "current", "for_model", "reset"]
