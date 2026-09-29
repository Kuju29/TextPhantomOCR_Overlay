#!/usr/bin/env python3
"""Offline wire and Thinking admission checks for the seven local chat adapters."""
from __future__ import annotations

import json
import sys
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from backend.ai.clients.base import ChatResult, OutputBudgetExhausted, ProviderOutputError
from backend.ai import accounting
from backend.ai.provider_contract import GenerationRequest, ProbeRequest
from backend.ai.providers.local_openai_runtime import LocalOpenAIChatAdapter
from backend.ai.providers import local_openai_runtime
from backend.ai.providers import (
    local_gpt4all, local_jan, local_koboldcpp, local_llamacpp,
    local_llamafile, local_textgen, local_vllm,
)
from backend.ai.translation_paths.store import ConversationError

MODULES = (local_jan, local_textgen, local_koboldcpp, local_vllm,
           local_llamafile, local_gpt4all, local_llamacpp)
TRANSPORT = "backend.ai.providers.local_openai_runtime.execute_chat_completion"


def request(module, *, thinking="off", originally=None, capabilities=None,
            verified=False, image=False):
    return GenerationRequest(
        provider=module.POLICY.provider_id, model="exact-selected-model",
        base_url=module.DEFAULT_BASE_URL, system_text="SYS STYLE",
        user_parts=("<<TP_I2_P0:now>>",), expected_ids=("I2_P0",),
        unit_count=1, thinking=thinking,
        image_b64="AAECAw==" if image else "",
        model_capabilities=capabilities or {},
        cache_context={"thinkingRequested": originally or thinking,
                       "reasoningCapabilityVerified": verified},
        history_messages=(
            {"role": "user", "text": "<<TP_I1_P0:before>>"},
            {"role": "assistant", "text": "<<TP_I1_P0:translated>>"},
        ),
    )


