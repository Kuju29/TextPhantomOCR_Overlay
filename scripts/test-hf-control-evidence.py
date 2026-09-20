"""HF request evidence: accepted controls do not establish effective settings.

HTTP is mocked; this test makes no claims about a live HF account/model route.
"""
from __future__ import annotations

import sys
import types
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
try:
    import httpx  # noqa: F401
except ModuleNotFoundError:
    stub = types.ModuleType("httpx")
    stub.RequestError = type("RequestError", (Exception,), {})
    stub.HTTPStatusError = type("HTTPStatusError", (stub.RequestError,), {})
    stub.Response = object
    stub.Client = object
    stub.Timeout = lambda **kwargs: kwargs
    sys.modules["httpx"] = stub

from backend.ai.clients.base import ChatResult
from backend.ai.provider_contract import GenerationRequest, ProbeRequest, ProbeResponse
from backend.ai.providers import cloud_huggingface as hf
from backend import trace

probe_request = ProbeRequest(model="fixture-model", base_url=hf.DEFAULT_BASE_URL)
with patch.object(hf, "openai_chat_probe", return_value=ProbeResponse(True, 200)):
    capabilities = hf.ADAPTER.probe(probe_request).capabilities
assert capabilities["reasoning"]["supported_efforts"] == ["none", "low"]

request = GenerationRequest(
    provider="huggingface", model="fixture-model", system_text="STYLE",
    user_parts=("<<TP_P0:Hello>>",), expected_ids=("P0",), unit_count=1,
    model_capabilities=capabilities,
)
calls = []
def execute(**kwargs):
    calls.append(kwargs)
    return ChatResult("<<TP_P0:Hi>>", kwargs["model"], thinking_tokens=0)

for mode, effort in [("off", "none"), ("on", "low")]:
    with patch.object(hf, "execute_huggingface_chat", execute):
        result = hf.ADAPTER.generate(replace(request, thinking=mode))
    call = calls[-1]
    assert call["payload"]["reasoning_effort"] == effort
    assert "temperature" not in call["payload"]
    fields = trace._short(call["trace_fields"])
    assert fields["sampling"] == {
        "requestedTemperature": None,
        "temperatureOmissionReason": "reasoning_compatibility_policy",
        "effectiveTemperature": "unknown", "topPSent": False,
    }
    assert fields["reasoningEvidence"]["behavior"] == "not_verified_by_probe"
    assert result.thinking_applied == f"requested_{mode}_effort_{effort}"

with patch.object(hf, "execute_huggingface_chat", execute):
    hf.ADAPTER.generate(replace(request, model_capabilities={}))
assert calls[-1]["payload"]["temperature"] == 0.7
assert "reasoning_effort" not in calls[-1]["payload"]
assert calls[-1]["trace_fields"]["sampling"]["requestedTemperature"] == 0.7
assert calls[-1]["trace_fields"]["sampling"]["effectiveTemperature"] == "unknown"
assert calls[-1]["trace_fields"]["sampling"]["temperatureOmissionReason"] is None

with patch.object(hf, "execute_huggingface_chat", return_value=ChatResult("Hi", "fixture-model", thinking_tokens=4)):
    assert hf.ADAPTER.generate(replace(request, thinking="off")).thinking_applied == "provider_ignored_off"

# A rejected optional control must keep the ordinary health probe fallback.
with patch.object(hf, "openai_chat_probe", side_effect=[ProbeResponse(False, 400), ProbeResponse(True, 200)]) as probe:
    fallback = hf.ADAPTER.probe(probe_request)
assert fallback.ok and not fallback.capabilities
assert probe.call_args.kwargs["payload_extra"] == {"max_tokens": 256}
print("PASS HF control evidence: unchanged off/on/unknown payloads, explicit sampling uncertainty, trace preservation, ignored-off telemetry, health fallback (HTTP mocked)")
