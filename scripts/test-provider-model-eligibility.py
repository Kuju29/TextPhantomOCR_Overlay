"""Provider/model catalogue policy regression: only translation-compatible live models are selectable."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.ai.provider_bootstrap import ensure_provider_registry
from backend.ai.provider_registry import provider_registry
ensure_provider_registry()
from backend.ai.provider_resolution import (
    resolve_base_url, remember_model_rejection, remember_model_promotion,
    forget_model_capabilities,
)
from backend.ai.provider_contract import GenerationRequest, ProbeRequest, ProbeResponse
from backend.ai.clients.base import ChatResult
from backend.ai import resolve as resolve_service
from backend.ai.providers import (
    cloud_deepseek, cloud_featherless, cloud_gemini, cloud_groq,
    cloud_huggingface, cloud_openai, cloud_openrouter, cloud_together,
)

EXPECTED = {"gemini", "openai", "openrouter", "anthropic", "groq", "deepseek", "together", "huggingface", "featherless"}
registered = {spec.provider_id for spec in provider_registry if not spec.local}
assert EXPECTED <= registered, (EXPECTED - registered)
for provider in EXPECTED:
    spec = provider_registry.require(provider)
    assert callable(getattr(spec.adapter, "list_models", None)), provider
    assert callable(getattr(spec.adapter, "probe", None)), provider

# OpenAI: broad /models response must not expose non-chat modalities/tools.
openai_ids = cloud_openai.filter_model_items([
    {"id":"gpt-4o"}, {"id":"gpt-5.6-luna"}, {"id":"o4-mini"},
    {"id":"text-embedding-3-large"}, {"id":"gpt-image-1"}, {"id":"whisper-1"},
    {"id":"gpt-4o-realtime-preview"}, {"id":"computer-use-preview"},
])
assert openai_ids == ["gpt-4o", "gpt-5.6-luna", "o4-mini"], openai_ids

# OpenAI /models has no reasoning-control metadata. The selected-model probe
# must feature-detect the exact model rather than trusting a static name list.
_openai_probe_payloads = []
def _openai_selected_probe(request, **kwargs):
    extra = dict(kwargs.get("payload_extra") or {})
    _openai_probe_payloads.append(extra)
    if extra.get("reasoning_effort") in {"none", "low"}:
        return ProbeResponse(True, 200)
    return ProbeResponse(True, 200)
with patch.object(cloud_openai, "openai_chat_probe", _openai_selected_probe):
    future = cloud_openai.ADAPTER.probe(ProbeRequest(
        model="gpt-future-reasoner-snapshot", api_key="sk-fixture",
        base_url=cloud_openai.DEFAULT_BASE_URL, model_capabilities={},
    ))
assert future.ok is True
assert [item.get("reasoning_effort") for item in _openai_probe_payloads] == ["none", "low"], _openai_probe_payloads
assert future.capabilities["reasoning"]["control"] == "levels"
assert future.capabilities["reasoning"]["supported_efforts"] == ["none", "low"]

# A normal chat model that rejects reasoning_effort must remain usable and must
# not gain a fabricated Thinking control.
_openai_probe_payloads.clear()
def _openai_nonreasoning_probe(request, **kwargs):
    extra = dict(kwargs.get("payload_extra") or {})
    _openai_probe_payloads.append(extra)
    if extra.get("reasoning_effort") == "none":
        return ProbeResponse(False, 400, error="unsupported parameter")
    return ProbeResponse(True, 200)
with patch.object(cloud_openai, "openai_chat_probe", _openai_nonreasoning_probe):
    ordinary = cloud_openai.ADAPTER.probe(ProbeRequest(
        model="gpt-4o", api_key="sk-fixture", base_url=cloud_openai.DEFAULT_BASE_URL,
        model_capabilities={},
    ))
assert ordinary.ok is True and not ordinary.capabilities
assert _openai_probe_payloads == [
    {"max_completion_tokens": 256, "reasoning_effort": "none"},
    {"max_completion_tokens": 256},
], _openai_probe_payloads

# OpenRouter: account/plan + chat + text in/out are all required when published.
router = cloud_openrouter.filter_model_items([
    {"id":"ok", "available_on_current_plan":True, "type":"chat", "architecture":{"input_modalities":["text"], "output_modalities":["text"]}},
    {"id":"mandatory-reasoner", "available_on_current_plan":True, "type":"chat",
     "reasoning":{"mandatory":True,"supported_efforts":["low","high"]},
     "architecture":{"input_modalities":["text"], "output_modalities":["text"]}},
    {"id":"plan-blocked", "available_on_current_plan":False, "type":"chat"},
    {"id":"image-only", "type":"chat", "architecture":{"input_modalities":["image"], "output_modalities":["text"]}},
    {"id":"embed", "type":"embedding"},
])
assert [x["id"] for x in router] == ["ok", "mandatory-reasoner"], router
assert router[1]["reasoning"]["mandatory"] is True, "reasoning metadata must describe controls, never model eligibility"

optional_router_caps = cloud_openrouter.normalize_capabilities({
    "supported_parameters": ["reasoning"],
    "reasoning": {
        "mandatory": False, "default_enabled": True,
        "supported_efforts": ["max", "high", "low"], "default_effort": "high",
    },
})["reasoning"]
assert optional_router_caps["can_disable"] is True, optional_router_caps
assert optional_router_caps["supported_efforts"] == ["max", "high", "low"], optional_router_caps


# OpenRouter selected-model health probing must use only catalogue-proven
# reasoning controls. A generic `reasoning` parameter with no advertised effort
# vocabulary is not proof that `enabled:false` is valid for that exact model.
_probe_payloads = []
def _capture_probe(request, **kwargs):
    _probe_payloads.append(kwargs.get("payload_extra") or {})
    return ProbeResponse(True, 200)
with patch.object(cloud_openrouter, "openai_chat_probe", _capture_probe):
    cloud_openrouter.ADAPTER.probe(ProbeRequest(
        model="optional-reasoner", api_key="sk-or-fixture", base_url=cloud_openrouter.DEFAULT_BASE_URL,
        model_capabilities={"reasoning":{"supported":True,"mandatory":False,"control":"levels",
                                         "can_disable":True,"supported_efforts":["max","high","low"]}},
    ))
    cloud_openrouter.ADAPTER.probe(ProbeRequest(
        model="mandatory-reasoner", api_key="sk-or-fixture", base_url=cloud_openrouter.DEFAULT_BASE_URL,
        model_capabilities={"reasoning":{"supported":True,"mandatory":True,"supported_efforts":["low"]}},
    ))
assert _probe_payloads[0]["reasoning"] == {"effort": "none"}, _probe_payloads[0]
assert _probe_payloads[0]["max_completion_tokens"] == 2048
assert _probe_payloads[1]["reasoning"] == {"effort": "low"}, _probe_payloads[1]
assert _probe_payloads[1]["max_completion_tokens"] == 2048

# O-series-style catalogue metadata with `reasoning` but omitted efforts must
# defer to the provider rather than fabricate a toggle that can 400.
normalized = cloud_openrouter.normalize_capabilities({
    "id":"openai/o3", "supported_parameters":["reasoning"],
    "reasoning":{"mandatory":False},
})
assert normalized["reasoning"]["control"] == "provider", normalized

# Groq: active translation/chat candidates only; audio/safety/compound systems excluded.
assert cloud_groq.filter_model_items([
    {"id":"llama-3.3-70b-versatile", "active":True},
    {"id":"whisper-large-v3", "active":True},
    {"id":"meta-llama/llama-prompt-guard-2-86m", "active":True},
    {"id":"compound-beta", "active":True},
    {"id":"old-chat", "active":False},
]) == ["llama-3.3-70b-versatile"]

# Together: the provider publishes an explicit model type; only chat belongs here.
assert cloud_together.filter_model_items([
    {"id":"chat", "type":"chat"}, {"id":"embed", "type":"embedding"}, {"id":"image", "type":"image"},
]) == ["chat"]

# Hugging Face: text in/out plus at least one currently live routing provider.
hf = cloud_huggingface.filter_model_items([
    {"id":"live-chat", "architecture":{"input_modalities":["text"],"output_modalities":["text"]}, "providers":[{"status":"live"}]},
    {"id":"offline", "architecture":{"input_modalities":["text"],"output_modalities":["text"]}, "providers":[{"status":"error"}]},
    {"id":"image", "architecture":{"input_modalities":["image"],"output_modalities":["text"]}, "providers":[{"status":"live"}]},
    {"id":"no-routing-metadata", "architecture":{"input_modalities":["text"],"output_modalities":["text"]}},
])
assert hf == ["live-chat"], hf

# Hugging Face reasoning controls are selected-model/account capabilities. Probe
# the exact live route before exposing Thinking Off/On; accepting the request is
# only wire support, so runtime usage remains authoritative about compliance.
_hf_probe_payloads = []
def _hf_reasoning_probe(request, **kwargs):
    extra = dict(kwargs.get("payload_extra") or {})
    _hf_probe_payloads.append(extra)
    return ProbeResponse(True, 200)
with patch.object(cloud_huggingface, "openai_chat_probe", _hf_reasoning_probe):
    hf_reasoning = cloud_huggingface.ADAPTER.probe(ProbeRequest(
        model="deepseek-ai/DeepSeek-V4-Flash-0731", api_key="hf_fixture",
        base_url=cloud_huggingface.DEFAULT_BASE_URL, model_capabilities={},
    ))
assert hf_reasoning.ok is True
assert [row.get("reasoning_effort") for row in _hf_probe_payloads] == ["none"], _hf_probe_payloads
assert hf_reasoning.capabilities["reasoning"]["control"] == "levels"
assert hf_reasoning.capabilities["reasoning"]["supported_efforts"] == ["none"]

# A route that proves only native Off keeps the `none` mapping active while the
# popup correctly withholds an On toggle.
_hf_probe_payloads.clear()
def _hf_off_only_probe(request, **kwargs):
    extra = dict(kwargs.get("payload_extra") or {})
    _hf_probe_payloads.append(extra)
    if extra.get("reasoning_effort") == "low":
        return ProbeResponse(False, 400, error="unsupported effort")
    return ProbeResponse(True, 200)
with patch.object(cloud_huggingface, "openai_chat_probe", _hf_off_only_probe):
    hf_off_only = cloud_huggingface.ADAPTER.probe(ProbeRequest(
        model="off-only", api_key="hf_fixture", base_url=cloud_huggingface.DEFAULT_BASE_URL,
    ))
assert hf_off_only.ok is True
assert hf_off_only.capabilities["reasoning"]["control"] == "levels"
assert hf_off_only.capabilities["reasoning"]["supported_efforts"] == ["none"]

# Unsupported reasoning_effort must fall back to an ordinary tiny health probe,
# not hide an otherwise usable selected model.
_hf_probe_payloads.clear()
def _hf_plain_probe(request, **kwargs):
    extra = dict(kwargs.get("payload_extra") or {})
    _hf_probe_payloads.append(extra)
    if extra.get("reasoning_effort") == "none":
        return ProbeResponse(False, 400, error="unsupported parameter")
    return ProbeResponse(True, 200)
with patch.object(cloud_huggingface, "openai_chat_probe", _hf_plain_probe):
    hf_plain = cloud_huggingface.ADAPTER.probe(ProbeRequest(
        model="google/gemma-2-2b-it", api_key="hf_fixture",
        base_url=cloud_huggingface.DEFAULT_BASE_URL, model_capabilities={},
    ))
assert hf_plain.ok is True and not hf_plain.capabilities
assert _hf_probe_payloads == [
    {"max_tokens": 256, "reasoning_effort": "none"},
    {"max_tokens": 256},
], _hf_probe_payloads

_hf_generated_payloads = []
def _hf_execute(**kwargs):
    _hf_generated_payloads.append(dict(kwargs["payload"]))
    # Simulate an upstream that accepts `none` but still reports hidden tokens.
    return ChatResult("OK", kwargs["model"], thinking_tokens=64)
_hf_caps = {"reasoning": {"supported": True, "mandatory": False,
                           "control": "levels", "supported_efforts": ["none", "low"]}}
_hf_request = GenerationRequest(
    provider="huggingface", model="deepseek-ai/DeepSeek-V4-Flash-0731",
    system_text="system", user_parts=("hello",), api_key="hf_fixture",
    base_url=cloud_huggingface.DEFAULT_BASE_URL, thinking="off",
    expected_ids=("P0",), unit_count=1, model_capabilities=_hf_caps,
)
with patch.object(cloud_huggingface, "execute_huggingface_chat", _hf_execute):
    hf_off_result = cloud_huggingface.ADAPTER.generate(_hf_request)
assert _hf_generated_payloads[-1]["reasoning_effort"] == "none"
assert "temperature" not in _hf_generated_payloads[-1]
assert hf_off_result.thinking_applied == "provider_ignored_off"

from dataclasses import replace
with patch.object(cloud_huggingface, "execute_huggingface_chat", _hf_execute):
    hf_on_result = cloud_huggingface.ADAPTER.generate(replace(_hf_request, thinking="on"))
assert _hf_generated_payloads[-1]["reasoning_effort"] == "low"
assert "temperature" not in _hf_generated_payloads[-1]
assert hf_on_result.thinking_applied == "requested_on_effort_low"

# A route without verified selected-model capability must not receive a guessed
# reasoning field. Its normal sampling policy remains unchanged.
with patch.object(cloud_huggingface, "execute_huggingface_chat", _hf_execute):
    hf_unknown_result = cloud_huggingface.ADAPTER.generate(
        replace(_hf_request, model_capabilities={})
    )
assert "reasoning_effort" not in _hf_generated_payloads[-1]
assert _hf_generated_payloads[-1]["temperature"] == 0.7
assert hf_unknown_result.thinking_applied == "unverified"

# Featherless: query is plan-aware and the returned item must remain active/conversational/text.
assert dict(cloud_featherless.LIST_PARAMS)["available_on_current_plan"] == "true"
assert dict(cloud_featherless.LIST_PARAMS)["conversational"] == "true"
assert cloud_featherless.filter_model_items([
    {"id":"ok", "available_on_current_plan":True, "conversational":True, "status":"active", "input_modalities":["text"], "output_modalities":["text"]},
    {"id":"plan", "available_on_current_plan":False, "conversational":True, "status":"active"},
    {"id":"inactive", "conversational":True, "status":"disabled"},
    {"id":"not-chat", "conversational":False, "status":"active"},
]) == ["ok"]

# DeepSeek aliases are not shown as separate stale model IDs; actual current IDs survive.
assert cloud_deepseek.filter_model_items([
    {"id":"deepseek-chat"}, {"id":"deepseek-reasoner"},
    {"id":"deepseek-v4-flash"}, {"id":"deepseek-v4-pro"},
]) == ["deepseek-v4-flash", "deepseek-v4-pro"]

# Gemini native list: must support generateContent; embedding/image-only names are excluded.
class _Response:
    status_code = 200
    is_success = True
    text = ""
    def json(self):
        return {"models":[
            {"name":"models/gemini-2.5-flash", "supportedGenerationMethods":["generateContent"], "inputTokenLimit":1000, "outputTokenLimit":2000, "thinking":True},
            {"name":"models/gemini-2.5-pro", "supportedGenerationMethods":["generateContent"], "inputTokenLimit":1000, "outputTokenLimit":2000, "thinking":True},
            {"name":"models/text-embedding-004", "supportedGenerationMethods":["embedContent"]},
            {"name":"models/imagen-4", "supportedGenerationMethods":["generateContent"]},
        ]}
class _Client:
    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get(self, *a, **k): return _Response()
with patch.object(cloud_gemini.httpx, "Client", _Client):
    gem = cloud_gemini.models_status("AIza-fixture")
assert gem["status"] == "valid"
assert gem["models"] == ["gemini-2.5-flash", "gemini-2.5-pro"], gem
assert gem["capabilities"]["gemini-2.5-flash"]["reasoning"]["control"] == "levels"
assert gem["capabilities"]["gemini-2.5-pro"]["reasoning"]["mandatory"] is True
assert gem["capabilities"]["gemini-2.5-flash"]["reasoning"]["supported_efforts"] == ["none", "low", "medium", "high"]

# Named Cloud providers are endpoint-bound: stale OpenRouter URL may never receive an HF key.
assert resolve_base_url("huggingface", "https://openrouter.ai/api/v1") == "https://router.huggingface.co/v1"
assert resolve_base_url("deepseek", "https://openrouter.ai/api/v1") == "https://api.deepseek.com/v1"
# Unknown/custom identities retain an explicit endpoint instead of being silently rewritten.
assert resolve_base_url("customcloud", "https://gateway.example/v1") == "https://gateway.example/v1"

# Explicit missing model must not be silently replaced by the first live entry.
enum = {"models":["verified-a", "verified-b"], "source":"live", "verified":True,
        "status":"valid", "http_status":200, "error":"", "capabilities":{}}
with patch.object(resolve_service, "_enumerate_models_detailed", return_value=enum):
    missing = resolve_service.resolve({"provider":"openrouter", "api_key":"sk-or-fixture", "model":"not-there", "lang":"th"})
    assert missing["ok"] is False and missing["error"] == "model_unavailable"
    assert missing["model"] == "not-there"
    auto = resolve_service.resolve({"provider":"openrouter", "api_key":"sk-or-fixture", "model":"auto", "lang":"th"})
    assert auto["ok"] is True and auto["model"] in enum["models"]

# A deterministic selected-model generation failure outranks a still-present
# catalogue row for this exact provider/endpoint/account/model. This prevents a
# 400/403/404 model from reappearing after popup refresh. A later successful
# probe clears the negative evidence.
route_key = "sk-or-negative-evidence-fixture"
route_model = "openai/o3-fixture"
route_base = cloud_openrouter.DEFAULT_BASE_URL
route_enum = {
    "models": [route_model], "source": "live", "verified": True,
    "status": "valid", "http_status": 200, "error": "", "capabilities": {},
    "candidates": {route_model: {"eligibility": "usable", "evidence": "openrouter_account_models_user"}},
}
forget_model_capabilities("openrouter", route_base, route_key)
with patch.object(resolve_service, "_enumerate_models_detailed", return_value=route_enum):
    before = resolve_service.resolve({"provider":"openrouter", "api_key":route_key,
                                      "model":route_model, "lang":"th"})
    assert before["ok"] is True
    assert before["model_candidates"][0]["eligibility"] == "usable"

    remember_model_rejection("openrouter", route_base, route_key, route_model,
                             status="rejected", http_status=400,
                             error="reasoning parameter rejected")
    with patch("backend.trace.note") as trace_note:
        blocked = resolve_service.resolve({"provider":"openrouter", "api_key":route_key,
                                           "model":route_model, "lang":"th"})
    assert blocked["ok"] is False and blocked["error"] == "model_unavailable"
    assert blocked["model_status"] == "unavailable"
    assert blocked["model_candidates"][0]["eligibility"] == "blocked"
    assert blocked["model_candidates"][0]["probe_status"] == "rejected"
    assert blocked["model_candidates"][0]["probe_http_status"] == 400
    catalogue_events = [call for call in trace_note.call_args_list
                        if call.args and call.args[0] == "model_catalogue_completed"]
    assert len(catalogue_events) == 1, catalogue_events
    assert catalogue_events[0].args[1]["blockedCount"] == 1, catalogue_events[0]
    assert catalogue_events[0].args[1]["usableCount"] == 0, catalogue_events[0]

    remember_model_promotion("openrouter", route_base, route_key, route_model)
    recovered = resolve_service.resolve({"provider":"openrouter", "api_key":route_key,
                                         "model":route_model, "lang":"th"})
    assert recovered["ok"] is True
    assert recovered["model_candidates"][0]["eligibility"] == "usable"
forget_model_capabilities("openrouter", route_base, route_key)

print("Provider/model eligibility matrix passed: 9 cloud providers, route-scoped probe rejection/promotion, endpoint binding, no explicit remap.")