class LocalCompatibleThinkingTests(unittest.TestCase):
    def setUp(self):
        # vLLM/llama.cpp/KoboldCpp require a current exact-model /models
        # GET before every generation, even when transport itself is mocked.
        real_client = httpx.Client
        self.real_http_client = real_client
        self.metadata_gets = []
        def handle(req):
            self.metadata_gets.append(str(req.url))
            self.assertEqual(req.method, 'GET')
            if req.url.path == '/api/extra/true_max_context_length':
                return httpx.Response(404)
            self.assertEqual(req.url.path, '/v1/models')
            return httpx.Response(200, json={'data': [
                {'id': 'exact-selected-model', 'max_model_len': 32768,
                 'meta': {'n_ctx': 32768, 'n_ctx_train': 65536}}]})
        p = patch.object(local_openai_runtime.httpx, 'Client',
            side_effect=lambda *, timeout: real_client(
                transport=httpx.MockTransport(handle), timeout=timeout))
        p.start(); self.addCleanup(p.stop)

    def test_koboldcpp_native_context_is_bound_to_one_exact_loaded_model(self):
        for rows, native, expected, calls in (
            ([{'id': 'exact-selected-model'}], {'value': 8192}, 8192, 1),
            ([{'id': 'exact-selected-model'}, {'id': 'other'}], {'value': 8192}, None, 0),
            ([{'id': 'exact-selected-model'}, {'id': 'exact-selected-model'}], {'value': 8192}, None, 0),
            ([{'id': 'exact-selected-model'}], {'value': 0}, None, 1),
            ([{'id': 'exact-selected-model'}], {'value': '8192'}, None, 1),
            ([{'id': 'exact-selected-model'}], {'value': True}, None, 1),
            ([{'id': 'exact-selected-model'}], {'value': 100_000_001}, None, 1),
            ([{'id': 'exact-selected-model'}], None, None, 1),
        ):
            with self.subTest(rows=len(rows), native=native):
                observed = []
                def handle(req):
                    observed.append(req)
                    if req.url.path == '/v1/models':
                        return httpx.Response(200, json={'data': rows})
                    self.assertEqual(req.url.path, '/api/extra/true_max_context_length')
                    return httpx.Response(200, json=native) if native is not None else httpx.Response(404)
                with patch.object(local_openai_runtime.httpx, 'Client',
                        side_effect=lambda *, timeout: self.real_http_client(
                            transport=httpx.MockTransport(handle), timeout=timeout)):
                    result = local_koboldcpp.ADAPTER.list_models(api_key='', base_url=local_koboldcpp.DEFAULT_BASE_URL)
                self.assertEqual(result.status, 'valid')
                limit = result.capabilities.get('exact-selected-model', {}).get('limits')
                self.assertEqual(limit.get('runtimeContextTokens') if limit else None, expected)
                self.assertEqual(sum(req.url.path == '/api/extra/true_max_context_length' for req in observed), calls)
                self.assertTrue(all(req.method == 'GET' and 'authorization' not in req.headers for req in observed))
                self.assertTrue(all(req.url.host == 'localhost' for req in observed))

    def test_empty_length_is_typed_without_reported_reasoning_and_visible_partial_is_preserved(self):
        real_client = self.real_http_client
        for visible, thought, expected_subtype in (
                ("", "", "empty_output"),
                ("", "private", "reasoning_only_exhausted"),
                ("<<TP_I2_P0:partial", "", None)):
            with self.subTest(visible=bool(visible), thought=bool(thought)):
                def handle(_wire):
                    frames = []
                    if thought:
                        frames.append({"choices": [{"delta": {"reasoning_content": thought}}]})
                    if visible:
                        frames.append({"choices": [{"delta": {"content": visible}}]})
                    frames.append({"choices": [{"delta": {}, "finish_reason": "length"}],
                                   "usage": {"prompt_tokens": 90, "completion_tokens": 20,
                                             "total_tokens": 110}})
                    return httpx.Response(200, text="".join(
                        "data: " + json.dumps(frame) + "\n\n" for frame in frames) +
                        "data: [DONE]\n\n")
                with patch("backend.ai.transports.openai_compat.core.httpx.Client",
                           side_effect=lambda *, timeout: real_client(
                               transport=httpx.MockTransport(handle), timeout=timeout)):
                    if expected_subtype:
                        with self.assertRaises(OutputBudgetExhausted) as caught:
                            local_jan.ADAPTER.generate(request(local_jan, thinking="default"))
                        details = caught.exception.structural_details
                        self.assertEqual(details["validatorSubtype"], expected_subtype)
                        self.assertEqual(details.get("reasoningOnlyExhausted"), bool(thought) or None)
                        self.assertEqual(details["generationMeta"]["usage"]["totalTokens"], 110)
                    else:
                        result = local_jan.ADAPTER.generate(request(local_jan, thinking="default"))
                        self.assertEqual(result.text, visible)
                        self.assertEqual(result.finish_reason, "length")
                        self.assertEqual(result.total_tokens, 110)

    def test_explicit_preferences_fail_before_transport_without_exact_proof(self):
        cases = (("off", "off"), ("default", "on"), ("default", "low"))
        for module in MODULES:
            for selected, originally in cases:
                with self.subTest(provider=module.POLICY.provider_id, requested=originally), \
                        patch(TRANSPORT) as transport:
                    with self.assertRaises(ConversationError) as raised:
                        module.ADAPTER.generate(request(
                            module, thinking=selected, originally=originally,
                            # A forged browser snapshot is not server proof.
                            capabilities={"reasoning": {"supported": False}}))
                    self.assertEqual(raised.exception.code,
                                     "ai_local_thinking_unsupported")
                    self.assertFalse(raised.exception.requestDispatched)
                    transport.assert_not_called()

    def test_unknown_lowest_uses_unverified_provider_default_without_reasoning_field(self):
        for module in MODULES:
            with self.subTest(provider=module.POLICY.provider_id), \
                    patch(TRANSPORT, return_value=ChatResult("answer", "selected")) as transport:
                result = module.ADAPTER.generate(request(module, thinking="default",
                    originally="minimum", capabilities={"reasoning": {"supported": False}}))
                payload = transport.call_args.kwargs["payload"]
                self.assertFalse({"thinking", "reasoning", "reasoning_effort"} & payload.keys())
                self.assertEqual(result.thinking_applied, "provider_managed_unverified")

    def test_generic_openai_shape_does_not_prove_thinking_toggle(self):
        for module in MODULES:
            with self.subTest(provider=module.POLICY.provider_id), patch(TRANSPORT) as transport:
                with self.assertRaises(ConversationError):
                    module.ADAPTER.generate(request(
                        module, capabilities={"reasoning": {
                            "supported": True, "control": "boolean",
                            "mandatory": False}}, verified=True))
                transport.assert_not_called()

    def test_explicit_default_replays_history_with_no_native_session_claim(self):
        for module in MODULES:
            with self.subTest(provider=module.POLICY.provider_id), \
                    patch(TRANSPORT, return_value=ChatResult(
                        "<<TP_I2_P0:now in Thai>>", "exact-selected-model")) as transport:
                result = module.ADAPTER.generate(request(module, thinking="default", image=True))
                args = transport.call_args.kwargs
                self.assertEqual(args["url"],
                                 module.DEFAULT_BASE_URL + "/chat/completions")
                self.assertEqual(args["provider_id"], module.POLICY.provider_id)
                payload = args["payload"]
                self.assertEqual([m["role"] for m in payload["messages"]],
                                 ["system", "user", "assistant", "user"])
                self.assertEqual(payload["messages"][0]["content"], "SYS STYLE")
                self.assertEqual(payload["messages"][1]["content"], "<<TP_I1_P0:before>>")
                self.assertEqual(payload["messages"][2]["content"], "<<TP_I1_P0:translated>>")
                self.assertEqual(payload["messages"][3]["content"][0]["type"], "image_url")
                self.assertEqual(payload["messages"][3]["content"][0]["image_url"]["url"],
                                 "data:image/jpeg;base64,AAECAw==")
                self.assertEqual(payload["messages"][3]["content"][1]["text"],
                                 "<<TP_I2_P0:now>>")
                self.assertFalse({"store", "previous_response_id", "session_id",
                                  "thinking", "reasoning", "reasoning_effort"} & payload.keys())
                self.assertEqual(result.thinking_applied, "provider_default")

    def test_server_proven_nonreasoning_can_honor_off_and_lowest(self):
        evidence = {"reasoning": {"supported": False}}
        for module in (item for item in MODULES if item not in (local_vllm, local_llamacpp, local_koboldcpp)):
            for originally in ("off", "minimum"):
                with self.subTest(provider=module.POLICY.provider_id, requested=originally), \
                        patch(TRANSPORT, return_value=ChatResult("valid", "exact-selected-model")) as transport:
                    result = module.ADAPTER.generate(request(
                        module, originally=originally, verified=True,
                        capabilities=evidence))
                    self.assertEqual(result.thinking_applied,
                                     "not_applicable_non_reasoning_model")
                    self.assertEqual(transport.call_count, 1)
                    trace = transport.call_args.kwargs["trace_fields"]
                    self.assertEqual(trace["reasoningModeRequested"], originally)
                    self.assertEqual(trace["reasoningModeSelected"], "off")

    def test_live_context_adapters_discard_stale_nonreasoning_claim(self):
        for module in (local_vllm, local_llamacpp, local_koboldcpp):
            self.metadata_gets.clear()
            stale = {"reasoning": {"supported": False},
                     "limits": {"contextTokens": 256, "scope": "runtime",
                                "source": module.POLICY.provider_id + "-models"}}
            if module is local_koboldcpp:
                # A Kobold model list proves identity; its optional native GET
                # is unavailable in this fixture and proves no Thinking mode.
                stale = {"reasoning": {"supported": False}}
            with self.subTest(provider=module.POLICY.provider_id), patch(TRANSPORT) as transport:
                with self.assertRaises(ConversationError) as caught:
                    module.ADAPTER.generate(request(module, thinking="off",
                        originally="off", verified=True, capabilities=stale))
                self.assertEqual(caught.exception.code, "ai_local_thinking_unsupported")
                transport.assert_not_called()
                self.assertEqual(len(self.metadata_gets), 2 if module is local_koboldcpp else 1)
                self.assertTrue(self.metadata_gets[0].endswith("/v1/models"))
                if module is local_koboldcpp:
                    self.assertTrue(self.metadata_gets[1].endswith("/api/extra/true_max_context_length"))

    def test_positive_reasoning_overrides_stale_nonreasoning_proof(self):
        evidence = {"reasoning": {"supported": False}}
        for module in (item for item in MODULES if item not in (local_vllm, local_llamacpp, local_koboldcpp)):
            for originally in ("off", "minimum"):
                for reported in (ChatResult(
                        "valid but unusable", "exact-selected-model", input_tokens=10,
                        output_tokens=5, thinking_tokens=3), ChatResult(
                        "valid but unusable", "exact-selected-model", input_tokens=10,
                        output_tokens=5, usage_details={"inputTokens": 10,
                                                        "outputTokens": 5,
                                                        "thinkingTokens": 3}), ChatResult(
                        "valid but unusable", "exact-selected-model", input_tokens=10,
                        output_tokens=5, reasoning_observed=True)):
                    with self.subTest(provider=module.POLICY.provider_id,
                                      requested=originally,
                                      source="field" if reported.thinking_tokens else "usage"), \
                            patch(TRANSPORT, return_value=reported) as transport:
                        with self.assertRaises(ProviderOutputError) as raised:
                            module.ADAPTER.generate(request(
                                module, originally=originally, verified=True,
                                capabilities=evidence))
                        error = raised.exception
                        self.assertEqual(error.code, "ai_local_thinking_violated")
                        self.assertTrue(error.requestDispatched)
                        self.assertEqual(error.generationAttempts, 1)
                        self.assertEqual(error.structural_details["observedThinkingTokens"],
                                         3 if not reported.reasoning_observed else None)
                        self.assertEqual(error.structural_details["reasoningContentObserved"],
                                         bool(reported.reasoning_observed))
                        self.assertNotIn("valid but unusable", str(error.structural_details))
                        self.assertEqual(transport.call_count, 1)

    def test_future_verified_off_control_labels_zero_and_unknown_truthfully(self):
        # An independently documented leaf may one day opt into a native bool
        # field; the shared transport must not mistake absence of usage for 0.
        policy = replace(local_jan.POLICY, provider_id="future_native",
                         thinking_field="enable_thinking")
        adapter = LocalOpenAIChatAdapter(policy)
        req = replace(request(local_jan, verified=True,
                              capabilities={"reasoning": {
                                  "supported": True, "control": "boolean"}}),
                      provider="future_native")
        for observed, label in ((None, "requested_off_usage_unreported"),
                                (0, "requested_off")):
            with self.subTest(observed=observed), patch(
                    TRANSPORT, return_value=ChatResult(
                        "valid", req.model, thinking_tokens=observed)) as transport:
                self.assertEqual(adapter.generate(req).thinking_applied, label)
                self.assertIs(transport.call_args.kwargs["payload"]["enable_thinking"], False)
        with patch(TRANSPORT, return_value=ChatResult(
                "unusable", req.model, thinking_tokens=2)) as transport:
            with self.assertRaises(ProviderOutputError) as raised:
                adapter.generate(req)
            self.assertEqual(raised.exception.code, "ai_local_thinking_violated")
            self.assertEqual(transport.call_count, 1)

    def test_dispatched_contradiction_retains_provider_usage_receipt(self):
        module = local_jan
        fixture = request(module, verified=True,
                          capabilities={"reasoning": {"supported": False}})

        def actual_transport(**_kwargs):
            accounting.mark_dispatched()
            usage = accounting.observe({
                "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
                "completion_tokens_details": {"reasoning_tokens": 3},
            }, complete=True)
            return ChatResult("unusable", fixture.model, input_tokens=10,
                              output_tokens=5, total_tokens=15,
                              thinking_tokens=3, usage_details=usage)

        with accounting.receipt_scope("runsapi"), patch(
                TRANSPORT, side_effect=actual_transport):
            with self.assertRaises(ProviderOutputError) as raised:
                accounting.generate_with_receipt(module.ADAPTER, fixture)
            error = raised.exception
            self.assertTrue(error.requestDispatched)
            self.assertEqual(error.code, "ai_local_thinking_violated")
            self.assertEqual(error.generationMeta["usage"]["inputTokens"], 10)
            self.assertEqual(error.generationMeta["usage"]["thinkingTokens"], 3)
            self.assertEqual(error.generationMeta["usage"]["receiptStatus"],
                             "provider_response_error")
            self.assertTrue(error.generationMeta["usage"]["receiptId"])

    def test_jan_authorization_in_generation_model_listing_and_probe(self):
        jan = local_jan
        api_key = "private-january-key"
        fixture = request(jan, thinking="default")
        from dataclasses import replace
        fixture = replace(fixture, api_key=api_key)
        with patch(TRANSPORT, return_value=ChatResult("valid", fixture.model)) as transport:
            jan.ADAPTER.generate(fixture)
            self.assertEqual(transport.call_args.kwargs["headers"]["Authorization"],
                             f"Bearer {api_key}")

        class FakeClient:
            def __init__(self, *args, **kwargs):
                self.last_headers = None

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def get(self, url, *, headers):
                self.last_headers = headers
                self_test.assertEqual(url, jan.DEFAULT_BASE_URL + "/models")
                self_test.assertEqual(headers["Authorization"], f"Bearer {api_key}")
                return httpx.Response(200, json={"data": [{"id": fixture.model}]})

            def post(self, url, *, headers, json):
                self_test.assertEqual(url, jan.DEFAULT_BASE_URL + "/chat/completions")
                self_test.assertEqual(headers["Authorization"], f"Bearer {api_key}")
                self_test.assertEqual(json["model"], fixture.model)
                return httpx.Response(200, json={"choices": [
                    {"message": {"content": "OK"}}]})

        self_test = self
        with patch("backend.ai.providers.local_openai_runtime.httpx.Client", FakeClient), \
                patch("backend.ai.providers.probe_support.httpx.Client", FakeClient):
            self.assertEqual(jan.ADAPTER.list_models(
                api_key=api_key, base_url=jan.DEFAULT_BASE_URL).models, (fixture.model,))
            self.assertTrue(jan.ADAPTER.probe(ProbeRequest(
                model=fixture.model, api_key=api_key,
                base_url=jan.DEFAULT_BASE_URL)).ok)


if __name__ == "__main__":
    unittest.main()
