"""Physical Local context versus ordinary output targets; mocked native metadata."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from backend.ai.clients.base import ChatResult
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import local_lmstudio, local_ollama, local_openai_runtime
from backend.ai.providers.ollama_context import plan_ollama_context
from backend.ai.workload import WorkloadBudgetError


class NativeTokenWindows(unittest.TestCase):
    def test_ollama_architecture_allows_above_16k_no_fabricated_max(self):
        live = {"scope": "runtime", "source": "ollama-api-show-and-ps",
                "modelContextTokens": 65536, "runtimeContextTokens": 256,
                "contextTokens": 256}
        plan = plan_ollama_context(live, {"estimatedInput": 6000,
            "predictedOutput": 8192, "reasoningReserve": 0})
        self.assertGreater(plan["evidence"]["requestedContext"], 16384)
        self.assertEqual(plan["evidence"]["contextCeiling"], 65536)
        unknown = plan_ollama_context({key: value for key, value in live.items()
                                      if key != "modelContextTokens"},
            {"estimatedInput": 6000, "predictedOutput": 8192})
        self.assertGreater(unknown["evidence"]["requestedContext"], 16384)
        self.assertIsNone(unknown["evidence"]["contextCeiling"])
        self.assertIsNone(plan_ollama_context({}, {"estimatedInput": 1000}))

    def test_ollama_current_short_window_rejects_before_post(self):
        limits = {"scope": "runtime", "source": "ollama-api-show-and-ps",
                  "modelContextTokens": 4096, "runtimeContextTokens": 4096,
                  "contextTokens": 4096}
        with patch.object(local_ollama.httpx, "Client") as transport, \
             self.assertRaises(WorkloadBudgetError):
            local_ollama.generate("http://localhost:11434", "selected",
                "STYLE", ["ก" * 5000], thinking="off",
                workload={"version": 1, "predictedOutput": 5000},
                model_capabilities={"limits": limits},
                source_unit_texts=("ก" * 5000,))
        transport.assert_not_called()

    def test_native_lmstudio_long_unit_gets_more_than_ordinary_8k(self):
        source = "ก" * 8500
        request = GenerationRequest(provider="lmstudio", model="selected",
            base_url="http://localhost:1234/v1", system_text="STYLE",
            user_parts=(f"<<TP_P0:{source}>>",), source_unit_texts=(source,),
            thinking="default", unit_count=1, expected_ids=("P0",),
            model_capabilities={
                "reasoning": {"supported": False},
                "limits": {"contextTokens": 32768, "runtimeContextTokens": 32768,
                           "scope": "runtime", "source": "lmstudio_native_loaded_instance"}},
            workload={"version": 1, "predictedOutput": 10500},
            cache_context={"translationMode": "conversation", "thinkingRequested": "minimum",
                           "reasoningCapabilityVerified": True})
        body, applied = local_lmstudio.ADAPTER.prepare_native_payload(request)
        self.assertEqual(applied, "not_applicable_non_reasoning_model")
        self.assertGreater(body["max_output_tokens"], 8192)
        self.assertLess(body["max_output_tokens"], 32768)

    def test_vllm_llamacpp_long_unit_dynamic_output_without_model_output_max(self):
        source = "ก" * 8500
        real_client = httpx.Client
        for provider in ("vllm", "llamacpp"):
            from backend.ai.provider_registry import provider_registry
            from backend.ai.provider_bootstrap import ensure_provider_registry
            ensure_provider_registry()
            adapter = provider_registry.require(provider).adapter
            seen = []
            def handle(req):
                seen.append((req.method,req.url.path))
                self.assertEqual(req.method,"GET")
                return httpx.Response(200,json={"data":[{"id":"selected",
                    "max_model_len":32768,"meta":{"n_ctx":32768,"n_ctx_train":65536}}]})
            request = GenerationRequest(provider=provider, model="selected",
                base_url=adapter.policy.default_base_url, system_text="STYLE",
                user_parts=(f"<<TP_P0:{source}>>",), source_unit_texts=(source,),
                thinking="default", expected_ids=("P0",), unit_count=1,
                workload={"version":1,"predictedOutput":10500},
                model_capabilities={"limits":{"contextTokens":256,
                    "maxOutputTokens":256}})
            with self.subTest(provider=provider), \
                 patch.object(local_openai_runtime.httpx, "Client",
                    side_effect=lambda *,timeout:real_client(
                        transport=httpx.MockTransport(handle),timeout=timeout)), \
                 patch.object(local_openai_runtime, "execute_chat_completion",
                    return_value=ChatResult("<<TP_P0:คำแปล>>","selected")) as wire:
                adapter.generate(request)
                self.assertEqual(seen, [("GET","/v1/models")])
                self.assertGreater(wire.call_args.kwargs["payload"]["max_tokens"],8192)
                self.assertLess(wire.call_args.kwargs["payload"]["max_tokens"],32768)


if __name__ == "__main__":
    unittest.main(verbosity=2)
