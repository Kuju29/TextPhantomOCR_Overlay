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
from backend.ai.provider_resolution import resolve_base_url
from backend.ai.provider_contract import ProbeRequest, ProbeResponse
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

# OpenRouter: account/plan + chat + text in/out are all required when published.
router = cloud_openrouter.filter_model_items([
    {"id":"ok", "available_on_current_plan":True, "type":"chat", "architecture":{"input_modalities":["text"], "output_modalities":["text"]}},
    {"id":"plan-blocked", "available_on_current_plan":False, "type":"chat"},
    {"id":"image-only", "type":"chat", "architecture":{"input_modalities":["image"], "output_modalities":["text"]}},
    {"id":"embed", "type":"embedding"},
])
assert [x["id"] for x in router] == ["ok"]

# OpenRouter selected-model probe follows the account catalogue's reasoning
# capability. Optional reasoning is explicitly disabled so a tiny health probe
# cannot be consumed entirely by hidden reasoning. Mandatory models use the
# smallest verified bounded control instead of pretending Thinking Off exists.
_probe_payloads = []
def _capture_probe(request, **kwargs):
    _probe_payloads.append(kwargs.get("payload_extra") or {})
    return ProbeResponse(True, 200)
with patch.object(cloud_openrouter, "openai_chat_probe", _capture_probe):
    cloud_openrouter.ADAPTER.probe(ProbeRequest(
        model="optional-reasoner", api_key="sk-or-fixture", base_url=cloud_openrouter.DEFAULT_BASE_URL,
        model_capabilities={"reasoning":{"supported":True,"mandatory":False,"control":"toggle"}},
    ))
    cloud_openrouter.ADAPTER.probe(ProbeRequest(
        model="mandatory-reasoner", api_key="sk-or-fixture", base_url=cloud_openrouter.DEFAULT_BASE_URL,
        model_capabilities={"reasoning":{"supported":True,"mandatory":True,"supported_efforts":["low"]}},
    ))
assert _probe_payloads[0]["reasoning"] == {"enabled": False}, _probe_payloads[0]
assert _probe_payloads[1]["reasoning"] == {"effort": "low"}, _probe_payloads[1]
assert _probe_payloads[1]["max_completion_tokens"] == 512

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
assert gem["models"] == ["gemini-2.5-flash"], gem
assert gem["capabilities"]["gemini-2.5-flash"]["reasoning"]["control"] == "toggle"

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

print("Provider/model eligibility matrix passed: 9 cloud providers, live-compatible lists, endpoint binding, no explicit remap.")
