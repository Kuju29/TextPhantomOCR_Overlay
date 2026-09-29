"""Read-only mock catalogues for the four native Cloud budget boundaries."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from backend.ai.providers import cloud_anthropic, cloud_deepseek, cloud_gemini, cloud_openai
from backend.ai.workload import guard_output_budget


class Catalogue:
    def __init__(self, body):
        self.body = body
        self.calls = []

    def __call__(self, *args, **kwargs):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return httpx.Response(200, json=self.body, request=httpx.Request("GET", url))


anthropic = Catalogue({"data": [
    {"id": "claude-sonnet-5", "max_input_tokens": 200000, "max_tokens": 64000},
    {"id": "claude-sonnet-5-preview", "max_input_tokens": True, "max_tokens": "64000"},
    {"id": "ambiguous", "max_input_tokens": 1000, "max_tokens": 2000},
    {"id": "ambiguous", "max_input_tokens": 500, "max_tokens": 1000},
]})
with patch.object(cloud_anthropic.httpx, "Client", anthropic):
    listed = cloud_anthropic.ADAPTER.list_models(api_key="fixture", base_url=cloud_anthropic.DEFAULT_BASE_URL)
assert listed.status == "valid"
assert listed.capabilities["claude-sonnet-5"]["limits"] == {
    "maxInputTokens": 200000, "maxOutputTokens": 64000,
    "source": "anthropic_account_models_api", "scope": "model",
}
assert "limits" not in listed.capabilities.get("claude-sonnet-5-preview", {})
assert "limits" not in listed.capabilities.get("ambiguous", {})
assert len(anthropic.calls) == 1 and anthropic.calls[0][1]["headers"]["x-api-key"] == "fixture"

gemini = Catalogue({"models": [
    {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"],
     "inputTokenLimit": 1048576, "outputTokenLimit": 65536},
    {"name": "models/gemini-2.5-pro", "supportedGenerationMethods": ["generateContent"],
     "inputTokenLimit": 32768, "outputTokenLimit": None},
    {"name": "models/gemini-duplicate", "supportedGenerationMethods": ["generateContent"],
     "inputTokenLimit": 1000},
    {"name": "models/gemini-duplicate", "supportedGenerationMethods": ["generateContent"],
     "inputTokenLimit": 2000},
]})
with patch.object(cloud_gemini.httpx, "Client", gemini):
    status = cloud_gemini.models_status("fixture")
assert status["capabilities"]["gemini-2.5-flash"]["limits"]["maxInputTokens"] == 1048576
assert status["capabilities"]["gemini-2.5-flash"]["limits"]["maxOutputTokens"] == 65536
assert "maxOutputTokens" not in status["capabilities"]["gemini-2.5-pro"]["limits"]
assert "limits" not in status["capabilities"].get("gemini-duplicate", {})

deepseek = Catalogue({"data": [
    {"id": "deepseek-flash", "context_window": 131072, "max_output_tokens": 32768},
    {"id": "future-model", "context_window": "131072", "max_output_tokens": False},
    {"id": "ambiguous", "context_window": 8192},
    {"id": "ambiguous", "context_window": 2048},
]})
with patch.object(cloud_deepseek.httpx, "Client", deepseek):
    listed = cloud_deepseek.ADAPTER.list_models(api_key="fixture", base_url=cloud_deepseek.DEFAULT_BASE_URL)
assert listed.capabilities["deepseek-flash"]["limits"]["contextTokens"] == 131072
assert listed.capabilities["deepseek-flash"]["limits"]["maxOutputTokens"] == 32768
assert "limits" not in listed.capabilities.get("future-model", {})
assert "limits" not in listed.capabilities.get("ambiguous", {})

# OpenAI's official /models list includes eligibility, not numeric ceilings.
openai = Catalogue({"data": [
    {"id": "gpt-4o", "context_window": 32768, "max_output_tokens": 1024},
]})
with patch.object(cloud_openai.httpx, "get", lambda url, **kwargs: openai.get(url, **kwargs)):
    listed = cloud_openai.ADAPTER.list_models(api_key="fixture", base_url=cloud_openai.DEFAULT_BASE_URL)
assert listed.models == ("gpt-4o",)
assert "limits" not in listed.capabilities.get("gpt-4o", {})

# Physical limit reaches the actual pre-dispatch budget guard; no static
# 8,192-token cap is confused with the model's authenticated output ceiling.
result = guard_output_budget(8000, workload={"version": 1, "predictedOutput": 512},
    limits={"maxOutputTokens": 2500}, system="translate", parts=("<<TP_I1_P0:hello>>",))
assert result == 2500, result
print("Cloud native catalogue token limits: passed (4 providers, no paid requests)")
