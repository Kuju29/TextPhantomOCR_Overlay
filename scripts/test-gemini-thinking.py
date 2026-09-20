from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.ai.provider_resolution import normalize_model_capabilities
from backend.ai.providers import cloud_gemini


class Response:
    status_code = 200
    is_success = True

    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body

    def raise_for_status(self):
        return None


class ModelsClient:
    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def get(self, _url):
        return Response({
            "models": [
                {"name": "models/gemini-2.5-flash", "version": "v1", "inputTokenLimit": 1000000,
                 "outputTokenLimit": 65536, "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-2.5-flash-lite", "version": "v1", "inputTokenLimit": 1000000,
                 "outputTokenLimit": 65536, "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-2.5-pro", "version": "v1", "inputTokenLimit": 1000000,
                 "outputTokenLimit": 65536, "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-3.6-flash", "version": "v1", "inputTokenLimit": 1000000,
                 "outputTokenLimit": 65536, "supportedGenerationMethods": ["generateContent"]},
            ]
        })


def completion():
    return Response({
        "candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "คำแปลไทย"}]}}],
        "usageMetadata": {
            "promptTokenCount": 100,
            "candidatesTokenCount": 20,
            "thoughtsTokenCount": 500,
            "totalTokenCount": 620,
        },
    })


def capture_generate(model: str, thinking: str):
    payloads = []

    def post(_key, _model, payload, _cancel=None):
        payloads.append(payload)
        return completion()

    with (
        patch.object(cloud_gemini, "_post_once", post),
        patch.object(cloud_gemini.wire_trace, "provider_request", lambda **_: None),
        patch.object(cloud_gemini.wire_trace, "http_response", lambda *_: None),
        patch.object(cloud_gemini.wire_trace, "assembled_response", lambda *_: None),
    ):
        result = cloud_gemini.generate(
            "AIza-fixture", model, "system", ["source"], thinking=thinking,
            unit_count=1, workload=None, model_capabilities={"limits": {"maxOutputTokens": 65536}},
        )
    assert len(payloads) == 1
    return payloads[0], result


def main():
    with patch.object(cloud_gemini.httpx, "Client", ModelsClient):
        listed = cloud_gemini.models_status("AIza-fixture")
    assert listed["status"] == "valid"
    caps = listed["capabilities"]
    flash = caps["gemini-2.5-flash"]["reasoning"]
    assert flash == {"supported": True, "mandatory": False, "default_enabled": True,
                     "control": "levels", "dynamic": True,
                     "supported_efforts": ["none", "low", "medium", "high"]}
    lite_cap = caps["gemini-2.5-flash-lite"]["reasoning"]
    assert lite_cap["default_enabled"] is False
    assert lite_cap["supported_efforts"] == ["none", "low", "medium", "high"]
    assert lite_cap["default_effort"] == "none"
    assert caps["gemini-2.5-pro"]["reasoning"]["mandatory"] is True
    g3 = caps["gemini-3.6-flash"]["reasoning"]
    assert g3["control"] == "levels" and g3["mandatory"] is True
    assert "off_effort" not in g3
    assert g3["supported_efforts"] == ["minimal", "low", "medium", "high"]
    normalized = normalize_model_capabilities({"reasoning": flash})["reasoning"]
    assert normalized["control"] == "levels" and normalized["dynamic"] is True
    assert normalized["supported_efforts"] == ["none", "low", "medium", "high"]

    default_payload, default_result = capture_generate("gemini-2.5-flash", "default")
    off_payload, off_result = capture_generate("gemini-2.5-flash", "off")
    flash_low_payload, flash_low_result = capture_generate("gemini-2.5-flash", "low")
    flash_medium_payload, flash_medium_result = capture_generate("gemini-2.5-flash", "medium")
    flash_high_payload, flash_high_result = capture_generate("gemini-2.5-flash", "high")
    on_payload, on_result = capture_generate("gemini-2.5-flash", "on")
    lite_payload, lite_result = capture_generate("gemini-2.5-flash-lite", "default")
    lite_off_payload, lite_off_result = capture_generate("gemini-2.5-flash-lite", "off")
    pro_off_payload, pro_off_result = capture_generate("gemini-2.5-pro", "off")
    pro_low_payload, pro_low_result = capture_generate("gemini-2.5-pro", "low")
    pro_medium_payload, pro_medium_result = capture_generate("gemini-2.5-pro", "medium")
    pro_high_payload, pro_high_result = capture_generate("gemini-2.5-pro", "high")
    g3_off_payload, g3_off_result = capture_generate("gemini-3.6-flash", "off")
    g3_min_payload, g3_min_result = capture_generate("gemini-3.6-flash", "minimal")

    assert "thinkingConfig" not in default_payload["generationConfig"]
    assert default_result.thinking_applied == "provider_default_levels"
    assert default_result.requested_output_tokens > off_result.requested_output_tokens
    assert off_payload["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 0}
    assert off_result.thinking_applied == "requested_off"
    assert flash_low_payload["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 1024}
    assert flash_low_result.thinking_applied == "requested_effort_low"
    assert flash_medium_payload["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 8192}
    assert flash_medium_result.thinking_applied == "requested_effort_medium"
    assert flash_high_payload["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 24576}
    assert flash_high_result.thinking_applied == "requested_effort_high"
    assert "thinkingConfig" not in on_payload["generationConfig"]
    assert on_result.thinking_applied == "provider_default_levels"
    assert "thinkingConfig" not in lite_payload["generationConfig"]
    assert lite_result.thinking_applied == "provider_default_levels"
    assert lite_result.requested_output_tokens == off_result.requested_output_tokens
    assert lite_off_payload["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 0}
    assert lite_off_result.thinking_applied == "requested_off"
    assert "thinkingConfig" not in pro_off_payload["generationConfig"]
    assert pro_off_result.thinking_applied == "provider_default_levels"
    assert pro_off_result.requested_output_tokens > off_result.requested_output_tokens
    assert pro_low_payload["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 1024}
    assert pro_low_result.thinking_applied == "requested_effort_low"
    assert pro_medium_payload["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 8192}
    assert pro_medium_result.thinking_applied == "requested_effort_medium"
    assert pro_high_payload["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 24576}
    assert pro_high_result.thinking_applied == "requested_effort_high"
    assert "thinkingConfig" not in g3_off_payload["generationConfig"]
    assert g3_off_result.thinking_applied == "provider_default_levels"
    assert g3_off_result.requested_output_tokens > off_result.requested_output_tokens
    assert g3_min_payload["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "minimal"}
    assert g3_min_result.thinking_applied == "requested_effort_minimal"

    # Provider usage is still the source of truth for hidden reasoning tokens.
    assert default_result.thinking_tokens == 500
    print("Gemini thinking capability/wire test passed: Gemini 2.5 exposes provider-specific budget levels (with Off only where supported), while Gemini 3 maps exact levels to thinkingLevel.")


if __name__ == "__main__":
    main()
