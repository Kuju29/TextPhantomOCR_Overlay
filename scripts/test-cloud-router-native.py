"""Exact native Cloud Router controls, catalogue evidence, and history contract."""

import sys
import re
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

import httpx

from backend.ai import resolve as resolve_service
from backend.ai.clients.base import ChatResult
from backend.ai.cloud_reasoning import (
    CloudReasoningPreferenceUnavailable, ensure_cloud_reasoning_preflight, native_reasoning_capability,
)
from backend.ai.reasoning_preference import resolve_reasoning_preference
from backend.ai.provider_bootstrap import ensure_provider_registry
from backend.ai.provider_contract import GenerationRequest, ProbeRequest
from backend.ai.providers import cloud_featherless, cloud_groq, cloud_huggingface, cloud_openrouter, cloud_together


def request(provider, model, capability=None, thinking="off", *, image=False):
    return GenerationRequest(provider=provider, model=model, api_key="fixture", base_url="https://example.invalid/v1",
        system_text="fixed system", user_parts=("<<TP_I2_P0:new>>",), expected_ids=("I2_P0",),
        history_messages=({"role": "user", "content": "<<TP_I1_P0:old>>"},
                          {"role": "assistant", "content": "<<TP_I1_P0:translation>>"}),
        model_capabilities={"reasoning": capability} if capability else {}, thinking=thinking,
        image_b64="AAA=" if image else "", image_mime="image/png")


checks = 0


def check(test):
    global checks
    assert test
    checks += 1


groq_cap = cloud_groq._reasoning_capability("qwen/qwen3.8-27b")
together_cap = cloud_together._reasoning_capability("Qwen/Qwen3.5-9B")
check(groq_cap["supported_efforts"] == ["none", "low", "medium", "high"])
check(not cloud_groq._reasoning_capability("qwen/qwen3.6-27b"))
check(not cloud_groq._reasoning_capability("qwen/qwen3-32b"))
check(not cloud_groq._reasoning_capability("qwen/qwen3.8-27b-private"))
check(cloud_groq._reasoning_capability("openai/gpt-oss-120b")["mandatory"] is True)
check(cloud_together._reasoning_capability("openai/gpt-oss-120b")["mandatory"] is True)
check(not cloud_together._reasoning_capability("openai/gpt-oss-120b-custom"))
check(cloud_together.DEFAULT_MODEL == "openai/gpt-oss-20b")
extension_spec = (Path(__file__).resolve().parents[1] / "src/shared/ai/providers/cloud-together.js").read_text()
extension_default = re.search(r'defaultModel:\s*"([^"]+)"', extension_spec)
check(extension_default is not None and extension_default.group(1) == cloud_together.DEFAULT_MODEL)
for provider, model in (("groq", "qwen/qwen3.8-27b"), ("together", "Qwen/Qwen3.5-9B")):
    cap = native_reasoning_capability(provider, model)
    check(cap == (groq_cap if provider == "groq" else together_cap))
    chosen = resolve_reasoning_preference("minimum", cap)
    check(chosen == "off")
    ensure_cloud_reasoning_preflight(provider, model, "minimum", chosen, cap, capability_verified=True)
    checks += 1
    ensure_cloud_reasoning_preflight(provider, model, "off", "off", cap, capability_verified=True)
    checks += 1
check(native_reasoning_capability("featherless", "Qwen/Qwen3-32B") == {})
mandatory = native_reasoning_capability("groq", "openai/gpt-oss-20b")
check(resolve_reasoning_preference("minimum", mandatory) == "low")
ensure_cloud_reasoning_preflight("groq", "openai/gpt-oss-20b", "minimum", "low", mandatory,
                                capability_verified=True)
checks += 1
try:
    ensure_cloud_reasoning_preflight("groq", "openai/gpt-oss-20b", "off", "low", mandatory,
                                    capability_verified=True)
except CloudReasoningPreferenceUnavailable:
    checks += 1
else:
    raise AssertionError("Groq GPT-OSS cannot disable reasoning")
check(cloud_featherless._reasoning_capability("Qwen/Qwen3-32B") == {})

