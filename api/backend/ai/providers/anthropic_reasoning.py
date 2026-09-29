"""Anthropic-native manual and adaptive Thinking contracts; no generic effort coercion.
Sources: https://platform.claude.com/docs/en/build-with-claude/thinking
and /extended-thinking (verified 2026-09-28).
"""
import re
from backend.ai.reasoning_preference import resolve_reasoning_preference

def _is_model_or_snapshot(model: str, prefix: str) -> bool:
    m = (model or "").strip().lower()
    return m == prefix or re.fullmatch(re.escape(prefix) + r"-\d{8}", m) is not None

def _reasoning_capability(model_id: str) -> dict:
    """Documented Anthropic reasoning controls for exact manual/adaptive families.

    Unknown models deliberately return no capability rather than receiving guessed fields.
    """
    model = (model_id or "").strip().lower()

    def levels(efforts, *, default_enabled: bool, mandatory: bool = False, default_effort: str = "high"):
        supported = list(efforts)
        if not mandatory and "none" not in supported:
            supported.insert(0, "none")
        return {
            "supported": True,
            "mandatory": mandatory,
            "default_enabled": default_enabled,
            "control": "levels",
            "dynamic": True,
            "supported_efforts": supported,
            "default_effort": default_effort,
        }

    # Claude 5: adaptive thinking is provider-default ON. Opus/Sonnet can be
    # disabled explicitly; Fable/Mythos are adaptive-thinking-only.
    if _is_model_or_snapshot(model, "claude-opus-5-5"):
        return levels(("low", "medium", "high", "xhigh", "max"),
                      default_enabled=True, mandatory=True, default_effort="medium")
    if _is_model_or_snapshot(model, "claude-opus-5") or _is_model_or_snapshot(model, "claude-sonnet-5"):
        return levels(("low", "medium", "high", "xhigh", "max"), default_enabled=True)
    if any(_is_model_or_snapshot(model, prefix) for prefix in (
        "claude-fable-5-1", "claude-mythos-5-1", "claude-fable-5", "claude-mythos-5"
    )):
        return levels(("low", "medium", "high", "xhigh", "max"),
                      default_enabled=True, mandatory=True)
    if _is_model_or_snapshot(model, "claude-mythos-preview"):
        return levels(("low", "medium", "high", "max"),
                      default_enabled=True, mandatory=True)

    # Claude 4.6-4.8 adaptive thinking is opt-in: omitting `thinking` keeps it
    # off. The exact effort ladders differ by family/version.
    if _is_model_or_snapshot(model, "claude-opus-4-7") or _is_model_or_snapshot(model, "claude-opus-4-8"):
        return levels(("low", "medium", "high", "xhigh", "max"), default_enabled=False)
    if _is_model_or_snapshot(model, "claude-opus-4-6") or _is_model_or_snapshot(model, "claude-sonnet-4-6"):
        return levels(("low", "medium", "high", "max"), default_enabled=False)

    # Extended-thinking budget is not an effort ladder. Keep native On/Off
    # separate; 1024 is Anthropic's documented minimum manual thinking budget.
    if any(_is_model_or_snapshot(model, prefix) for prefix in (
        "claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5",
        "claude-sonnet-4", "claude-opus-4", "claude-opus-4-1", "claude-3-7-sonnet",
    )):
        return {"supported": True, "mandatory": False, "control": "toggle",
                "supported_efforts": ["none", "on"], "minimum_budget_tokens": 1024,
                "source": "anthropic_extended_thinking"}
    return {}


def _apply_reasoning(payload: dict, model: str, requested: str, model_capabilities=None) -> str:
    """Map TextPhantom's provider-neutral preference to Anthropic-native fields.

    Provider default means *omit* the reasoning fields. This is important because
    Claude 4.6-4.8 default to thinking off while Claude 5 defaults to adaptive
    thinking on. TextPhantom's `minimum` preference (and stale Off on a
    mandatory-reasoning family) resolves through the shared capability layer to
    the lowest exact native mode instead of inheriting a potentially heavier
    provider default.
    """
    external = (model_capabilities or {}).get("reasoning", {}) if isinstance(model_capabilities, dict) else {}
    external = external if isinstance(external, dict) else {}
    native = _reasoning_capability(model)
    cap = native or external
    selected = resolve_reasoning_preference(requested, cap) if cap else "default"
    if selected == "default":
        return "provider_default"

    # Only emit native Anthropic fields for model families whose exact wire
    # contract is known here. Generic/externally-described models stay on the
    # provider default instead of receiving guessed Anthropic syntax.
    if not native:
        return "provider_default_unverified_wire"

    if selected == "off":
        payload["thinking"] = {"type": "disabled"}
        return "requested_off"

    if native.get("control") == "toggle" and selected == "on":
        budget = native["minimum_budget_tokens"]
        if int(payload.get("max_tokens") or 0) <= budget:
            from backend.ai.workload import WorkloadBudgetError
            raise WorkloadBudgetError("Anthropic manual Thinking requires answer space beyond its 1024-token budget")
        payload["thinking"] = {"type": "enabled", "budget_tokens": budget}
        return "requested_manual_minimum"

    efforts = {str(value).strip().lower() for value in native.get("supported_efforts", [])
               if isinstance(value, str)}
    if selected in efforts and selected != "none":
        payload["thinking"] = {"type": "adaptive"}
        payload["output_config"] = {**(payload.get("output_config") or {}), "effort": selected}
        return f"requested_effort_{selected}"

    # `on` has no single stable Anthropic meaning across current families.
    # If it reaches this provider through a stale profile, preserve provider
    # default rather than silently choosing an effort.
    return "provider_default_incompatible_preference"
