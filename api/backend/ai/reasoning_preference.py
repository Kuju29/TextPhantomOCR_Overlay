"""Provider-neutral reasoning preference vocabulary and capability resolution."""
from __future__ import annotations
from typing import Any

PREFERENCES = ("minimum", "default", "off", "on", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")
EFFORTS = ("minimal", "low", "medium", "high", "xhigh", "max", "ultra")
_PREFERENCE_SET = set(PREFERENCES)
_EFFORT_SET = set(EFFORTS)


def normalize_reasoning_preference(value: Any, fallback: str = "minimum") -> str:
    if value is True:
        return "on"
    if value is False:
        return "off"
    raw = str(value or "").strip().lower()
    if raw in {"auto", "provider", "provider_default"}:
        return "default"
    if raw in {"lowest", "lowest_available", "min"}:
        return "minimum"
    if raw == "none":
        return "off"
    if raw in _PREFERENCE_SET:
        return raw
    return fallback if fallback in _PREFERENCE_SET else "minimum"


def concrete_reasoning_preferences(reasoning: Any) -> tuple[str, ...]:
    """Concrete model options ordered from lowest to highest reasoning."""
    cap = reasoning if isinstance(reasoning, dict) else {}
    if cap.get("supported") is not True:
        return ()
    mandatory = cap.get("mandatory") is True
    control = str(cap.get("control") or "provider")
    supported = {
        str(value).strip().lower() for value in cap.get("supported_efforts", [])
        if isinstance(value, str)
    }
    out: list[str] = []
    # An explicit mandatory=false is provider evidence that reasoning is optional.
    # Some catalogues publish the effort ladder separately and transiently omit
    # can_disable/none; do not let that stale metadata erase the user's Off intent.
    if not mandatory and (cap.get("mandatory") is False or cap.get("can_disable") is True
                          or control in {"toggle", "boolean"} or "none" in supported):
        out.append("off")
    if control in {"toggle", "boolean"}:
        out.append("on")
        return tuple(out)
    if control == "levels":
        out.extend(effort for effort in EFFORTS if effort in supported)
    return tuple(out)


def minimum_reasoning_preference(reasoning: Any) -> str:
    """Lowest available is the first concrete capability option, not a fixed effort."""
    options = concrete_reasoning_preferences(reasoning)
    return options[0] if options else "default"


def supported_reasoning_preferences(reasoning: Any) -> tuple[str, ...]:
    cap = reasoning if isinstance(reasoning, dict) else {}
    if not isinstance(cap.get("supported"), bool):
        return ("default",)
    if cap.get("supported") is False:
        return ()
    concrete = concrete_reasoning_preferences(cap)
    out: list[str] = []
    if concrete:
        out.append("minimum")
    out.append("default")
    out.extend(concrete)
    return tuple(out)


def resolve_reasoning_preference(value: Any, reasoning: Any) -> str:
    requested = normalize_reasoning_preference(value, "minimum")
    cap = reasoning if isinstance(reasoning, dict) else {}
    minimum = minimum_reasoning_preference(cap)
    if requested == "minimum":
        return minimum
    # Off is persistent user intent.  Capability discovery may be stale or may
    # describe a model that simply has no reasoning control; neither case may
    # silently turn the saved selection into Low/Default.  Only an explicitly
    # mandatory-reasoning model is allowed to clamp Off at dispatch time.
    if requested == "off":
        if cap.get("mandatory") is True:
            return minimum if minimum != "default" else "default"
        return "off"
    supported = supported_reasoning_preferences(cap)
    if not supported:
        return "default"
    if requested in supported:
        return requested
    return "default"


def reasoning_is_active(value: Any, reasoning: Any) -> bool:
    cap = reasoning if isinstance(reasoning, dict) else {}
    selected = resolve_reasoning_preference(value, cap)
    if selected == "off":
        return False
    if selected == "on" or selected in _EFFORT_SET:
        return True
    return cap.get("mandatory") is True or cap.get("default_enabled") is True
