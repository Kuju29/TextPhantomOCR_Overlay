"""One pure classification of a selected model's AI think (reasoning) control.

Mirrored exactly by ``src/shared/thinking-state.js``; both are checked against
``scripts/fixtures/thinking-states-10488.json``. The input is the normalized
``model_capabilities.reasoning`` record for one exact provider/account/model
plus whether that record is fresh. No model names are interpreted here: every
provider normalizer (catalogue, native documented map, local runtime metadata,
Paid Center catalogue, Login session) decides what the record says.

States
  controllable  the record proves at least one selectable control
  none          the record proves the model has no reasoning
  default       the record is fresh but proves no selectable control
                (catalogue silent, or reasoning present with control "provider")
  loading       no fresh record yet (not loaded, stale, being fetched, failed)

``loading`` is never ``default``: a late or failed catalogue lookup must not
send a reasoning model without its control.
"""

from __future__ import annotations

from typing import Any

THINKING_STATES = ("controllable", "none", "default", "loading")
# The order is ascending reasoning strength; it matches the extension.
# claude.ai's effort ids are low/medium/high/xhigh/max (10492 capture); "extra"
# (between xhigh and max, added in .89) stays for saved profiles.
_EFFORTS = ("minimal", "low", "medium", "high", "xhigh", "extra", "max", "ultra")


def _effort_name(value: Any) -> str:
    # JavaScript ``String(value || "")``: falsy values become "".
    if value is None or value is False or value == "" or (
            isinstance(value, (int, float)) and not isinstance(value, bool) and value == 0):
        return ""
    if value is True:
        return "true"
    return str(value).strip().lower()


def thinking_control_options(reasoning: Any) -> tuple[str, ...]:
    """Concrete selectable controls, lowest first (``off``, ``on`` or efforts)."""
    cap = reasoning if isinstance(reasoning, dict) else {}
    if cap.get("supported") is not True:
        return ()
    mandatory = cap.get("mandatory") is True
    control = cap.get("control") if isinstance(cap.get("control"), str) else "provider"
    efforts_raw = cap.get("supported_efforts")
    efforts_listed = isinstance(efforts_raw, list)
    efforts = {_effort_name(value) for value in efforts_raw} if efforts_listed else set()
    out: list[str] = []
    if not mandatory and (cap.get("mandatory") is False or cap.get("can_disable") is True
                          or control in {"toggle", "boolean"} or "none" in efforts):
        out.append("off")
    if control in {"toggle", "boolean"}:
        if not efforts_listed or "on" in efforts:
            out.append("on")
        return tuple(out)
    if control == "levels":
        out.extend(effort for effort in _EFFORTS if effort in efforts)
    return tuple(out)


def classify_thinking_state(reasoning: Any, *, fresh: bool) -> str:
    """Return exactly one of :data:`THINKING_STATES` for a selected model."""
    if fresh is not True:
        return "loading"
    cap = reasoning if isinstance(reasoning, dict) else {}
    if cap.get("supported") is False and cap.get("mandatory") is not True:
        return "none"
    if thinking_control_options(cap):
        return "controllable"
    return "default"


def sends_provider_default(state: str) -> bool:
    """The control is not offered, so the request carries no thinking field."""
    return state in {"none", "default"}


__all__ = ["THINKING_STATES", "classify_thinking_state", "sends_provider_default",
           "thinking_control_options"]
