"""A short reasoning-model health probe cannot prove a model unusable."""
import httpx
import sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from backend.ai.provider_contract import ProbeRequest
from backend.ai.providers.probe_support import openai_chat_probe

class ProbeClient:
    finish_reason = "length"
    def __init__(self, *args, **kwargs): pass
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def post(self, url, **kwargs):
        assert kwargs["json"]["max_tokens"] == 128
        return httpx.Response(200, json={"choices":[{"finish_reason":self.finish_reason,
            "message":{"content":"", "reasoning":"probe spent budget on reasoning"}}]})

request = ProbeRequest(model="openai/gpt-oss-20b", api_key="fixture",
    base_url="https://api.groq.com/openai/v1")
with patch("backend.ai.providers.probe_support.httpx.Client", ProbeClient):
    outcome = openai_chat_probe(request)
    assert outcome.ok is False and outcome.status == "probe_inconclusive"
    ProbeClient.finish_reason = "stop"
    hard_empty = openai_chat_probe(request)
    assert hard_empty.status == "invalid_model_output"
print("PASS Groq output-limited probe remains inconclusive, empty stopped output stays invalid")
