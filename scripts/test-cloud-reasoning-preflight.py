"""Cloud reasoning intent and native wire boundaries; no live provider requests."""

from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import sys
from threading import Event
import time
import types
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

try:
    import httpx  # noqa: F401
except ModuleNotFoundError:
    fake_httpx = types.ModuleType("httpx")
    fake_httpx.RequestError = OSError
    fake_httpx.HTTPStatusError = OSError
    fake_httpx.Response = object
    fake_httpx.Client = object
    fake_httpx.Timeout = lambda **kw: kw
    fake_httpx.get = lambda *args, **kw: None
    sys.modules["httpx"] = fake_httpx

from backend.ai import markers
from backend.ai.clients.base import ChatResult
from backend.ai.cloud_reasoning import (
    CloudReasoningPreferenceUnavailable, ensure_cloud_reasoning_preflight,
    native_reasoning_capability, observed_off_status, PROVIDER_MANAGED_UNVERIFIED,
)
from backend.ai.provider_contract import GenerationRequest, ModelListResult
from backend.ai.provider_registry import provider_registry
from backend.ai.provider_resolution import (
    normalize_model_capabilities, discovered_model_capabilities,
    forget_model_capabilities, refresh_cloud_model_capabilities,
    remember_model_capabilities,
)
from backend.ai.providers import cloud_anthropic, cloud_gemini, cloud_openai, cloud_openrouter, cloud_paid, cloud_together
from backend.ai.reasoning_preference import (
    minimum_reasoning_preference, normalize_reasoning_preference, resolve_reasoning_preference,
)
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.invocation import _translate_once_impl
from backend.ai.translation import invocation


def check(provider, model, preference, cap, *, allowed, verified=True, fallback=False):
    native = native_reasoning_capability(provider, model)
    effective = native or cap
    selected = resolve_reasoning_preference(preference, effective)
    try:
        status = ensure_cloud_reasoning_preflight(provider, model, preference, selected, effective,
                                                  capability_verified=verified or bool(native))
    except CloudReasoningPreferenceUnavailable as error:
        assert not allowed, (provider, model, preference, str(error))
        assert error.code == ("ai_thinking_off_unavailable" if preference == "off"
                              else "ai_thinking_minimum_unavailable" if preference == "minimum"
                              else "ai_thinking_mode_unavailable")
        assert error.requestDispatched is False and error.providerAttempts == 0
        return
    assert allowed, (provider, model, preference, selected, effective)
    assert status == (PROVIDER_MANAGED_UNVERIFIED if fallback else None), (
        provider, model, preference, selected, status)


mandatory = {"supported": True, "mandatory": True, "control": "levels",
             "supported_efforts": ["low", "medium"]}
assert normalize_reasoning_preference("auto") == "minimum"
assert normalize_reasoning_preference("default") == "default"
unknown_off = {"supported": True, "control": "provider"}
optional = {"supported": True, "mandatory": False, "control": "levels",
            "supported_efforts": ["none", "low"]}
