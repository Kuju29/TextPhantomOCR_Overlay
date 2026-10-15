"""Official OpenRouter null-vs-missing efforts through actual HTTP adapters.

Only httpx.MockTransport is used. No provider account or generation is contacted.
"""
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
os.environ["TP_AI_WIRE_TRACE"] = "0"
from backend.ai.providers import cloud_openrouter
from backend.ai.provider_contract import GenerationRequest
from backend.ai.cloud_reasoning import (
    CloudReasoningPreferenceUnavailable,
    PROVIDER_MANAGED_UNVERIFIED,
    ensure_cloud_reasoning_preflight,
)
from backend.ai.reasoning_preference import resolve_reasoning_preference


ALL_GATEWAY_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]


class OpenRouterReasoningMetadata(unittest.TestCase):
    def record(self, reasoning):
        return {"id": "fixture/ordinary-model", "supported_parameters": ["reasoning", "max_tokens"],
                "reasoning": reasoning, "architecture": {"input_modalities": ["text"],
                "output_modalities": ["text"]}, "context_length": 32768}

    def preflight(self, cap, requested):
        selected = resolve_reasoning_preference(requested, cap)
        result = ensure_cloud_reasoning_preflight("openrouter", "fixture/ordinary-model",
            requested, selected, cap, capability_verified=True)
        return selected, result

    def test_explicit_null_exposes_documented_gateway_efforts(self):
        cap = cloud_openrouter.normalize_capabilities(self.record({"supported_efforts": None,
            "mandatory": False, "default_effort": "medium", "default_enabled": True}))["reasoning"]
        self.assertEqual(cap["supported_efforts"], ALL_GATEWAY_EFFORTS)
        self.assertEqual(cap["control"], "levels")
        self.assertEqual(cap["default_effort"], "medium")
        self.assertIs(cap["default_enabled"], True)
        for requested in ("minimum", "off", "minimal", "low", "medium", "high", "xhigh", "max"):
            with self.subTest(requested=requested):
                selected, status = self.preflight(cap, requested)
                self.assertEqual(selected, "off" if requested == "minimum" else requested)
                self.assertIsNone(status)

    def test_null_mandatory_never_enables_off_and_lowest_is_minimal(self):
        cap = cloud_openrouter.normalize_capabilities(self.record({"supported_efforts": None,
            "mandatory": True}))["reasoning"]
        self.assertEqual(cap["supported_efforts"], ALL_GATEWAY_EFFORTS[1:])
        self.assertEqual(self.preflight(cap, "minimum"), ("minimal", None))
        with self.assertRaises(CloudReasoningPreferenceUnavailable):
            self.preflight(cap, "off")

    def test_missing_efforts_does_not_invent_lowest_or_named_effort(self):
        cap = cloud_openrouter.normalize_capabilities(self.record({"supported": True}))["reasoning"]
        self.assertNotIn("supported_efforts", cap)
        self.assertEqual(cap["control"], "provider")
        self.assertEqual(self.preflight(cap, "minimum"), ("default", PROVIDER_MANAGED_UNVERIFIED))
        for preference in ("off", "high"):
            with self.subTest(preference=preference), self.assertRaises(CloudReasoningPreferenceUnavailable):
                self.preflight(cap, preference)
        request = GenerationRequest(provider="openrouter", model="fixture/ordinary-model",
            system_text="Translate", user_parts=("Owned source",), thinking="default",
            model_capabilities={"reasoning": cap})
        self.assertNotIn("reasoning", cloud_openrouter.prepare_payload(request))

    def test_non_null_malformed_values_cannot_enable_named_efforts(self):
        for value in ("all", {}, 0, True):
            with self.subTest(value=value):
                cap = cloud_openrouter.normalize_capabilities(self.record({"supported_efforts": value}))["reasoning"]
                self.assertNotIn("supported_efforts", cap)
                with self.assertRaises(CloudReasoningPreferenceUnavailable):
                    self.preflight(cap, "high")
        cap = cloud_openrouter.normalize_capabilities(self.record({"supported": False,
            "supported_efforts": None}))["reasoning"]
        self.assertIs(cap["supported"], False)
        with self.assertRaises(CloudReasoningPreferenceUnavailable):
            self.preflight(cap, "high")

    def test_explicit_list_remains_exact_without_expanding_unlisted_levels(self):
        cap = cloud_openrouter.normalize_capabilities(self.record({"supported_efforts": ["low", "high"],
            "mandatory": True}))["reasoning"]
        self.assertEqual(cap["supported_efforts"], ["low", "high"])
        self.assertEqual(self.preflight(cap, "minimum"), ("low", None))
        with self.assertRaises(CloudReasoningPreferenceUnavailable):
            self.preflight(cap, "max")

    def test_account_catalogue_to_preflight_to_real_http_payload(self):
        calls = []
        client_type = httpx.Client
        def provider(req):
            calls.append((req.method, req.url.path, json.loads(req.content) if req.content else None))
            if req.method == "GET" and req.url.path.endswith("/endpoints"):
                # .83 cache-capable endpoint order: this fixture model has no endpoint list.
                return httpx.Response(404, json={"error": {"message": "not found"}})
            if req.method == "GET":
                self.assertEqual(req.url.path, "/api/v1/models/user")
                return httpx.Response(200, json={"data": [self.record({"supported_efforts": None,
                    "mandatory": True, "default_effort": "high"})]})
            self.assertEqual(req.url.path, "/api/v1/chat/completions")
            frames = [{"choices": [{"delta": {"content": "<<I1_P0:คำแปล>>"}, "finish_reason": None}]},
                      {"choices": [{"delta": {}, "finish_reason": "stop"}],
                       "usage": {"prompt_tokens": 9, "completion_tokens": 5, "total_tokens": 14}}]
            stream = "".join("data: " + json.dumps(frame, ensure_ascii=False) + "\n\n" for frame in frames)
            return httpx.Response(200, text=stream + "data: [DONE]\n\n", headers={"content-type": "text/event-stream"})
        with patch.object(cloud_openrouter.httpx, "Client", side_effect=lambda **kw:
            client_type(**kw, transport=httpx.MockTransport(provider))):
            listed = cloud_openrouter.ADAPTER.list_models(api_key="synthetic-owner", base_url=cloud_openrouter.DEFAULT_BASE_URL)
            self.assertEqual(listed.status, "valid")
            capabilities = listed.capabilities["fixture/ordinary-model"]
            selected, status = self.preflight(capabilities["reasoning"], "high")
            self.assertIsNone(status)
            result = cloud_openrouter.ADAPTER.generate(GenerationRequest(provider="openrouter",
                model="fixture/ordinary-model", api_key="synthetic-owner", base_url=cloud_openrouter.DEFAULT_BASE_URL,
                system_text="Translate", user_parts=("<<I1_P0:Source>>",), thinking=selected,
                model_capabilities=capabilities, expected_ids=("I1_P0",)))
        self.assertEqual([call[1] for call in calls if call[0] == "GET"],
                         ["/api/v1/models/user", "/api/v1/models/fixture/ordinary-model/endpoints"])
        posts = [call for call in calls if call[0] == "POST"]
        self.assertEqual(len(posts), 1)
        body = posts[0][2]
        self.assertEqual(body["model"], "fixture/ordinary-model")
        self.assertEqual(body["reasoning"], {"effort": "high"})
        self.assertIs(body["provider"]["require_parameters"], True)
        self.assertGreater(body["max_completion_tokens"], 0)
        self.assertTrue(result.terminal_completed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
