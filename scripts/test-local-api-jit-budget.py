"""LM Studio JIT and native output budget regressions; mock wire only."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from backend.ai import markers
from backend.ai.clients.base import OutputBudgetExhausted
from backend.ai.provider_contract import GenerationRequest
from backend.ai.provider_resolution import forget_model_capabilities
from backend.ai.providers import local_lmstudio, local_ollama
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.invocation import translate
from backend.ai.translation_paths.mode import descriptor
from backend.ai.workload import WorkloadBudgetError


def sse(*, model="selected", response_id="resp_1", text="<<TP_P0:คำแปล>>",
        output_tokens=30, reasoning_tokens=0, output_parts=None):
    frames = [{"type": "chat.start", "model_instance_id": model},
              {"type": "chat.end", "result": {"model_instance_id": model,
               "response_id": response_id,
               "output": (output_parts if output_parts is not None else
                          ([{"type": "message", "content": text}] if text else
                           [{"type": "reasoning", "content": "<private>"}])),
               "stats": {"input_tokens": 100, "total_output_tokens": output_tokens,
                         "reasoning_output_tokens": reasoning_tokens}}}]
    return "".join(f"event: {frame['type']}\ndata: {json.dumps(frame)}\n\n" for frame in frames)


class LocalJitBudgetTest(unittest.TestCase):
    base = "http://localhost:1234/v1"

    def tearDown(self):
        forget_model_capabilities("lmstudio", self.base, "")

    @staticmethod
    def native_catalogue(*, loaded=False, max_context=32768, options=("off", "on"),
                         runtime_context=16384):
        return {"models": [{"type": "llm", "key": "selected",
            "loaded_instances": ([{"id": "selected", "config": {
                "context_length": runtime_context}}] if loaded else []),
            "max_context_length": max_context,
            "capabilities": {"vision": False, "reasoning": {
                "allowed_options": list(options), "default": options[-1]}}}]}

    def test_first_jit_uses_bounded_window_then_next_uses_verified_loaded_cursor(self):
        requests = []
        state = {"loaded": False}
        real_client = httpx.Client

        def handle(req):
            requests.append(req)
            if req.url.path == "/api/v1/models":
                return httpx.Response(200, json=self.native_catalogue(loaded=state["loaded"]))
            if req.url.path == "/v1/models":
                return httpx.Response(200, json={"data": [{"id": "selected"}]})
            self.assertEqual(req.url.path, "/api/v1/chat")
            payload = json.loads(req.content)
            state["loaded"] = True
            turn = len([r for r in requests if r.url.path == "/api/v1/chat"])
            return httpx.Response(200, text=sse(response_id=f"resp_{turn}"))

        ai = AiConfig(api_key="", provider="lmstudio", model="selected",
            base_url=self.base, thinking="minimum", source_lang="en",
            translation_mode="conversation", conversation=descriptor(
                {"documentId": "jit-bounded-window"}, context={"tp_tab_session": "jit-bounded-window"}))
        forget_model_capabilities("lmstudio", self.base, "")
        with patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
             patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
                 real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            first = translate(markers.apply(["first source"]), "th", ai)
            second = translate(markers.apply(["second source"]), "th", ai)

        chats = [json.loads(r.content) for r in requests if r.url.path == "/api/v1/chat"]
        self.assertEqual(len(chats), 2)
        self.assertEqual(chats[0]["context_length"], 16384)
        self.assertEqual(chats[0]["reasoning"], "off")
        self.assertEqual(chats[1]["previous_response_id"], "resp_1")
        self.assertNotIn("context_length", chats[1])
        self.assertNotIn("system_prompt", chats[1])
        self.assertNotIn("first source", str(chats[1]))
        self.assertEqual(first["meta"]["conversation"]["commitStatus"], "committed")
        self.assertEqual(second["meta"]["conversation"]["historyTurns"], 1)
        self.assertEqual(first["meta"]["model_limits"]["scope"], "requested")
        self.assertEqual(second["meta"]["model_limits"]["scope"], "runtime")
        self.assertEqual([r.url.path for r in requests],
            ["/api/v1/models", "/v1/models", "/api/v1/chat", "/api/v1/models",
             "/api/v1/models", "/api/v1/chat"])

    def test_unlisted_jit_key_never_sends_generation(self):
        calls = []
        real_client = httpx.Client
        def handle(req):
            calls.append(req.url.path)
            if req.url.path == "/api/v1/models":
                return httpx.Response(200, json=self.native_catalogue())
            if req.url.path == "/v1/models":
                return httpx.Response(200, json={"data": [{"id": "another"}]})
            raise AssertionError("generation sent")
        with patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
             patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
                 real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            listed = local_lmstudio.ADAPTER.list_models(api_key="", base_url=self.base)
            self.assertNotIn("selected", listed.models)
            with self.assertRaisesRegex(ValueError, "no available exact instance"):
                translate(markers.apply(["first"]), "th", AiConfig(
                    api_key="", provider="lmstudio", model="selected", base_url=self.base,
                    thinking="minimum", source_lang="en", translation_mode="conversation",
                    conversation=descriptor({"documentId": "jit-not-visible"},
                        context={"tp_tab_session": "jit-not-visible"})))
        self.assertEqual(calls, ["/api/v1/models", "/v1/models",
                                 "/api/v1/models", "/v1/models"])

    def test_jit_mandatory_reasoning_lowest_is_exact_native_on(self):
        real_client = httpx.Client
        def handle(req):
            if req.url.path == "/api/v1/models":
                return httpx.Response(200, json=self.native_catalogue(options=("on",)))
            if req.url.path == "/v1/models":
                return httpx.Response(200, json={"data": [{"id": "selected"}]})
            raise AssertionError("no generation is needed for catalogue and payload validation")
        with patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
            real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            listed = local_lmstudio.ADAPTER.list_models(api_key="", base_url=self.base)
        caps = listed.capabilities["selected"]
        self.assertTrue(caps["reasoning"]["mandatory"])
        self.assertTrue(caps["reasoning"]["default_enabled"])
        req = GenerationRequest(provider="lmstudio", model="selected",
            system_text="system", user_parts=("<<I1_P0:source>>",), thinking="on",
            model_capabilities=caps, cache_context={"translationMode": "conversation",
                "reasoningCapabilityVerified": True,
                "providerThinkingPreference": "minimum"})
        body, applied = local_lmstudio.ADAPTER.prepare_native_payload(req)
        self.assertEqual((body["reasoning"], applied), ("on", "requested_on"))
        self.assertEqual(body["context_length"], 16384)

    def test_jit_result_with_smaller_loaded_window_is_not_retained(self):
        state = {"loaded": False}
        real_client = httpx.Client
        def handle(req):
            if req.url.path == "/api/v1/models":
                return httpx.Response(200, json=self.native_catalogue(
                    loaded=state["loaded"], runtime_context=8192))
            if req.url.path == "/v1/models":
                return httpx.Response(200, json={"data": [{"id": "selected"}]})
            self.assertEqual(req.url.path, "/api/v1/chat")
            state["loaded"] = True
            return httpx.Response(200, text=sse())
        ai = AiConfig(api_key="", provider="lmstudio", model="selected",
            base_url=self.base, thinking="minimum", source_lang="en",
            translation_mode="conversation", conversation=descriptor(
                {"documentId": "jit-shrunk-window"}, context={"tp_tab_session": "jit-shrunk-window"}))
        with patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
             patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
                 real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            with self.assertRaises(Exception) as caught:
                translate(markers.apply(["first"]), "th", ai)
        self.assertEqual(caught.exception.code, "ai_conversation_native_transcript_invalid")
        self.assertEqual(caught.exception.generationMeta["usage"]["outputTokens"], 30)

    def test_jit_context_budget_rejects_before_chat(self):
        req = GenerationRequest(provider="lmstudio", model="selected",
            system_text="X" * 20000, user_parts=("<<I1_P0:source>>",),
            thinking="off", model_capabilities={"limits": {"contextTokens": 8192,
                "source": "lmstudio_native_jit_catalogue", "scope": "requested"},
                "reasoning": {"supported": True, "control": "toggle",
                              "supported_efforts": ["off", "on"]}},
            workload={"version": 1, "predictedOutput": 100, "reasoningReserve": 2000},
            cache_context={"translationMode": "conversation", "reasoningCapabilityVerified": True})
        with self.assertRaises(WorkloadBudgetError):
            local_lmstudio.ADAPTER.prepare_native_payload(req)

    def test_no_visible_text_at_output_limit_keeps_usage_and_is_budget_error(self):
        req = GenerationRequest(provider="lmstudio", model="selected",
            system_text="system", user_parts=("<<I1_P0:source>>",),
            thinking="default", cache_context={"translationMode": "conversation"})
        real_client = httpx.Client
        def handle(wire):
            body = json.loads(wire.content)
            return httpx.Response(200, text=sse(text="", output_tokens=body["max_output_tokens"],
                                                 reasoning_tokens=body["max_output_tokens"]))
        with patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
            real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            with self.assertRaises(OutputBudgetExhausted) as caught:
                local_lmstudio.ADAPTER.generate(req)
        usage = caught.exception.structural_details["generationMeta"]["usage"]
        self.assertEqual(usage["thinkingTokens"], usage["outputTokens"])
        self.assertTrue(caught.exception.structural_details["reasoningOnlyExhausted"])
        self.assertEqual(caught.exception.structural_details["validatorSubtype"],
                         "reasoning_only_exhausted")
        self.assertEqual(caught.exception.structural_details["requestedOutputTokens"],
                         usage["outputTokens"])

    def test_lmstudio_empty_length_without_reasoning_is_typed_empty_output(self):
        req = GenerationRequest(provider="lmstudio", model="selected",
            system_text="system", user_parts=("<<I1_P0:source>>",),
            thinking="default", cache_context={"translationMode": "conversation"})
        real_client = httpx.Client
        def handle(wire):
            body = json.loads(wire.content)
            return httpx.Response(200, text=sse(text="", output_tokens=body["max_output_tokens"],
                reasoning_tokens=0, output_parts=[{"type": "message", "content": ""}]))
        with patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
            real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            with self.assertRaises(OutputBudgetExhausted) as caught:
                local_lmstudio.ADAPTER.generate(req)
        self.assertNotIn("reasoningOnlyExhausted", caught.exception.structural_details)
        self.assertEqual(caught.exception.structural_details["validatorSubtype"],
                         "empty_output")
        self.assertEqual(caught.exception.structural_details["requestedOutputTokens"],
                         caught.exception.structural_details["generationMeta"]["usage"]["outputTokens"])

    def test_ollama_reasoning_only_length_has_exact_evidence_for_repair_planner(self):
        real_client = httpx.Client
        def handle(wire):
            body = json.loads(wire.content)
            limit = body["options"]["num_predict"]
            frames = [{"message": {"thinking": "private"}, "done": False},
                      {"message": {"content": ""}, "done": True,
                       "done_reason": "length", "prompt_eval_count": 90,
                       "eval_count": limit}]
            return httpx.Response(200, text="\n".join(json.dumps(x) for x in frames) + "\n")
        with patch.object(local_ollama.httpx, "Client", side_effect=lambda *, timeout:
            real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            with self.assertRaises(OutputBudgetExhausted) as caught:
                local_ollama.generate("http://localhost:11434", "selected", "system",
                    ["<<I1_P0:source>>"], expected_ids=["I1_P0"])
        details = caught.exception.structural_details
        self.assertTrue(details["reasoningOnlyExhausted"])
        self.assertEqual(details["validatorSubtype"], "reasoning_only_exhausted")
        self.assertEqual(details["requestedOutputTokens"],
                         details["generationMeta"]["usage"]["outputTokens"])

    def test_ollama_empty_length_without_reasoning_is_typed_but_visible_partial_is_not(self):
        real_client = httpx.Client
        for content, subtype in (("", "empty_output"), ("partial answer", None)):
            with self.subTest(visible=bool(content)):
                def handle(wire):
                    limit = json.loads(wire.content)["options"]["num_predict"]
                    frames = [{"message": {"content": content}, "done": True,
                               "done_reason": "length", "prompt_eval_count": 90,
                               "eval_count": limit}]
                    return httpx.Response(200, text="\n".join(json.dumps(x) for x in frames) + "\n")
                with patch.object(local_ollama.httpx, "Client", side_effect=lambda *, timeout:
                        real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
                    with self.assertRaises(OutputBudgetExhausted) as caught:
                        local_ollama.generate("http://localhost:11434", "selected", "system",
                            ["<<I1_P0:source>>"], expected_ids=["I1_P0"])
                details = caught.exception.structural_details
                self.assertEqual(details.get("validatorSubtype"), subtype)
                self.assertNotIn("reasoningOnlyExhausted", details)
                self.assertEqual(details["generationMeta"]["usage"]["inputTokens"], 90)


if __name__ == "__main__":
    unittest.main()