for provider, module, model, cap, key, value in (
    ("groq", cloud_groq, "qwen/qwen3.8-27b", groq_cap, "reasoning_effort", "none"),
    ("together", cloud_together, "Qwen/Qwen3.5-9B", together_cap, "reasoning", {"enabled": False}),
):
    captured = []

    def execute(**kwargs):
        captured.append(kwargs)
        return ChatResult(text="<<TP_I2_P0:okay>>", used_model=model, thinking_tokens=0)

    with patch.object(module, "execute_chat_completion", side_effect=execute):
        output = module.ADAPTER.generate(request(provider, model, cap, image=True))
    payload = captured[0]["payload"]
    check(payload[key] == value)
    check(payload["temperature"] == 0.7)
    check([m["role"] for m in payload["messages"]] == ["system", "user", "assistant", "user"])
    check(payload["messages"][-1]["content"][-1]["image_url"]["url"] == "data:image/png;base64,AAA=")
    check(output.thinking_applied == "requested_off_observed_zero_reasoning")
    check("previous_response_id" not in payload and "session_id" not in payload)
    with patch.object(module, "execute_chat_completion", return_value=ChatResult(
            text="<<TP_I2_P0:okay>>", used_model=model, thinking_tokens=42)):
        output = module.ADAPTER.generate(request(provider, model, cap))
    check(output.thinking_applied == "provider_ignored_off")
    with patch.object(module, "execute_chat_completion", return_value=ChatResult(
            text="<<TP_I2_P0:okay>>", used_model=model, reasoning_observed=True)):
        output = module.ADAPTER.generate(request(provider, model, cap))
    check(output.thinking_applied == "provider_ignored_off")

for provider, module, model, cap in (
    ("groq", cloud_groq, "openai/gpt-oss-20b", cloud_groq._reasoning_capability("openai/gpt-oss-20b")),
    ("together", cloud_together, "openai/gpt-oss-120b", cloud_together._reasoning_capability("openai/gpt-oss-120b")),
):
    captured = []
    with patch.object(module, "execute_chat_completion", side_effect=lambda **kw: (
            captured.append(kw) or ChatResult(text="<<TP_I2_P0:okay>>", used_model=model))):
        output = module.ADAPTER.generate(request(provider, model, cap, thinking="low"))
    check(captured[0]["payload"]["reasoning_effort"] == "low")
    check(output.thinking_applied == "requested_low" if provider == "together" else
          output.thinking_applied == "requested_low_effort_low")
    check("reasoning_effort" not in module._native_control(request(provider, model, cap)) if provider == "together"
          else cloud_groq._native_effort(request(provider, model, cap)) is None)

fee_cap = {"supported": True, "mandatory": False, "control": "boolean"}
check(cloud_featherless._native_control(request("featherless", "Qwen/Qwen3-32B", fee_cap)) ==
      {"chat_template_kwargs": {"enable_thinking": False}})
check(cloud_featherless._native_control(request("featherless", "Qwen/Qwen3-32B-copy", fee_cap)) == {})
check(cloud_featherless._native_control(request("featherless", "Qwen/Qwen3-32B")) == {})


class MockClient:
    body = {}
    def __init__(self, *args, **kwargs):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def get(self, url, **kwargs):
        return httpx.Response(200, json=self.body, request=httpx.Request("GET", url))


MockClient.body = {"data": [
    {"id": "qwen/qwen3.8-27b", "active": True},
    {"id": "qwen/qwen3.6-27b", "active": True},
    {"id": "openai/gpt-oss-20b", "active": True},
]}
with patch("backend.ai.providers.openai_provider_runtime.httpx.Client", MockClient):
    listed = cloud_groq.ADAPTER.list_models(api_key="fixture", base_url="https://example.invalid/v1")
check(listed.status == "valid" and set(listed.models) == {"qwen/qwen3.8-27b", "qwen/qwen3.6-27b", "openai/gpt-oss-20b"})
check(listed.capabilities["qwen/qwen3.8-27b"]["vision"]["supported"] is True)
check(listed.capabilities["qwen/qwen3.6-27b"]["vision"]["supported"] is True)
check("reasoning" not in listed.capabilities["qwen/qwen3.6-27b"])

