"""OpenAI Chat Completions reasoning contracts (documented IDs, not prefix guesses).

Sources: https://developers.openai.com/api/docs/models/{model}
Verified 2026-09-28. Account /models still owns availability. Unknown IDs retain
selected-model feature discovery; no forced model change and no guessed Off.
"""
from __future__ import annotations
import re

# A dated snapshot inherits only its exact documented alias, never a new version.
_LEVELS = {
    "gpt-5": ("minimal", "low", "medium", "high"),
    "gpt-5.1": ("none", "low", "medium", "high"),
    "gpt-5.2": ("none", "low", "medium", "high", "xhigh"),
    "gpt-5.6-luna": ("none", "low", "medium", "high", "xhigh", "max"),
    "gpt-5.6": ("none", "low", "medium", "high", "xhigh", "max"),
    "gpt-5.6-sol": ("none", "low", "medium", "high", "xhigh", "max"),
    "gpt-5.6-terra": ("none", "low", "medium", "high", "xhigh", "max"),
}
_NON_REASONING = frozenset({
    "gpt-3.5-turbo", "gpt-3.5-turbo-0125", "gpt-3.5-turbo-1106", "gpt-3.5-turbo-16k",
    "gpt-4", "gpt-4-0613", "gpt-4-0314", "gpt-4-turbo", "gpt-4-turbo-preview",
    "gpt-4-0125-preview", "gpt-4-1106-preview", "gpt-4o", "gpt-4o-mini",
    "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
})

def reasoning_capability(model: str) -> dict:
    value = str(model or "").strip().lower()
    # Fine-tunes retain a documented base's wire contract, not another model's
    # account permissions. The selected fine-tune itself still needs a probe.
    if value.startswith("ft:"):
        value = value.split(":", 2)[1]
    alias = re.sub(r"-\d{4}-\d{2}-\d{2}$", "", value)
    if value in _NON_REASONING or alias in _NON_REASONING:
        return {"supported": False, "control": "none", "source": "openai_documented_model_card"}
    levels = _LEVELS.get(value) or _LEVELS.get(alias)
    if not levels:
        return {}
    return {"supported": True, "mandatory": "none" not in levels, "control": "levels",
            "supported_efforts": list(levels), "source": "openai_documented_model_card"}

def reasoning_family(model: str) -> bool:
    value = str(model or "").lower()
    if value.startswith("ft:"):
        value = value.split(":", 2)[1]
    return bool(re.match(r"^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))", value))
