"""Cloud reasoning preflight: preserve explicit Thinking and Lowest user intent."""

from __future__ import annotations

from typing import Any

from backend.ai.reasoning_preference import EFFORTS, minimum_reasoning_preference

PROVIDER_MANAGED_UNVERIFIED = "provider_managed_unverified"


class CloudReasoningPreferenceUnavailable(ValueError):
    """The selected cloud model cannot prove the requested reasoning setting."""

    requestDispatched = False
    providerAttempts = 0
    generationAttempts = 0

    def __init__(self, provider: str, model: str, requested: str):
        self.requested = requested
        if requested == "off":
            self.code = "ai_thinking_off_unavailable"
            detail = ("Thinking Off cannot be verified for this model; choose a model with "
                      "verified Off support, or Lowest available where supported.")
        elif requested == "minimum":
            self.code = "ai_thinking_minimum_unavailable"
            detail = ("The lowest reasoning mode cannot be verified for this model; "
                      "choose a model with verified reasoning controls.")
        else:
            self.code = "ai_thinking_mode_unavailable"
            detail = (f"Thinking {requested} cannot be verified for this model; "
                      "choose a model with that verified reasoning control.")
        super().__init__(f"{provider}/{model}: {detail}")


def observed_off_status(result: Any) -> str:
    """Report an Off request from response evidence, including unmetered reasoning."""
    tokens = result.thinking_tokens
    if result.reasoning_observed or (type(tokens) is int and tokens > 0):
        return "provider_ignored_off"
    if type(tokens) is int and tokens == 0:
        return "requested_off_observed_zero_reasoning"
    return "requested_off_unverified_effect"


def native_reasoning_capability(provider: str, model: str) -> dict[str, Any]:
    """Return exact native facts when the leaf adapter has a model-specific map."""
    if provider == "openai":
        from backend.ai.providers.openai_reasoning import reasoning_capability
        return reasoning_capability(model)
    if provider == "anthropic":
        from backend.ai.providers.cloud_anthropic import _reasoning_capability
        return _reasoning_capability(model)
    if provider == "gemini":
        from backend.ai.providers.cloud_gemini import _reasoning_capability
        return _reasoning_capability(model)
    if provider == "groq":
        from backend.ai.providers.cloud_groq import _reasoning_capability
        return _reasoning_capability(model)
    if provider == "together":
        from backend.ai.providers.cloud_together import _reasoning_capability
        return _reasoning_capability(model)
    return {}


def _known_reasoning_model(provider: str, model: str, cap: dict[str, Any]) -> bool:
    if cap.get("supported") is True or cap.get("mandatory") is True:
        return True
    if provider == "openai":
        from backend.ai.providers.cloud_openai import _reasoning_family
        return _reasoning_family(model)
    if provider == "deepseek":
        # The account catalogue classifies the exact V4 family as reasoning.
        return model.lower().startswith("deepseek-v4-")
    return False


def _efforts(cap: dict[str, Any]) -> set[str]:
    return {value.strip().lower() for value in cap.get("supported_efforts", [])
            if isinstance(value, str)}


def _proven_off(provider: str, model: str, cap: dict[str, Any]) -> bool:
    if cap.get("supported") is not True or cap.get("mandatory") is True:
        return False
    control, efforts = cap.get("control"), _efforts(cap)
    optional = (cap.get("mandatory") is False or cap.get("can_disable") is True
                or "none" in efforts or control in {"toggle", "boolean"})
    if not optional:
        return False
    if provider == "openrouter":
        # The OpenRouter adapter sends effort:none for optional models or
        # enabled:false for explicit boolean controls.
        return True
    if provider in {"openai", "huggingface"}:
        return control == "levels" and "none" in efforts
    if provider == "deepseek":
        return control in {"toggle", "boolean", "levels"}
    if provider == "anthropic":
        return bool(native_reasoning_capability(provider, model)) and "none" in efforts
    if provider == "gemini":
        # Only native Gemini 2.5 Flash/Lite emit thinkingBudget:0. Gemini 3
        # and 2.5 Pro have no equivalent supported Off control.
        is_flash = model.lower() in {"gemini-2.5-flash", "gemini-2.5-flash-lite"}
        return bool(native_reasoning_capability(provider, model)) and is_flash and "none" in efforts
    if provider == "groq":
        native = native_reasoning_capability(provider, model)
        return bool(native) and native.get("mandatory") is False and control == "levels" and "none" in efforts
    if provider == "together":
        native = native_reasoning_capability(provider, model)
        return bool(native) and native.get("mandatory") is False and control == "boolean"
    # Featherless and the operator's Paid service lack a verified disable
    # field for the selected model/template in their current adapters.
    return False