MockClient.body = {"data": [
    {"id": "Qwen/Qwen3.5-9B", "type": "chat"},
    {"id": "openai/gpt-oss-120b", "type": "chat"},
    {"id": "image-only", "type": "image"},
]}
with patch("backend.ai.providers.openai_provider_runtime.httpx.Client", MockClient):
    listed = cloud_together.ADAPTER.list_models(api_key="fixture", base_url="https://example.invalid/v1")
check(set(listed.models) == {"Qwen/Qwen3.5-9B", "openai/gpt-oss-120b"})
check(listed.capabilities["Qwen/Qwen3.5-9B"]["vision"]["supported"] is True)
check("image-only" not in listed.capabilities)
ensure_provider_registry()
with patch("backend.ai.providers.openai_provider_runtime.httpx.Client", MockClient):
    retired_default = resolve_service.resolve({
        "provider": "together", "api_key": "fixture",
        "model": cloud_together.DEFAULT_MODEL, "lang": "th",
    })
    selected_current = resolve_service.resolve({
        "provider": "together", "api_key": "fixture",
        "model": "Qwen/Qwen3.5-9B", "lang": "th",
    })
check(retired_default["ok"] is False and retired_default["error"] == "model_unavailable")
check(retired_default["model"] == cloud_together.DEFAULT_MODEL)
check(retired_default["model_remapped"] is False)
check(selected_current["ok"] is True and selected_current["model"] == "Qwen/Qwen3.5-9B")

MockClient.body = {"data": [
    {"id": "Qwen/Qwen3-32B", "available_on_current_plan": True, "status": "active",
     "conversational": True, "input_modalities": ["text", "image"],
     "output_modalities": ["text"], "vision_supported": True},
    {"id": "text-only", "available_on_current_plan": True, "status": "active",
     "conversational": True, "vision_supported": False},
    {"id": "no-plan", "available_on_current_plan": False, "status": "active"},
]}
with patch.object(cloud_featherless.httpx, "Client", MockClient):
    listed = cloud_featherless.ADAPTER.list_models(api_key="fixture", base_url="https://example.invalid/v1")
check(set(listed.models) == {"Qwen/Qwen3-32B", "text-only"})
check(listed.capabilities["Qwen/Qwen3-32B"]["vision"]["supported"] is True)
check(listed.capabilities["text-only"]["vision"]["supported"] is False)
check("reasoning" not in listed.capabilities["Qwen/Qwen3-32B"])

MockClient.body = {"data": [
    {"id": "vendor/vision", "providers": [{"provider": "groq", "status": "live"}],
     "architecture": {"input_modalities": ["image", "text"], "output_modalities": ["text"]}},
    {"id": "vendor/text", "providers": [{"provider": "groq", "status": "live"}],
     "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]}},
]}
with patch.object(cloud_huggingface.httpx, "Client", MockClient):
    listed = cloud_huggingface.ADAPTER.list_models(api_key="fixture", base_url="https://example.invalid/v1")
check(listed.capabilities["vendor/vision"]["vision"]["supported"] is True)
check(listed.capabilities["vendor/text"]["vision"]["supported"] is False)


class SecretFailureClient(MockClient):
    def get(self, url, **kwargs):
        raise httpx.RequestError("request failed Authorization: Bearer sk-or-private", request=httpx.Request("GET", url))


with patch.object(cloud_openrouter.httpx, "Client", SecretFailureClient):
    listed = cloud_openrouter.ADAPTER.list_models(api_key="sk-or-private", base_url="https://example.invalid/v1")
check(listed.status == "unreachable" and listed.error == "RequestError")
check("private" not in listed.error)

# The shared guard is owned by orchestration. Its current behavior must fail
# closed until it can link exact native support to an authenticated catalogue.
for provider, model in (("groq", "qwen/qwen3-32b"), ("together", "future-model"),
                        ("featherless", "Qwen/Qwen3-32B")):
    try:
        ensure_cloud_reasoning_preflight(provider, model, "off", "off", {}, capability_verified=False)
    except CloudReasoningPreferenceUnavailable as exc:
        check(exc.providerAttempts == 0 and exc.generationAttempts == 0)
    else:
        raise AssertionError((provider, model, "unknown Off was silently accepted"))

print(f"PASS {checks} Cloud Router native controls, images, account catalogue, unknown-Off guards")