unranked_router = normalize_model_capabilities(cloud_openrouter.normalize_capabilities({
    "reasoning": {"supported": True, "mandatory": True,
                  "supported_efforts": ["nano", "low"], "supports_max_tokens": True},
}))["reasoning"]
assert unranked_router["supported_efforts"] == ["nano", "low"]
assert minimum_reasoning_preference(unranked_router) == "default"
assert resolve_reasoning_preference("minimum", unranked_router) == "default"
assert ensure_cloud_reasoning_preflight(
    "openrouter", "vendor/reasoner", "minimum", "low", unranked_router,
    capability_verified=True,
) == PROVIDER_MANAGED_UNVERIFIED, "a stale selected Low cannot bypass an unranked level"
assert ensure_cloud_reasoning_preflight(
    "openrouter", "vendor/reasoner", "minimum", "high",
    {"supported": True, "mandatory": True, "control": "levels",
     "supported_efforts": ["low", "high"]}, capability_verified=True,
) == PROVIDER_MANAGED_UNVERIFIED, "preflight must require the proven lowest level"
assert normalize_model_capabilities({"reasoning": {
    "supported": True, "mandatory": True, "control": "levels",
    "supported_efforts": ["low", "invalid effort"],
}})["reasoning"]["minimum_unresolved"] is True
assert normalize_model_capabilities({"reasoning": {
    "supported": True, "mandatory": True, "control": "levels",
    "supported_efforts": ["low", None],
}})["reasoning"]["minimum_unresolved"] is True
assert minimum_reasoning_preference({
    "supported": True, "mandatory": True, "control": "levels",
    "supported_efforts": ["low"], "minimum_unresolved": True,
}) == "default"
malformed_router = normalize_model_capabilities(cloud_openrouter.normalize_capabilities({
    "reasoning": {"supported": True, "mandatory": True,
                  "supported_efforts": ["n.ano", "low"]},
}))["reasoning"]
assert malformed_router["supported_efforts"] == ["low"]
assert malformed_router["minimum_unresolved"] is True
assert resolve_reasoning_preference("minimum", malformed_router) == "default"
assert ensure_cloud_reasoning_preflight(
    "openrouter", "vendor/reasoner", "minimum", "low", malformed_router,
    capability_verified=True,
) == PROVIDER_MANAGED_UNVERIFIED
optional_unranked_router = normalize_model_capabilities(cloud_openrouter.normalize_capabilities({
    "reasoning": {"supported": True, "mandatory": False,
                  "supported_efforts": ["nano", "low"]},
}))["reasoning"]
assert resolve_reasoning_preference("minimum", optional_unranked_router) == "off"
check("openrouter", "vendor/reasoner", "minimum", optional_unranked_router, allowed=True)
check("openrouter", "vendor/reasoner", "off", optional_unranked_router, allowed=True)
optional_malformed_router = normalize_model_capabilities(cloud_openrouter.normalize_capabilities({
    "reasoning": {"supported": True, "mandatory": False,
                  "supported_efforts": ["n.ano", "low"]},
}))["reasoning"]
assert optional_malformed_router["minimum_unresolved"] is True
assert resolve_reasoning_preference("minimum", optional_malformed_router) == "off"
check("openrouter", "vendor/reasoner", "off", optional_malformed_router, allowed=True)
for provider, model in (("openrouter", "vendor/reasoner"), ("openai", "gpt-5"),
                        ("deepseek", "deepseek-v4-flash"), ("huggingface", "vendor/reasoner"),
                        ("anthropic", "claude-fable-5"), ("gemini", "gemini-3.6-flash"),
                        ("groq", "reasoner"), ("together", "reasoner"),
                        ("featherless", "reasoner"), ("paid", "reasoner")):
    check(provider, model, "off", mandatory, allowed=False)
    check(provider, model, "off", unknown_off, allowed=False)
    check(provider, model, "off", {"supported": False},
          allowed=provider not in {"openai", "deepseek", "anthropic", "gemini"})

for provider, model in (("openrouter", "vendor/reasoner"), ("openai", "gpt-5.6-luna"),
                        ("deepseek", "deepseek-v4-flash"), ("huggingface", "vendor/reasoner"),
                        ("anthropic", "claude-sonnet-5"), ("gemini", "gemini-2.5-flash")):
    check(provider, model, "off", optional, allowed=True)
    check(provider, model, "minimum", optional, allowed=True)

for provider in ("groq", "together", "featherless", "paid"):
    check(provider, "reasoner", "off", optional, allowed=False)
    check(provider, "reasoner", "minimum", mandatory, allowed=True, fallback=True)

# An explicit named/On choice cannot silently become provider default on any
# Cloud route when the account has no verified control for the current model.
cloud_providers = ("gemini", "openai", "openrouter", "anthropic", "groq",
                   "deepseek", "together", "huggingface", "featherless")
for provider in cloud_providers:
    for preference in ("low", "on"):
        check(provider, "future-model", preference, {}, allowed=False)
        check(provider, "future-model", preference, {"supported": False}, allowed=False)
        check(provider, "future-model", preference, mandatory, allowed=False, verified=False)
check("openrouter", "vendor/reasoner", "high", mandatory, allowed=False)
check("openrouter", "vendor/reasoner", "on", mandatory, allowed=False)
check("featherless", "future-model", "low", mandatory, allowed=False)