def _proven_active(provider: str, model: str, selected: str, cap: dict[str, Any]) -> bool:
    control, efforts = cap.get("control"), _efforts(cap)
    if selected == "on":
        if provider in {"deepseek", "openrouter", "anthropic"} and control in {"toggle", "boolean"}:
            return True
        return provider == "together" and bool(native_reasoning_capability(provider, model)) and control == "boolean"
    if control != "levels" or selected not in efforts:
        return False
    if provider in {"openrouter", "openai", "deepseek", "huggingface"}:
        return True
    if provider == "anthropic":
        return bool(native_reasoning_capability(provider, model))
    if provider == "gemini":
        native = native_reasoning_capability(provider, model)
        return bool(native) and (selected in {"low", "medium", "high"}
                if model.lower().startswith("gemini-2.5-") else True)
    if provider in {"groq", "together"}:
        return bool(native_reasoning_capability(provider, model))
    return False


def ensure_cloud_reasoning_preflight(provider: str, model: str, requested: str,
                                     selected: str, capability: Any, *,
                                     capability_verified: bool = False) -> str | None:
    """Reject unproved explicit controls; mark unproved Lowest for fallback.

    The exact account catalogue, a selected-model probe, or an adapter's
    documented native family can establish a control. Client-supplied
    snapshots alone cannot prove Off, Lowest, On or a named effort for the route. The
    caller must send provider default and report ``PROVIDER_MANAGED_UNVERIFIED``
    if this returns that marker; it must never send an unverified concrete mode.
    """
    if requested not in {"off", "minimum", "on", *EFFORTS}:
        return
    cap = capability if isinstance(capability, dict) else {}
    known_reasoner = _known_reasoning_model(provider, model, cap)
    if (capability_verified and cap.get("supported") is False and
            not known_reasoner):
        # A current account-scoped negative explicitly proves the model has no
        # reasoning to disable. Explicit On or a named effort cannot apply.
        if requested in {"off", "minimum"}:
            return
        raise CloudReasoningPreferenceUnavailable(provider, model, requested)
    if requested == "off":
        if (not capability_verified or not known_reasoner or selected != "off"
                or not _proven_off(provider, model, cap)):
            raise CloudReasoningPreferenceUnavailable(provider, model, requested)
        return
    if requested != "minimum":
        # A persisted named/On choice is a constraint, not permission to omit
        # its control when the current model or catalogue no longer supports it.
        if (not capability_verified or not known_reasoner or selected != requested
                or not _proven_active(provider, model, selected, cap)):
            raise CloudReasoningPreferenceUnavailable(provider, model, requested)
        return
    if not capability_verified or not known_reasoner:
        return PROVIDER_MANAGED_UNVERIFIED
    # A catalogue may mix familiar levels with provider-specific levels such
    # as "nano". Their relative order is unknown; never certify "low" as Lowest.
    minimum = minimum_reasoning_preference(cap)
    if minimum == "default" or selected != minimum:
        return PROVIDER_MANAGED_UNVERIFIED
    if (selected == "off" and _proven_off(provider, model, cap)) or (
            selected not in {"off", "default"} and _proven_active(provider, model, selected, cap)):
        return
    return PROVIDER_MANAGED_UNVERIFIED
