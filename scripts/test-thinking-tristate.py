import sys
import types

# Keep this provider-boundary test runnable in extension-only environments.
# No HTTP method is executed; the stub only satisfies provider annotations.
try:
    import httpx  # noqa: F401
except ModuleNotFoundError:
    class _RequestError(Exception):
        pass
    httpx_stub = types.ModuleType("httpx")
    httpx_stub.RequestError = _RequestError
    httpx_stub.HTTPStatusError = _RequestError
    httpx_stub.Response = object
    httpx_stub.Client = object
    httpx_stub.Timeout = lambda **kwargs: kwargs
    httpx_stub.get = lambda *args, **kwargs: None
    sys.modules["httpx"] = httpx_stub

from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers.cloud_openrouter import (prepare_payload as openrouter_payload,
    normalize_capabilities as openrouter_capabilities, _apply_official_routing)
from backend.ai.providers.cloud_deepseek import POLICY
from backend.ai.providers.openai_provider_runtime import build_payload
from backend.ai.translation.invocation import resolve_thinking_selection
from backend.application.ai_translation.request_validation import build_config
from backend.ai.provider_resolution import normalize_model_capabilities

def request(mode="auto", caps=None):
    return GenerationRequest(provider="openrouter", model="fixture", system_text="s", user_parts=("u",),
                             thinking=mode, model_capabilities=caps or {})

assert request("garbage").thinking == "off"
assert request("auto").thinking == "default"
payload = openrouter_payload(request("auto", {"reasoning":{"supported":True,"control":"toggle","default_enabled":True}}))
assert "reasoning" not in payload
assert "max_completion_tokens" in payload
payload = openrouter_payload(request("off", {"reasoning":{"supported":True,"control":"toggle"}}))
assert payload["reasoning"]["enabled"] is False

# Lowest available must select the first concrete option, not a fixed effort.
router_caps = openrouter_capabilities({
    "supported_parameters": ["reasoning"],
    "reasoning": {
        "mandatory": False, "default_enabled": True,
        "supported_efforts": ["max", "high", "low"], "default_effort": "high",
    },
})["reasoning"]
assert router_caps["can_disable"] is True
assert resolve_thinking_selection("minimum", router_caps) == "off"
cached_router_caps = normalize_model_capabilities({"reasoning": router_caps})["reasoning"]
assert cached_router_caps["can_disable"] is True
assert resolve_thinking_selection("minimum", cached_router_caps) == "off"
payload = openrouter_payload(request("off", {"reasoning": router_caps}))
assert payload["reasoning"] == {"effort": "none"}, payload
assert "temperature" in payload and "max_tokens" in payload

# Official OpenRouter requests follow the same speed-first provider routing that
# Hermes exposes, while custom compatible gateways are not modified.
routed = _apply_official_routing({"model":"fixture"}, "https://openrouter.ai/api/v1")
assert routed["provider"] == {"sort":"throughput", "allow_fallbacks":True, "require_parameters":True, "preferred_max_latency":{"p90":8}}
assert "provider" not in _apply_official_routing({"model":"fixture"}, "https://proxy.example/v1")

# Workload prediction owns the normal completion reservation.  A short marker
# translation must not advertise the old 7-8K ceiling when Thinking is Off.
dynamic = GenerationRequest(provider="openrouter", model="fixture", system_text="s"*100,
    user_parts=("x"*800,), thinking="off", unit_count=20,
    workload={"version":1,"predictedOutput":1000,"reasoningReserve":3000,"estimatedInput":2000,"completionAvailable":8192},
    model_capabilities={"reasoning":{"supported":True,"control":"levels","can_disable":True,"supported_efforts":["low"]}})
dynamic_payload = openrouter_payload(dynamic)
assert dynamic_payload["max_tokens"] <= 1750, dynamic_payload["max_tokens"]
assert dynamic_payload["reasoning"] == {"effort":"none"}

deepseek = build_payload(GenerationRequest(provider="deepseek", model="deepseek-chat", system_text="s",
    user_parts=("u",), thinking="auto"), "deepseek-chat", POLICY)
assert "thinking" not in deepseek
def ingress(value=...):
    provider = {"id": "ollama", "model": "fixture", "baseUrl": "http://localhost:11434"}
    if value is not ...:
        provider["thinking"] = value
    return build_config({"provider": provider, "prompt_mode": "replace", "prompt": "STYLE"}).thinking

for incoming in (..., None, "", "garbage", 7):
    assert ingress(incoming) == "off"
assert ingress(False) == "off"
assert ingress("auto") == "default"
assert ingress("off") == "off"
assert ingress("on") == "on"
for caps in ({}, {"supported": False}, {"supported": None},
             {"supported": True, "control": "levels"}):
    assert resolve_thinking_selection("minimum", caps) == "default"
assert resolve_thinking_selection("on", {"supported": True, "control": "boolean"}) == "on"
assert resolve_thinking_selection("off", {"supported": True, "control": "boolean"}) == "off"
assert resolve_thinking_selection("off", {"supported": True, "mandatory": False, "control": "levels",
                                         "supported_efforts": ["low", "high"]}) == "off"
assert resolve_thinking_selection("off", {}) == "off"
assert resolve_thinking_selection("off", {"supported": False}) == "off"
stale_optional = openrouter_payload(request("off", {"reasoning": {"supported": True, "mandatory": False,
    "control": "levels", "supported_efforts": ["low", "high"]}}))
assert stale_optional["reasoning"] == {"effort": "none"}, stale_optional
assert resolve_thinking_selection("off", {"supported": True, "mandatory": True, "control": "boolean"}) == "on"
assert resolve_thinking_selection("off", {"supported": True, "mandatory": True, "control": "levels",
                                         "supported_efforts": ["minimal", "low", "medium", "high"]}) == "minimal"
assert resolve_thinking_selection("high", {"supported": True, "mandatory": True, "control": "levels",
                                          "supported_efforts": ["low", "medium", "high"]}) == "high"
assert resolve_thinking_selection("off", {"supported": True, "mandatory": False, "control": "levels",
                                         "supported_efforts": ["none", "low", "medium"]}) == "off"
print("PASS API provider-neutral reasoning preferences and capability fallback")