verified_explicit_cases = (
    ("openrouter", "vendor/reasoner", "low", mandatory),
    ("openai", "gpt-5.6-luna", "low", mandatory),
    ("deepseek", "deepseek-flash", "low", optional),
    ("huggingface", "vendor/reasoner", "low", optional),
    ("anthropic", "claude-fable-5", "low", {}),
    ("gemini", "gemini-2.5-flash", "low", {}),
    ("groq", "qwen/qwen3.8-27b", "low", {}),
    ("together", "openai/gpt-oss-120b", "low", {}),
    ("together", "Qwen/Qwen3.5-9B", "on", {}),
)
for provider, model, preference, cap in verified_explicit_cases:
    check(provider, model, preference, cap, allowed=True)

# An exact provider leaf with a documented wire control can establish native
# support without claiming the same control for every OpenAI-shaped model.
for provider, optional_model, mandatory_model in (
    ("groq", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"),
    ("together", "Qwen/Qwen3.5-9B", "openai/gpt-oss-120b"),
):
    check(provider, optional_model, "off", {}, allowed=True, verified=False)
    check(provider, optional_model, "minimum", {}, allowed=True, verified=False)
    check(provider, mandatory_model, "off", {}, allowed=False, verified=False)
    check(provider, mandatory_model, "minimum", {}, allowed=True, verified=False)
for ambiguous_groq in ("qwen/qwen3-32b", "qwen/qwen3.6-27b"):
    check("groq", ambiguous_groq, "off", {}, allowed=False, verified=False)

check("openrouter", "vendor/reasoner", "off",
      {"supported": True, "mandatory": False, "control": "provider"}, allowed=True)
check("openrouter", "vendor/reasoner", "minimum", mandatory, allowed=True)
check("openai", "gpt-5.6-luna", "minimum", mandatory, allowed=True)
check("anthropic", "claude-fable-5", "minimum", {}, allowed=True)
check("gemini", "gemini-3.6-flash", "minimum", {}, allowed=True)
check("gemini", "gemini-3-future", "minimum", {}, allowed=True, fallback=True)
for undocumented in ("gemini-2.5-flash-future", "gemini-2.5-flash-lite-future"):
    check("gemini", undocumented, "off", {}, allowed=False, verified=False)
    check("gemini", undocumented, "minimum", {}, allowed=True, verified=False, fallback=True)
check("deepseek", "deepseek-v4-flash", "off", {}, allowed=False)
for provider in ("openrouter", "openai", "deepseek", "huggingface", "anthropic", "gemini"):
    check(provider, "future-model", "off", {}, allowed=False)
    check(provider, "future-model", "minimum", {}, allowed=True, fallback=True)
    check(provider, "future-model", "off", {"supported": False}, allowed=True)
    check(provider, "future-model", "minimum", {"supported": False}, allowed=True)
    check(provider, "future-model", "off", {"supported": False},
          allowed=False, verified=False)
    check(provider, "future-model", "minimum", optional,
          allowed=True, verified=False, fallback=True)
for provider in ("groq", "together", "featherless", "paid"):
    check(provider, "future-model", "minimum", {}, allowed=True, fallback=True)
    check(provider, "future-model", "minimum", {"supported": False}, allowed=True)

# Provider default remains an internal wire mode. Pure preflight reports an
# unverified marker; translation must reject that marker before dispatch.
ensure_cloud_reasoning_preflight("openrouter", "vendor/reasoner", "default", "default", {},
                                 capability_verified=False)


def translate(provider, model, thinking, cap, *, fresh=True):
    ai = AiConfig(api_key="test-api-key", provider=provider, model=model,
                  thinking=thinking, prompt_mode="replace", prompt_editable="Translate.",
                  model_capabilities={"reasoning": cap})
    adapter = provider_registry.require(provider).adapter
    with patch("backend.ai.provider_resolution.discovered_model_capabilities",
               return_value=(fresh, {"reasoning": cap} if fresh else {})), \
         patch.object(invocation, "assert_ai_base_url_allowed"), \
         patch.object(adapter, "generate") as generate:
        try:
            _translate_once_impl(markers.apply(["source"]), "th", ai)
        except CloudReasoningPreferenceUnavailable as error:
            assert generate.call_count == 0, (provider, model, thinking)
            return error
    raise AssertionError(f"{provider}/{model} {thinking}: request unexpectedly dispatched")


for provider, model, preference, cap in (
    ("openrouter", "vendor/reasoner", "off", mandatory),
    ("openrouter", "vendor/reasoner", "off", unknown_off),
    ("openai", "gpt-5", "off", {"supported": True, "control": "provider"}),
    ("deepseek", "deepseek-v4-flash", "off", {}),
    ("huggingface", "vendor/reasoner", "off", unknown_off),
    ("gemini", "gemini-2.5-pro", "off", optional),
    ("gemini", "gemini-2.5-pro", "off", {"supported": False}),
    ("anthropic", "claude-fable-5", "off", optional),
    ("anthropic", "claude-fable-5", "off", {"supported": False}),
    ("together", "reasoner", "off", optional),
    ("openrouter", "future-model", "off", {}),
):
    assert translate(provider, model, preference, cap).requestDispatched is False

for provider in cloud_providers:
    for preference in ("low", "on"):
        error = translate(provider, "future-model", preference, {})
        assert error.code == "ai_thinking_mode_unavailable"
        assert error.requestDispatched is False and error.providerAttempts == 0
assert translate("openrouter", "vendor/reasoner", "high", mandatory).code == "ai_thinking_mode_unavailable"


for provider, model, preference, cap, expected, active in (
    ("openrouter", "vendor/reasoner", "minimum", mandatory, "low", True),
    ("anthropic", "claude-fable-5", "minimum", {"supported": False}, "low", True),
    ("gemini", "gemini-3.6-flash", "minimum", {"supported": False}, "minimal", True),
    ("groq", "plain-model", "minimum", {"supported": False}, "default", False),
    ("together", "unknown-model", "default", {}, "default", False),
):
    ai = AiConfig(api_key="fixture", provider=provider, model=model,
                  thinking=preference, prompt_mode="replace", prompt_editable="Translate.",
                  model_capabilities={"reasoning": cap})
    with patch("backend.ai.provider_resolution.discovered_model_capabilities",
               return_value=(True, {"reasoning": cap})), \
         patch.object(invocation, "assert_ai_base_url_allowed"), \
         patch("backend.ai.accounting.generate_with_receipt",
               return_value=ChatResult("translated", model, thinking_applied=f"requested_effort_{expected}")) as generation, \
         patch.object(invocation, "decode_result", return_value={"meta": {"prompt_audit": {}}}), \
         patch.object(invocation.trace_preview, "note") as diagnostic:
        _translate_once_impl(markers.apply(["source"]), "th", ai)
    assert generation.call_count == 1
    assert generation.call_args.args[1].thinking == expected
    trace_fields = [c.args[1] for c in diagnostic.call_args_list
                    if c.args[0] == "AI diagnostic reasoning policy resolved"]
    assert len(trace_fields) == 1
    assert trace_fields[0]["selectedMode"] == expected
    assert trace_fields[0]["lowestResolvedToActiveReasoning"] is active


for provider, model, preference, cap in verified_explicit_cases:
    ai = AiConfig(api_key="fixture", provider=provider, model=model,
                  thinking=preference, prompt_mode="replace", prompt_editable="Translate.",
                  model_capabilities={"reasoning": cap})
    with patch("backend.ai.provider_resolution.discovered_model_capabilities",
               return_value=(True, {"reasoning": cap})), \
         patch.object(invocation, "assert_ai_base_url_allowed"), \
         patch("backend.ai.accounting.generate_with_receipt",
               return_value=ChatResult("translated", model,
                                       thinking_applied=f"requested_{preference}")) as generation, \
         patch.object(invocation, "decode_result", return_value={"meta": {"prompt_audit": {}}}), \
         patch.object(invocation.trace_preview, "note") as diagnostic:
        _translate_once_impl(markers.apply(["source"]), "th", ai)
    assert generation.call_count == 1
    assert generation.call_args.args[1].thinking == preference
    fields = [c.args[1] for c in diagnostic.call_args_list
              if c.args[0] == "AI diagnostic reasoning policy resolved"]
    assert len(fields) == 1 and fields[0]["selectedMode"] == preference
    assert fields[0]["overrideReason"] == "none"


# An unproved Lowest must fail before generation, even when a saved browser
# catalogue suggests Off. Do not bill a provider-default reasoning request.
for provider, model, cap, fresh in (
    ("featherless", "Qwen/Qwen2.5-7B-Instruct", {}, True),
    ("huggingface", "vendor/reasoner", optional, False),
    ("openrouter", "vendor/reasoner", optional, False),
    ("openrouter", "vendor/reasoner", unranked_router, True),
    ("openrouter", "vendor/reasoner", malformed_router, True),
):
    ai = AiConfig(api_key="fixture", provider=provider, model=model,
                  thinking="minimum", prompt_mode="replace", prompt_editable="Translate.",
                  model_capabilities={"reasoning": cap})
    with patch("backend.ai.provider_resolution.discovered_model_capabilities",
               return_value=(fresh, {"reasoning": cap} if fresh else {})), \
         patch("backend.ai.provider_resolution.refresh_cloud_model_capabilities",
               return_value=(False, {})), \
         patch.object(invocation, "assert_ai_base_url_allowed"), \
         patch("backend.ai.accounting.generate_with_receipt",
               return_value=ChatResult("translated", model)) as generation:
        try:
            _translate_once_impl(markers.apply(["source"]), "th", ai)
        except CloudReasoningPreferenceUnavailable as error:
            assert error.code == "ai_thinking_minimum_unavailable"
            assert error.requestDispatched is False and error.providerAttempts == 0
        else:
            raise AssertionError(f"{provider}/{model}: unproved Lowest dispatched")
    assert generation.call_count == 0


assert cloud_openrouter.prepare_payload(GenerationRequest(
    provider="openrouter", model="vendor/reasoner", thinking="off",
    system_text="s", user_parts=("u",), model_capabilities={"reasoning": optional},
))["reasoning"] == {"effort": "none"}
fallback_router = GenerationRequest(
    provider="openrouter", model="vendor/reasoner", thinking="default",
    system_text="s", user_parts=("u",),
    model_capabilities={"reasoning": {"supported": True, "control": "provider",
                                      "default_enabled": True, "supports_max_tokens": True}},
    cache_context={"thinkingRequested": "minimum"},
)
assert "reasoning" not in cloud_openrouter.prepare_payload(fallback_router)
assert "reasoning" not in cloud_openrouter.prepare_payload(GenerationRequest(
    provider="openrouter", model="vendor/reasoner", thinking="default",
    system_text="s", user_parts=("u",),
    model_capabilities={"reasoning": unranked_router},
    cache_context={"thinkingRequested": "minimum"},
))
assert cloud_openrouter.prepare_payload(GenerationRequest(
    provider="openrouter", model="vendor/reasoner", thinking="default",
    system_text="s", user_parts=("u",), model_capabilities=fallback_router.model_capabilities,
    cache_context={"thinkingRequested": "default"},
))["reasoning"]["max_tokens"] > 0
assert cloud_openai.prepare_payload(GenerationRequest(
    provider="openai", model="gpt-5.6-luna", thinking="off",
    system_text="s", user_parts=("u",), model_capabilities={"reasoning": optional},
))["reasoning_effort"] == "none"
assert cloud_gemini._thinking_state("gemini-2.5-flash", "off")[1] == {"thinkingBudget": 0}

router_request = GenerationRequest(
    provider="openrouter", model="vendor/reasoner", api_key="fixture",
    base_url="https://openrouter.ai/api/v1", thinking="off",
    system_text="s", user_parts=("u",), model_capabilities={"reasoning": optional},
)
for observed, expected in ((4, "provider_ignored_off"),
                           (0, "requested_off_observed_zero_reasoning"),
                           (None, "requested_off_unverified_effect")):
    with patch.object(cloud_openrouter, "execute_openrouter_chat",
                      return_value=ChatResult("translated", "vendor/reasoner",
                                              thinking_tokens=observed)) as wire:
        result = cloud_openrouter.ADAPTER.generate(router_request)
    assert wire.call_count == 1
    assert wire.call_args.kwargs["payload"]["reasoning"] == {"effort": "none"}
    assert result.thinking_applied == expected, (observed, result.thinking_applied)

together_on_cap = native_reasoning_capability("together", "Qwen/Qwen3.5-9B")
together_on = GenerationRequest(
    provider="together", model="Qwen/Qwen3.5-9B", thinking="on",
    system_text="s", user_parts=("u",), model_capabilities={"reasoning": together_on_cap},
)
with patch.object(cloud_together, "execute_chat_completion",
                  return_value=ChatResult("translated", "Qwen/Qwen3.5-9B")) as wire:
    cloud_together.ADAPTER.generate(together_on)
assert wire.call_count == 1
assert wire.call_args.kwargs["payload"]["reasoning"] == {"enabled": True}

# A streamed reasoning_content delta is evidence even when the upstream omits
# reasoning_tokens, or reports an inconsistent zero in usage.
for reported in (None, 0):
    contradicted = ChatResult("translated", "vendor/reasoner",
                             thinking_tokens=reported, reasoning_observed=True)
    assert observed_off_status(contradicted) == "provider_ignored_off"
    with patch.object(cloud_openrouter, "execute_openrouter_chat", return_value=contradicted):
        assert cloud_openrouter.ADAPTER.generate(router_request).thinking_applied == "provider_ignored_off"


class AnthropicResponse:
    status_code = 200
    is_success = True
    extensions = {}

    def json(self):
        return {"content": [{"type": "text", "text": "<<TP_P0:translated>>"}],
                "stop_reason": "end_turn", "usage": {"input_tokens": 23, "output_tokens": 7}}

    def raise_for_status(self):
        return None


for model, selected, wire, report in (
    ("claude-sonnet-5", "off", {"type": "disabled"}, "requested_off_unverified_effect"),
    ("claude-fable-5", "low", {"type": "adaptive"}, "requested_effort_low"),
):
    captured = []
    def post(*args, **kwargs):
        captured.append(kwargs["json"])
        return AnthropicResponse()
    with patch.object(cloud_anthropic, "post_json", side_effect=post), \
         patch.object(cloud_anthropic.content_stream, "active", return_value=False):
        result = cloud_anthropic.generate("fixture", model, "system", ["<<TP_P0:source>>"],
            thinking=selected, model_capabilities={"reasoning": native_reasoning_capability("anthropic", model)})
    assert isinstance(result, ChatResult)
    assert len(captured) == 1 and captured[0]["thinking"] == wire
    assert result.thinking_applied == report


# Import only the public error mapper with a minimal framework exception in
# extension-only environments. This verifies the stable error code and zero
# dispatch counters without requiring the API deployment venv.
try:
    from fastapi import HTTPException
except ModuleNotFoundError:
    framework = types.ModuleType("fastapi")
    class HTTPException(Exception):
        def __init__(self, status_code, detail, headers=None):
            self.status_code = status_code
            self.detail = detail
            self.headers = headers
    framework.HTTPException = HTTPException
    framework.Request = object
    sys.modules["fastapi"] = framework

from backend.application.ai_translation import provider_errors

ctx = SimpleNamespace(unit_count=1, trace_id="fixture", correlation={},
                      route_identity={}, requested_route="/fixture")
with patch.object(provider_errors, "trace_failure"), patch.object(provider_errors, "failure_event"):
    try:
        provider_errors.raise_execution_error(ctx, translate("openrouter", "vendor/reasoner", "off", mandatory),
            rate_wait_ms=0, admission_wait_ms=0, provider_ms=0)
    except HTTPException as error:
        assert error.status_code == 409
        assert error.detail["code"] == "ai_thinking_off_unavailable"
        assert error.detail["requestDispatched"] is False
        assert error.detail["providerAttempts"] == error.detail["generationAttempts"] == 0
        assert "Lowest available" in error.detail["userMessage"]
    else:
        raise AssertionError("Expected public reasoning preflight rejection")

for preference in ("low", "on"):
    with patch.object(provider_errors, "trace_failure") as failure_trace, \
         patch.object(provider_errors, "failure_event"):
        try:
            provider_errors.raise_execution_error(
                ctx, translate("openrouter", "future-model", preference, {}),
                rate_wait_ms=0, admission_wait_ms=0, provider_ms=0,
            )
        except HTTPException as error:
            assert error.status_code == 409
            assert error.detail["code"] == "ai_thinking_mode_unavailable"
            assert error.detail["requestDispatched"] is False
            assert error.detail["providerAttempts"] == error.detail["generationAttempts"] == 0
            assert preference in error.detail["userMessage"]
            assert "ต่ำสุด" not in error.detail["userMessage"]
            assert failure_trace.call_args.args[1] == "ai_reasoning_preflight"
        else:
            raise AssertionError(f"Expected public Thinking {preference} preflight rejection")


# `.27.13` had a warm account catalogue and sent OpenRouter effort:none.
# `.27.17` started translation before discovery and sent provider default.
# A cold request must now load exact account/model facts before generation.
router = provider_registry.require("openrouter")
router_model = "deepseek/deepseek-v4-flash-0731"
router_key = "fixture-cloud-refresh-key"
router_base = router.default_base_url
router_ai = AiConfig(api_key=router_key, provider="openrouter", model=router_model,
                     thinking="minimum", prompt_mode="replace", prompt_editable="Translate.",
                     model_capabilities={"reasoning": optional})
router_list = ModelListResult(models=(router_model,), status="valid",
                              capabilities={router_model: {"reasoning": optional}})
forget_model_capabilities("openrouter", router_base, router_key)
with patch.object(router.adapter, "list_models", return_value=router_list) as listed, \
     patch.object(invocation, "assert_ai_base_url_allowed"), \
     patch("backend.ai.accounting.generate_with_receipt",
           return_value=ChatResult("translated", router_model)) as generated, \
     patch.object(invocation, "decode_result", return_value={"meta": {"prompt_audit": {}}}):
    _translate_once_impl(markers.apply(["source"]), "th", router_ai)
assert listed.call_count == 1
assert listed.call_args.kwargs == {"api_key": router_key, "base_url": router_base}
assert generated.call_count == 1
assert generated.call_args.args[1].thinking == "off"
assert cloud_openrouter.prepare_payload(generated.call_args.args[1])["reasoning"] == {"effort": "none"}

# A second request reuses the account-scoped catalogue and sends no GET.
with patch.object(router.adapter, "list_models") as listed, \
     patch.object(invocation, "assert_ai_base_url_allowed"), \
     patch("backend.ai.accounting.generate_with_receipt",
           return_value=ChatResult("translated", router_model)) as generated, \
     patch.object(invocation, "decode_result", return_value={"meta": {"prompt_audit": {}}}):
    _translate_once_impl(markers.apply(["source"]), "th", router_ai)
assert listed.call_count == 0 and generated.call_count == 1
assert generated.call_args.args[1].thinking == "off"

# A valid catalogue without this exact model and an unavailable catalogue
# cannot inherit a browser's saved optional-reasoning hint.
for listed_result in (
    ModelListResult(models=("other/model",), status="valid",
                    capabilities={"other/model": {"reasoning": optional}}),
    ModelListResult(status="unreachable"),
):
    forget_model_capabilities("openrouter", router_base, router_key)
    with patch.object(router.adapter, "list_models", return_value=listed_result) as listed, \
         patch.object(invocation, "assert_ai_base_url_allowed"), \
         patch("backend.ai.accounting.generate_with_receipt") as generated:
        try:
            _translate_once_impl(markers.apply(["source"]), "th", router_ai)
        except CloudReasoningPreferenceUnavailable as error:
            assert error.code == "ai_thinking_minimum_unavailable"
            assert error.requestDispatched is False and error.providerAttempts == 0
        else:
            raise AssertionError("Unproved Lowest reached generation")
    assert listed.call_count == 1 and generated.call_count == 0

# An unexpected catalogue exception is also a structured pre-dispatch error.
forget_model_capabilities("openrouter", router_base, router_key)
with patch.object(router.adapter, "list_models", side_effect=RuntimeError("fixture unavailable")), \
     patch.object(invocation, "assert_ai_base_url_allowed"), \
     patch("backend.ai.accounting.generate_with_receipt") as generated:
    try:
        _translate_once_impl(markers.apply(["source"]), "th", router_ai)
    except CloudReasoningPreferenceUnavailable as error:
        assert error.code == "ai_thinking_minimum_unavailable"
        assert error.requestDispatched is False
    else:
        raise AssertionError("An unavailable catalogue reached generation")
assert generated.call_count == 0

# Every named Cloud adapter uses its own read-only model-list contract and
# cache scope. No translation or provider generation call is made here.
for provider in cloud_providers:
    spec = provider_registry.require(provider)
    key = "fixture-" + provider
    model = "future-model"
    forget_model_capabilities(provider, spec.default_base_url, key)
    with patch.object(spec.adapter, "list_models", return_value=ModelListResult(
            models=(model,), status="valid", capabilities={model: {"reasoning": optional}})) as listed:
        fresh, caps = refresh_cloud_model_capabilities(provider, spec.default_base_url, model, key)
        assert fresh and caps["reasoning"]["supported"] is True
        assert listed.call_count == 1
        assert discovered_model_capabilities(provider, spec.default_base_url, model, key)[0]

# Concurrent cold requests for one credential and endpoint share one model GET.
forget_model_capabilities("openrouter", router_base, router_key)
entered, release, follower_started = Event(), Event(), Event()
def blocking_models(*, api_key, base_url):
    assert (api_key, base_url) == (router_key, router_base)
    entered.set()
    assert release.wait(2)
    return router_list
def follower():
    follower_started.set()
    return refresh_cloud_model_capabilities("openrouter", router_base, router_model, router_key)
with patch.object(router.adapter, "list_models", side_effect=blocking_models) as listed, \
     ThreadPoolExecutor(max_workers=2) as pool:
    first = pool.submit(refresh_cloud_model_capabilities,
                        "openrouter", router_base, router_model, router_key)
    assert entered.wait(2)
    second = pool.submit(follower)
    assert follower_started.wait(2)
    time.sleep(.02)
    assert listed.call_count == 1
    release.set()
    assert first.result(timeout=2) == second.result(timeout=2)
assert listed.call_count == 1

# A second API key and endpoint cannot inherit this account's proof.
for key, base in ((router_key + "-other", router_base),
                  (router_key, router_base + "/other")):
    with patch.object(router.adapter, "list_models", return_value=router_list) as listed:
        assert refresh_cloud_model_capabilities("openrouter", base, router_model, key)[0]
    assert listed.call_count == 1

# Native exact-family facts need no catalogue request, even on a cold server.
for provider, model, preference, selected in (
    ("gemini", "gemini-2.5-flash", "minimum", "off"),
    ("anthropic", "claude-sonnet-5", "off", "off"),
):
    spec = provider_registry.require(provider)
    ai = AiConfig(api_key="fixture-native-" + provider, provider=provider,
                  model=model, thinking=preference, prompt_mode="replace",
                  prompt_editable="Translate.")
    forget_model_capabilities(provider, spec.default_base_url, ai.api_key)
    with patch.object(spec.adapter, "list_models") as listed, \
         patch.object(invocation, "assert_ai_base_url_allowed"), \
         patch("backend.ai.accounting.generate_with_receipt",
               return_value=ChatResult("translated", model)) as generated, \
         patch.object(invocation, "decode_result", return_value={"meta": {"prompt_audit": {}}}):
        _translate_once_impl(markers.apply(["source"]), "th", ai)
    assert listed.call_count == 0 and generated.call_count == 1
    assert generated.call_args.args[1].thinking == selected

# The Center-owned Paid route is not one of the nine manual Cloud choices;
# its existing Lowest contract remains unchanged by this metadata repair.
if provider_registry.get("paid") is None:
    provider_registry.register(cloud_paid.SPEC)
paid = provider_registry.require("paid")
paid_ai = AiConfig(api_key="fixture-paid-session", provider="paid", model="fixture-model",
                   thinking="minimum", prompt_mode="replace", prompt_editable="Translate.",
                   model_capabilities={"reasoning": optional})
with patch("backend.ai.provider_resolution.discovered_model_capabilities",
           return_value=(False, {})), \
     patch.object(paid.adapter, "list_models") as listed, \
     patch.object(invocation, "assert_ai_base_url_allowed"), \
     patch("backend.ai.accounting.generate_with_receipt",
           return_value=ChatResult("translated", "fixture-model")) as generated, \
     patch.object(invocation, "decode_result", return_value={"meta": {"prompt_audit": {}}}):
    _translate_once_impl(markers.apply(["source"]), "th", paid_ai)
assert listed.call_count == 0 and generated.call_count == 1
assert generated.call_args.args[1].thinking == "default"

print("PASS Cloud Thinking preflight and account-scoped refresh: 9 Cloud providers, cold/warm/concurrent and public 409; no live API calls")
