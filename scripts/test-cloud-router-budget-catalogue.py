"""Mock five Cloud routers' selected-model ceilings, with no paid generation."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from backend.ai.providers import (
    cloud_featherless, cloud_groq, cloud_huggingface, cloud_openrouter, cloud_together,
)
from backend.ai.workload import guard_output_budget


class Catalogue:
    def __init__(self, body, *, plan=None, plan_status=200):
        self.body = body
        self.plan = plan
        self.plan_status = plan_status
        self.calls = []

    def __call__(self, *args, **kwargs):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        body = self.plan if url.endswith("/plan") else self.body
        status = self.plan_status if url.endswith("/plan") else 200
        return httpx.Response(status, json=body, request=httpx.Request("GET", url))


groq = Catalogue({"data": [
    {"id": "qwen/qwen3.8-27b", "active": True,
     "context_window": 131072, "max_completion_tokens": 65536},
    {"id": "future", "active": True, "context_window": "131072"},
    {"id": "duplicate", "context_window": 20000},
    {"id": "duplicate", "context_window": 1000},
]})
with patch.object(cloud_groq.httpx, "Client", groq):
    listed = cloud_groq.ADAPTER.list_models(api_key="fixture", base_url=cloud_groq.DEFAULT_BASE_URL)
assert listed.capabilities["qwen/qwen3.8-27b"]["limits"]["contextTokens"] == 131072
assert listed.capabilities["qwen/qwen3.8-27b"]["limits"]["maxOutputTokens"] == 65536
assert "limits" not in listed.capabilities.get("future", {})
assert "limits" not in listed.capabilities.get("duplicate", {})
assert len(groq.calls) == 1

together = Catalogue({"data": [
    {"id": "Qwen/Qwen3.5-9B", "type": "chat", "context_length": 32768,
     "max_output_tokens": 8192},
    {"id": "private-chat", "type": "chat", "context_length": 131072},
    {"id": "embed", "type": "embedding", "context_length": 2048},
]})
with patch.object(cloud_together.httpx, "Client", together):
    listed = cloud_together.ADAPTER.list_models(api_key="fixture", base_url=cloud_together.DEFAULT_BASE_URL)
assert listed.capabilities["Qwen/Qwen3.5-9B"]["limits"]["contextTokens"] == 32768
assert listed.capabilities["Qwen/Qwen3.5-9B"]["limits"]["maxOutputTokens"] == 8192
assert "maxOutputTokens" not in listed.capabilities["private-chat"]["limits"]
assert "embed" not in listed.models and len(together.calls) == 1

openrouter = Catalogue({"data": [
    {"id": "vendor/selected", "type": "chat", "context_length": 32768,
     "top_provider": {"max_completion_tokens": 2048},
     "per_request_limits": {"prompt_tokens": 30000, "completion_tokens": 10000}},
    {"id": "vendor/unpinned", "type": "chat", "top_provider": {"max_completion_tokens": 512}},
    {"id": "vendor/duplicate", "type": "chat", "context_length": 32768},
    {"id": "vendor/duplicate", "type": "chat", "context_length": 4096,
     "reasoning": {"supported": True, "mandatory": False},
     "architecture": {"input_modalities": ["text", "image"]}},
]})
with patch.object(cloud_openrouter.httpx, "Client", openrouter):
    listed = cloud_openrouter.ADAPTER.list_models(api_key="fixture", base_url=cloud_openrouter.DEFAULT_BASE_URL)
limit = listed.capabilities["vendor/selected"]["limits"]
assert limit["contextTokens"] == 32768
assert limit["maxInputTokens"] == 30000 and limit["maxOutputTokens"] == 10000
assert "outputHintTokens" not in limit
assert "limits" not in listed.capabilities["vendor/unpinned"]
assert "limits" not in listed.capabilities["vendor/duplicate"]
assert listed.capabilities["vendor/duplicate"] == {}, "ambiguous rows cannot prove Thinking or vision"
assert len(openrouter.calls) == 1 and openrouter.calls[0][0].endswith("/models/user")
budget = guard_output_budget(8000, workload={"version": 1, "predictedOutput": 3000},
    limits=limit, system="translate", parts=("<<TP_I1_P0:hello>>",))
assert budget == 8000, budget  # top provider's 2K was only a routing hint

# On Featherless the model maximum can exceed this API key's /plan context.
featherless = Catalogue({"data": [
    {"id": "vendor/large", "available_on_current_plan": True, "conversational": True,
     "context_length": 131072, "max_completion_tokens": 65536},
    {"id": "vendor/small", "available_on_current_plan": True, "conversational": True,
     "context_length": 8192, "max_completion_tokens": 4096},
]}, plan={"max_context_length": 32768})
with patch.object(cloud_featherless.httpx, "Client", featherless):
    listed = cloud_featherless.ADAPTER.list_models(api_key="fixture", base_url=cloud_featherless.DEFAULT_BASE_URL)
assert listed.capabilities["vendor/large"]["limits"]["contextTokens"] == 32768
assert listed.capabilities["vendor/large"]["limits"]["maxOutputTokens"] == 65536
assert listed.capabilities["vendor/small"]["limits"]["contextTokens"] == 8192
assert [call[0].rsplit("/", 1)[-1] for call in featherless.calls] == ["models", "plan"]
assert all(call[1]["headers"]["Authorization"] == "Bearer fixture" for call in featherless.calls)
featherless.plan_status = 403
with patch.object(cloud_featherless.httpx, "Client", featherless):
    uncertain = cloud_featherless.ADAPTER.list_models(api_key="fixture", base_url=cloud_featherless.DEFAULT_BASE_URL)
assert "contextTokens" not in uncertain.capabilities["vendor/large"]["limits"]
assert uncertain.capabilities["vendor/large"]["limits"]["maxOutputTokens"] == 65536

# HF auto-routing selects/fails over between upstreams with different maxima.
hf = Catalogue({"data": [
    {"id": "vendor/selected", "providers": [
        {"provider": "novita", "status": "live", "context_length": 1048576},
        {"provider": "together", "status": "live", "context_length": 512000},
        {"provider": "unmeasured", "status": "live"},
        {"provider": "offline", "status": "error", "context_length": 4096},
    ]},
    {"id": "vendor/ambiguous", "providers": [
        {"provider": "novita", "status": "live", "context_length": 8192},
        {"provider": "novita", "status": "live", "context_length": 4096},
    ]},
]})
with patch.object(cloud_huggingface.httpx, "Client", hf):
    listed = cloud_huggingface.ADAPTER.list_models(api_key="fixture", base_url=cloud_huggingface.DEFAULT_BASE_URL)
cap = listed.capabilities["vendor/selected"]
assert "limits" not in cap
assert cap["provider_limits"]["novita"]["contextTokens"] == 1048576
assert cap["provider_limits"]["together"]["contextTokens"] == 512000
assert "unmeasured" not in cap["provider_limits"] and "offline" not in cap["provider_limits"]
assert "provider_limits" not in listed.capabilities.get("vendor/ambiguous", {})
assert len(hf.calls) == 1
print("Cloud router catalogue token limits: passed (5 providers, no paid requests)")
