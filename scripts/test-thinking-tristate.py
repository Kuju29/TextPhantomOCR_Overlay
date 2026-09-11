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
from backend.ai.providers.cloud_openrouter import prepare_payload as openrouter_payload
from backend.ai.providers.cloud_deepseek import POLICY
from backend.ai.providers.openai_provider_runtime import build_payload
from backend.ai.translation.invocation import resolve_thinking_selection
from backend.application.ai_translation.request_validation import build_config

def request(mode="auto", caps=None):
    return GenerationRequest(provider="openrouter", model="fixture", system_text="s", user_parts=("u",),
                             thinking=mode, model_capabilities=caps or {})

assert request("garbage").thinking == "off"
assert request("auto").thinking == "off"
payload = openrouter_payload(request("auto", {"reasoning":{"supported":True,"control":"toggle","default_enabled":True}}))
assert payload["reasoning"]["enabled"] is False
payload = openrouter_payload(request("off", {"reasoning":{"supported":True,"control":"toggle"}}))
assert payload["reasoning"]["enabled"] is False
deepseek = build_payload(GenerationRequest(provider="deepseek", model="deepseek-chat", system_text="s",
    user_parts=("u",), thinking="auto"), "deepseek-chat", POLICY)
assert "thinking" not in deepseek
def ingress(value=...):
    provider = {"id": "ollama", "model": "fixture", "baseUrl": "http://localhost:11434"}
    if value is not ...:
        provider["thinking"] = value
    return build_config({"provider": provider, "prompt_mode": "replace", "prompt": "STYLE"}).thinking

for incoming in (..., None, "", "auto", "garbage", False, 7):
    assert ingress(incoming) == "off"
assert ingress("off") == "off"
assert ingress("on") == "on"
for caps in ({}, {"supported": False}, {"supported": None},
             {"supported": True, "control": "levels"}):
    assert resolve_thinking_selection("off", caps) == "off"
assert resolve_thinking_selection("on", {"supported": True, "control": "boolean"}) == "on"
try:
    resolve_thinking_selection("off", {"supported": True, "mandatory": True})
except ValueError as error:
    assert getattr(error, "code", "") == "AI_THINKING_REQUIRED"
    assert "[AI option > AI thinking]" in str(error)
else:
    raise AssertionError("mandatory thinking must block an explicit Off selection")
print("PASS API thinking defaults Off while unsupported providers omit native controls")
