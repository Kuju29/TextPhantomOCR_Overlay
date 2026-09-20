from backend.ai.providers.cloud_anthropic import _reasoning_capability, _apply_reasoning
from backend.ai.reasoning_preference import supported_reasoning_preferences


def prefs(model: str):
    return supported_reasoning_preferences(_reasoning_capability(model))


# Current Anthropic model families have different native reasoning semantics.
sonnet5 = _reasoning_capability("claude-sonnet-5")
assert sonnet5["default_enabled"] is True
assert sonnet5["mandatory"] is False
assert prefs("claude-sonnet-5") == ("minimum", "default", "off", "low", "medium", "high", "xhigh", "max")

opus48 = _reasoning_capability("claude-opus-4-8")
assert opus48["default_enabled"] is False
assert prefs("claude-opus-4-8") == ("minimum", "default", "off", "low", "medium", "high", "xhigh", "max")

sonnet46 = _reasoning_capability("claude-sonnet-4-6")
assert sonnet46["default_enabled"] is False
assert prefs("claude-sonnet-4-6") == ("minimum", "default", "off", "low", "medium", "high", "max")

fable5 = _reasoning_capability("claude-fable-5")
assert fable5["mandatory"] is True
assert "off" not in prefs("claude-fable-5")
assert prefs("claude-fable-5") == ("minimum", "default", "low", "medium", "high", "xhigh", "max")

assert _reasoning_capability("claude-3-7-sonnet") == {}, "unknown/legacy wire shapes must not be guessed"

# Provider default = no field. Exact user choices map only when this leaf knows
# the selected model's native Anthropic wire contract.
payload = {}
assert _apply_reasoning(payload, "claude-sonnet-5", "default") == "provider_default"
assert payload == {}

payload = {}
assert _apply_reasoning(payload, "claude-sonnet-5", "minimum") == "requested_off"
assert payload == {"thinking": {"type": "disabled"}}, "TextPhantom minimum must choose the lowest proven native mode"

payload = {}
assert _apply_reasoning(payload, "claude-sonnet-5", "off") == "requested_off"
assert payload == {"thinking": {"type": "disabled"}}

payload = {}
assert _apply_reasoning(payload, "claude-sonnet-5", "low") == "requested_effort_low"
assert payload["thinking"] == {"type": "adaptive"}
assert payload["output_config"] == {"effort": "low"}

payload = {}
assert _apply_reasoning(payload, "claude-sonnet-5", "on") == "provider_default"
assert payload == {}, "generic On must not be guessed into an Anthropic effort"

payload = {}
assert _apply_reasoning(payload, "claude-fable-5", "off") == "requested_effort_low"
assert payload["thinking"] == {"type": "adaptive"}
assert payload["output_config"] == {"effort": "low"}, "unsupported stale Off must clamp to the lowest native effort, never a higher provider default"

payload = {}
assert _apply_reasoning(payload, "claude-3-7-sonnet", "high") == "provider_default"
assert payload == {}, "legacy/unknown Anthropic model remains usable on provider default"

print("PASS Anthropic model-specific reasoning capability and wire mapping")
