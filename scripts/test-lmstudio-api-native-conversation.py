"""Mock native LM Studio; run with PYTHONPATH=api python scripts/test-lmstudio-api-native-conversation.py."""
from __future__ import annotations

import json
import os
import sys
import types
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from dataclasses import replace
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from backend.ai.clients.base import ChatResult
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import local_lmstudio, local_ollama
from backend.ai.providers.local_lmstudio import ADAPTER
from backend.ai.transports import lmstudio_native
from backend.ai.translation_paths import conversation, store
from backend.ai import markers, wire_trace
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.invocation import translate
from backend.ai.translation_paths.mode import descriptor
from backend.ai.provider_resolution import forget_model_capabilities
from backend.ai.provider_contract import ProbeRequest


def request(*, text="<<I1_P0:SOURCE>>", prior="", thinking="off"):
    history = ({"role": "user", "text": "OLD_SOURCE"},
               {"role": "assistant", "text": "OLD_TRANSLATION"}) if prior else ()
    return GenerationRequest(provider="lmstudio", model="selected", system_text="SYSTEM_FIXED",
        user_parts=(text,), base_url="http://localhost:1234/v1", thinking=thinking,
        model_capabilities={"reasoning": {"supported": True, "control": "levels",
                                          "supported_efforts": ["off", "low"]}},
        cache_context={"translationMode": "conversation", "reasoningCapabilityVerified": True}, history_messages=history,
        previous_response_id=prior, expected_ids=("I1_P0",), unit_count=1)


def events(*, response_id="resp_ok", model="selected", terminal=True, error=False,
           reasoning_tokens=0, answer="<<I1_P0:Thai>>"):
    data = [{"type": "chat.start", "model_instance_id": model},
            {"type": "message.delta", "content": answer}]
    if error:
        data.append({"type": "error", "error": {"type": "internal_error", "message": "generation failed"}})
    if terminal:
        stats = {"input_tokens": 100, "total_output_tokens": 20}
        if reasoning_tokens is not None:
            stats["reasoning_output_tokens"] = reasoning_tokens
        result = {"model_instance_id": model,
            "output": [{"type": "message", "content": answer}], "stats": stats}
        if response_id is not None:
            result["response_id"] = response_id
        data.append({"type": "chat.end", "result": result})
    return "".join("event: " + item["type"] + "\ndata: " + json.dumps(item) + "\n\n" for item in data)


class NativeConversationTest(unittest.TestCase):
    def test_public_error_maps_local_off_preflight_and_native_invalid_output(self):
        try:
            from fastapi import HTTPException
        except ModuleNotFoundError:
            fake = types.ModuleType("fastapi")
            class HTTPException(Exception):
                def __init__(self, status_code, detail, headers=None):
                    self.status_code, self.detail, self.headers = status_code, detail, headers
            fake.HTTPException = HTTPException
            fake.Request = object
            with patch.dict(sys.modules, {"fastapi": fake}):
                from backend.application.ai_translation import provider_errors
        else:
            from backend.application.ai_translation import provider_errors
        ctx = SimpleNamespace(unit_count=1, char_count=10, trace_id="test", correlation={},
            route_identity={}, requested_route="/fixture", rate={"enabled":False}, unlimited=False,
            config=SimpleNamespace(provider="lmstudio", model="selected", api_key="", image_b64=""),
            resolved_provider="lmstudio", resolved_model="selected")
        unsupported = store.ConversationError("native Thinking unavailable")
        unsupported.code = "ai_local_thinking_unsupported"
        cursor_before = store.ConversationError("accepted turn lacks provider cursor")
        cursor_before.code = "ai_conversation_cursor_missing"
        from backend.ai.clients.base import provider_output_error
        bad_output = provider_output_error("LM Studio returned unusable transcript",
            provider="lmstudio", model="selected", input_tokens=10, output_tokens=3,
            total_tokens=13, finish_reason=None, provider_ms=1, parse_ms=0,
            timeout_policy="native", usage_details={"inputTokens":10,"outputTokens":3})
        bad_output.code = "ai_conversation_native_transcript_invalid"
        cursor_after = provider_output_error("provider reply missing cursor",
            provider="lmstudio", model="selected", input_tokens=10, output_tokens=3,
            total_tokens=13, finish_reason=None, provider_ms=1, parse_ms=0,
            timeout_policy="native", usage_details={"inputTokens":10,"outputTokens":3})
        cursor_after.code = "ai_conversation_cursor_missing"
        with patch.object(provider_errors, "trace_failure"), patch.object(provider_errors,"failure_event"):
            for source, status, code, attempts in ((unsupported,409,"ai_local_thinking_unsupported",0),
                    (cursor_before,409,"ai_conversation_cursor_missing",0),
                    (bad_output,502,"ai_conversation_native_transcript_invalid",1),
                    (cursor_after,502,"ai_conversation_cursor_missing",1)):
                with self.subTest(code=code), self.assertRaises(HTTPException) as raised:
                    provider_errors.raise_execution_error(ctx, source,
                        rate_wait_ms=0, admission_wait_ms=0, provider_ms=1)
                self.assertEqual(raised.exception.status_code,status)
                detail = raised.exception.detail
                self.assertEqual(detail["code"],code)
                self.assertEqual(detail["providerAttempts"],attempts)
                self.assertIs(detail["requestDispatched"], bool(attempts))

    @staticmethod
    def model_catalogue(*, options=("off", "on"), loaded=True, exact=True):
        return {"models": [
            {"type":"embedding", "key":"selected", "loaded_instances":[{"id":"embedding-selected"}]},
            {"type":"llm", "key":"selected", "loaded_instances": ([{
                "id":"selected" if exact else "other-instance",
                "config":{"context_length":65536}}] if loaded else []),
             "capabilities":{"vision":True,"reasoning":{"allowed_options":list(options),"default":"on"}}},
        ]}

    def test_metadata_discovery_exact_instance_probe_and_first_use_conversation(self):
        from backend.ai.provider_resolution import discovered_model_capabilities
        base = "http://localhost:1234/v1"
        forget_model_capabilities("lmstudio", base, "")

        calls = []
        original = httpx.Client
        def handle(req):
            calls.append(req)
            if req.method == "GET":
                self.assertEqual(req.url.path, "/api/v1/models")
                return httpx.Response(200, json=self.model_catalogue())
            self.assertEqual(req.url.path, "/api/v1/chat")
            self.assertEqual(req.method, "POST")
            sequence = len([call for call in calls if call.method == "POST"])
            return httpx.Response(200, text=events(response_id=f"resp_{sequence}",
                answer="<<TP_P0:คำแปล>>"))
        with patch.dict(os.environ,{"TP_USAGE_RECEIPTS":"off", "TP_AI_WIRE_TRACE":"0"}), \
             patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
             patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
                original(transport=httpx.MockTransport(handle), timeout=timeout)):
            self.assertEqual(discovered_model_capabilities("lmstudio", base, "selected"), (False, {}))
            probed = ADAPTER.probe(ProbeRequest(model="selected", base_url=base))
            self.assertTrue(probed.ok)
            self.assertEqual(probed.capabilities["reasoning"]["supported_efforts"], ["off", "on"])
            calls.clear()
            ai = AiConfig(api_key="", provider="lmstudio", model="selected", base_url=base,
                thinking="minimum", source_lang="en", memory_mode="off",
                translation_mode="conversation", prompt_mode="replace",
                conversation=descriptor({"documentId":"lmstudio-native-first-use"},
                    context={"tp_tab_session":"fixture-first-use"}),
                model_capabilities={"reasoning":{"supported":False}})
            first = translate(markers.apply(["First source"]), "th", ai)
            second = translate(markers.apply(["Second source"]), "th", ai)
        self.assertEqual([r["meta"]["conversation"]["commitStatus"] for r in (first,second)],
                         ["committed", "committed"])
        self.assertEqual(second["meta"]["conversation"]["historyTurns"], 1)
        self.assertEqual(first["meta"]["thinking_selected"], "off")
        self.assertEqual([call.method for call in calls], ["GET", "POST", "GET", "POST"])
        first_payload, second_payload = [json.loads(call.content) for call in calls if call.method == "POST"]
        self.assertEqual(first_payload["reasoning"], "off")
        self.assertTrue(first_payload["system_prompt"])
        self.assertEqual(second_payload["previous_response_id"], "resp_1")
        self.assertNotIn("system_prompt", second_payload)
        self.assertNotIn("First source", str(second_payload))
        forget_model_capabilities("lmstudio", base, "")

    def test_independent_two_native_turns_repeat_only_system_and_current_user(self):
        base = "http://localhost:1234/v1"
        real_client = httpx.Client
        calls = []
        for preference in ("off", "minimum"):
            with self.subTest(preference=preference):
                forget_model_capabilities("lmstudio", base, "")
                calls.clear()
                def handle(req):
                    calls.append(req)
                    if req.method == "GET":
                        self.assertEqual(req.url.path, "/api/v1/models")
                        return httpx.Response(200, json=self.model_catalogue())
                    self.assertEqual(req.url.path, "/api/v1/chat")
                    return httpx.Response(200, text=events(response_id=None,
                        answer="<<TP_P0:คำแปล>>"))
                ai = AiConfig(api_key="", provider="lmstudio", model="selected",
                    base_url=base, thinking=preference, source_lang="en",
                    translation_mode="independent", output_contract="compact_markers_v1")
                with patch.dict(os.environ, {"TP_USAGE_RECEIPTS":"off", "TP_AI_WIRE_TRACE":"0"}), \
                     patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
                     patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
                         real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
                    first = translate(markers.apply(["First source"]), "th", ai, capture_request=True)
                    second = translate(markers.apply(["Second source"]), "th", ai, capture_request=True)
                payloads = [json.loads(req.content) for req in calls if req.method == "POST"]
                self.assertEqual([req.method for req in calls], ["GET", "POST", "GET", "POST"])
                self.assertEqual(len(payloads), 2)
                for payload in payloads:
                    self.assertIs(payload["store"], False)
                    self.assertEqual(payload["reasoning"], "off")
                    self.assertIn("system_prompt", payload)
                    self.assertNotIn("previous_response_id", payload)
                self.assertIn("First source", payloads[0]["input"])
                self.assertIn("Second source", payloads[1]["input"])
                self.assertNotIn("First source", str(payloads[1]))
                self.assertEqual(first["meta"]["translationMode"], "independent")
                self.assertEqual(second["meta"]["translationMode"], "independent")
                self.assertIn("คำแปล", second["aiTextFull"])
                self.assertEqual(second["meta"]["usage"]["inputTokens"], 100)
        forget_model_capabilities("lmstudio", base, "")

    def test_independent_unknown_lowest_and_unavailable_model_stop_before_chat(self):
        base = "http://localhost:1234/v1"
        real_client = httpx.Client
        unknown = self.model_catalogue()
        del unknown["models"][1]["capabilities"]["reasoning"]
        for catalogue, preference, error in (
            (unknown, "minimum", "lowest Thinking"),
            (self.model_catalogue(options=("low", "medium")), "off", "cannot verify"),
            (self.model_catalogue(loaded=False), "minimum", "no available exact instance"),
        ):
            with self.subTest(preference=preference, catalogue=catalogue):
                forget_model_capabilities("lmstudio", base, "")
                calls = []
                def handle(req):
                    calls.append(req)
                    self.assertEqual(req.method, "GET")
                    return httpx.Response(200, json=catalogue)
                ai = AiConfig(api_key="", provider="lmstudio", model="selected", base_url=base,
                    thinking=preference, source_lang="en", translation_mode="independent",
                    output_contract="compact_markers_v1")
                with patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
                     patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
                         real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
                    with self.assertRaisesRegex(Exception, error):
                        translate(markers.apply(["source"]), "th", ai)
                self.assertTrue(calls)
                self.assertTrue(all(call.method == "GET" for call in calls))
        forget_model_capabilities("lmstudio", base, "")

    def test_independent_mandatory_lowest_uses_verified_native_low(self):
        base = "http://localhost:1234/v1"
        forget_model_capabilities("lmstudio", base, "")
        sent = []
        real_client = httpx.Client
        def handle(req):
            if req.method == "GET":
                return httpx.Response(200, json=self.model_catalogue(options=("low","medium")))
            sent.append(json.loads(req.content))
            return httpx.Response(200, text=events(response_id=None, answer="<<TP_P0:คำแปล>>"))
        ai = AiConfig(api_key="", provider="lmstudio", model="selected", base_url=base,
            thinking="minimum", source_lang="en", translation_mode="independent",
            output_contract="compact_markers_v1")
        with patch.dict(os.environ,{"TP_USAGE_RECEIPTS":"off", "TP_AI_WIRE_TRACE":"0"}), \
             patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
             patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
                 real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            result = translate(markers.apply(["source"]), "th", ai)
        self.assertEqual(result["meta"]["thinking_selected"], "low")
        self.assertEqual(result["meta"]["thinking_applied"], "requested_low")
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["reasoning"], "low")
        self.assertIs(sent[0]["store"], False)
        forget_model_capabilities("lmstudio", base, "")

    def test_independent_stale_schema_hint_uses_native_markers_or_fails_planned_schema(self):
        base = "http://localhost:1234/v1"
        forget_model_capabilities("lmstudio", base, "")
        posted = []
        real_client = httpx.Client
        def handle(req):
            if req.method == "GET":
                return httpx.Response(200, json=self.model_catalogue())
            posted.append(json.loads(req.content))
            return httpx.Response(200, text=events(response_id=None, answer="<<TP_P0:คำแปล>>"))
        ai = AiConfig(api_key="", provider="lmstudio", model="selected", base_url=base,
            thinking="off", source_lang="en", translation_mode="independent",
            model_capabilities={"structured_output":{"supported":True}})
        with patch.dict(os.environ,{"TP_USAGE_RECEIPTS":"off", "TP_AI_WIRE_TRACE":"0"}), \
             patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
             patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
                 real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            result = translate(markers.apply(["source"]), "th", ai)
            self.assertEqual(result["meta"]["selected_contract"], "compact_markers_v1")
            self.assertEqual(result["meta"]["contract_selection_reason"],
                             "lmstudio_native_marker_contract")
            self.assertEqual(len(posted), 1)
            self.assertNotIn("response_format", posted[0])
            planned = replace(ai, output_contract="json_schema_object_v1")
            with self.assertRaisesRegex(Exception, "planned JSON schema"):
                translate(markers.apply(["next source"]), "th", planned)
            self.assertEqual(len(posted), 1)
        forget_model_capabilities("lmstudio", base, "")

    def test_independent_jit_first_use_proves_loaded_context_then_stays_stateless(self):
        base = "http://localhost:1234/v1"
        forget_model_capabilities("lmstudio", base, "")
        state = {"loaded": False}
        calls = []
        real_client = httpx.Client
        def handle(req):
            calls.append(req)
            if req.url.path == "/api/v1/models":
                row = {"type":"llm", "key":"selected",
                    "loaded_instances": ([{"id":"selected", "config":{"context_length":16384}}]
                                         if state["loaded"] else []),
                    "max_context_length":32768,
                    "capabilities":{"vision":False,
                        "reasoning":{"allowed_options":["off","low"], "default":"low"}}}
                return httpx.Response(200, json={"models":[row]})
            if req.url.path == "/v1/models":
                return httpx.Response(200, json={"data":[{"id":"selected"}]})
            self.assertEqual(req.url.path, "/api/v1/chat")
            state["loaded"] = True
            return httpx.Response(200, text=events(response_id=None, answer="<<TP_P0:คำแปล>>"))
        ai = AiConfig(api_key="", provider="lmstudio", model="selected",
            base_url=base, thinking="minimum", source_lang="en",
            translation_mode="independent", output_contract="compact_markers_v1")
        with patch.dict(os.environ,{"TP_USAGE_RECEIPTS":"off", "TP_AI_WIRE_TRACE":"0"}), \
             patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
             patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
                 real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            first = translate(markers.apply(["First"]), "th", ai)
            second = translate(markers.apply(["Second"]), "th", ai)
        chats = [json.loads(req.content) for req in calls if req.method == "POST"]
        self.assertEqual(len(chats), 2)
        self.assertEqual(chats[0]["context_length"], 16384)
        self.assertNotIn("context_length", chats[1])
        self.assertEqual(chats[0]["reasoning"], "off")
        self.assertEqual(chats[1]["reasoning"], "off")
        self.assertTrue(all(chat["store"] is False and "previous_response_id" not in chat
                            and chat.get("system_prompt") for chat in chats))
        self.assertEqual(first["meta"]["model_limits"]["scope"], "requested")
        self.assertEqual(second["meta"]["model_limits"]["scope"], "runtime")
        forget_model_capabilities("lmstudio", base, "")

    def test_native_trace_truthfully_labels_linked_system_and_hides_cursor(self):
        base="http://localhost:1234/v1"
        forget_model_capabilities("lmstudio",base,"")
        sent=[]
        original=httpx.Client
        def handle(req):
            if req.method=="GET":
                return httpx.Response(200,json=self.model_catalogue())
            sent.append(json.loads(req.content))
            return httpx.Response(200,text=events(response_id=f"resp_{len(sent)}",
                answer="<<TP_P0:Thai>>"))
        ai=AiConfig(api_key="",provider="lmstudio",model="selected",base_url=base,
            thinking="minimum",translation_mode="conversation",source_lang="en",
            conversation=descriptor({"documentId":"native-wire-truth"},
                context={"tp_tab_session":"native-wire-truth"}))
        with tempfile.TemporaryDirectory() as temp, \
             patch.dict(os.environ,{"TP_AI_WIRE_TRACE":"1", "TP_AI_WIRE_TRACE_DIR":temp,
                                 "TP_USAGE_RECEIPTS":"off"}), \
             patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
             patch.object(local_lmstudio.httpx,"Client",side_effect=lambda *,timeout:
                 original(transport=httpx.MockTransport(handle),timeout=timeout)):
            folders=[]
            for turn in (1,2):
                identity={"traceId":"lm-wire","operationId":f"native-turn-{turn}"}
                token=wire_trace.begin(identity)
                folders.append(Path(temp)/wire_trace.folder_name(identity))
                try:
                    response=translate(markers.apply([f"source {turn}"]),"th",ai,
                                       capture_request=True)
                finally:
                    wire_trace.end(token)
                self.assertEqual(response["meta"]["conversation"]["commitStatus"],"committed")
            first,linked=folders
            actual_first=json.loads((first/"04_provider_request.json").read_text())["body"]
            actual_linked=json.loads((linked/"04_provider_request.json").read_text())["body"]
            self.assertEqual(actual_first["system_prompt"],sent[0]["system_prompt"])
            self.assertNotIn("system_prompt",actual_linked)
            self.assertEqual(actual_linked["previous_response_id"],"<private>")
            self.assertEqual(sent[1]["previous_response_id"],"resp_1")
            self.assertNotIn(sent[0]["system_prompt"],(linked/"02_system_prompt.txt").read_text())
            self.assertEqual(response["meta"]["debug_request"]["system_text"],"")
            self.assertIn("assembled_system_text",response["meta"]["debug_request"])
            self.assertNotIn("resp_1", "\n".join(p.read_text() for p in linked.iterdir() if p.is_file()))
        forget_model_capabilities("lmstudio",base,"")
    def test_missing_stale_or_ambiguous_instance_has_no_generation(self):
        from backend.ai.provider_resolution import discovered_model_capabilities
        from backend.ai.translation_paths.store import ConversationError
        base = "http://localhost:1234/v1"
        original = httpx.Client
        for catalogue in (self.model_catalogue(loaded=False), self.model_catalogue(exact=False),
                          {"models":[*self.model_catalogue()["models"], self.model_catalogue()["models"][1]]}):
            with self.subTest(catalogue=catalogue):
                forget_model_capabilities("lmstudio", base, "")
                calls = []
                def handle(req):
                    calls.append(req)
                    if req.method != "GET":
                        raise AssertionError("unexpected generation")
                    return httpx.Response(200, json=catalogue)
                with patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
                     patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
                                  original(transport=httpx.MockTransport(handle),timeout=timeout)):
                    listed = ADAPTER.list_models(api_key="", base_url=base)
                    self.assertFalse(listed.capabilities.get("selected",{}).get("reasoning"))
                    with self.assertRaisesRegex(ValueError, "no available exact instance"):
                        translate(markers.apply(["Hello"]),"th",AiConfig(api_key="", provider="lmstudio",
                            model="selected", base_url=base, thinking="minimum", source_lang="en",
                            translation_mode="conversation", conversation=descriptor(
                                {"documentId":"missing-exact"},context={"tp_tab_session":"missing"})))
                self.assertTrue(calls)
                self.assertTrue(all(call.method == "GET" for call in calls))
                self.assertEqual(discovered_model_capabilities("lmstudio", base, "selected")[1].get("reasoning"), None)
        forget_model_capabilities("lmstudio", base, "")
    def native(self, *requests, response=events()):
        sent, traced = [], []
        actual_client = httpx.Client
        def handle(r):
            sent.append(json.loads(r.content))
            return httpx.Response(200, text=response)
        def client(*, timeout):
            return actual_client(transport=httpx.MockTransport(handle), timeout=timeout)
        with patch.object(lmstudio_native.httpx, "Client", side_effect=client), \
             patch.object(lmstudio_native.wire_trace, "provider_request", side_effect=lambda **kw: traced.append(kw)), \
             patch.object(lmstudio_native.wire_trace, "append_text", side_effect=lambda name, data: traced.append(data)):
            results = [ADAPTER.generate(item) for item in requests]
        return sent, traced, results

    def test_first_then_linked_minimal_request_and_accounting(self):
        sent, traced, results = self.native(request(), request(text="<<I1_P0:NEW>>", prior="resp_first"))
        self.assertEqual(len(sent), 2)
        self.assertEqual(sent[0]["system_prompt"], "SYSTEM_FIXED")
        self.assertEqual(sent[0]["reasoning"], "off")
        self.assertTrue(sent[0]["store"])
        self.assertNotIn("previous_response_id", sent[0])
        self.assertEqual(sent[1]["previous_response_id"], "resp_first")
        self.assertEqual(sent[1]["input"], "<<I1_P0:NEW>>")
        self.assertNotIn("system_prompt", sent[1])
        self.assertNotIn("OLD_SOURCE", str(sent[1]))
        self.assertEqual(results[1].provider_response_id, "resp_ok")
        self.assertEqual((results[1].input_tokens, results[1].output_tokens, results[1].thinking_tokens),
                         (100, 20, 0))
        self.assertTrue(results[1].terminal_completed)
        self.assertEqual(results[1].thinking_applied, "requested_off")
        self.assertNotIn("resp_first", str(traced))
        self.assertNotIn("resp_ok", str(traced))

    def test_image_input_and_optional_native_auth_token(self):
        sent = []
        actual_client = httpx.Client
        def handle(r):
            sent.append(r)
            return httpx.Response(200, text=events())
        pictured = replace(request(), image_b64="aGVsbG8=", image_mime="image/png",
            api_key="secret-native-token")
        with patch.object(lmstudio_native.httpx, "Client", side_effect=lambda *, timeout:
                          actual_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            ADAPTER.generate(pictured)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0].headers["Authorization"], "Bearer secret-native-token")
        self.assertEqual(sent[0].url.path, "/api/v1/chat")
        body = json.loads(sent[0].content)
        self.assertEqual(body["input"], [
            {"type": "image", "data_url": "data:image/png;base64,aGVsbG8="},
            {"type": "text", "content": "<<I1_P0:SOURCE>>"}])

    def test_no_terminal_or_wrong_model_cannot_advance(self):
        for content in (events(terminal=False), events(model="another"), events(error=True)):
            with self.subTest(content=content[:100]):
                with self.assertRaises(Exception):
                    self.native(request(), response=content)

    def test_provider_reasoning_counter_overrides_off_request(self):
        sent = []
        actual_client = httpx.Client
        def handle(r):
            sent.append(r)
            return httpx.Response(200, text=events(reasoning_tokens=3))
        with patch.object(lmstudio_native.httpx, "Client", side_effect=lambda *, timeout:
                          actual_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            with self.assertRaisesRegex(Exception, "reasoning content or tokens despite") as raised:
                ADAPTER.generate(request())
        self.assertEqual(len(sent), 1)
        self.assertEqual(getattr(raised.exception, "code", ""), "ai_local_thinking_violated")
        _, _, results = self.native(request(), response=events(reasoning_tokens=None))
        self.assertEqual(results[0].thinking_applied, "requested_off_usage_unreported")

    def test_native_reasoning_delta_and_final_reasoning_are_private_and_off_rejects(self):
        frames = [
            {"type":"chat.start","model_instance_id":"selected"},
            {"type":"reasoning.start"},
            {"type":"reasoning.delta","content":"PRIVATE_REASONING_DELTA"},
            {"type":"message.delta","content":"<<I1_P0:Thai>>"},
            {"type":"chat.end","result":{"model_instance_id":"selected",
              "response_id":"resp_seen","output":[
                  {"type":"reasoning","content":"PRIVATE_FINAL_REASONING"},
                  {"type":"message","content":"<<I1_P0:Thai>>"}],
              "stats":{"input_tokens":100,"total_output_tokens":20}}},
        ]
        stream = "".join("event: " + item["type"] + "\ndata: " + json.dumps(item) + "\n\n"
                         for item in frames)
        original = httpx.Client
        calls, traced = [], []
        def handle(req):
            calls.append(req)
            return httpx.Response(200,text=stream)
        with patch.object(lmstudio_native.httpx,"Client",side_effect=lambda *, timeout:
                    original(transport=httpx.MockTransport(handle),timeout=timeout)), \
             patch.object(lmstudio_native.wire_trace,"append_text",
                          side_effect=lambda name,value:traced.append(str(value))):
            with self.assertRaisesRegex(Exception,"reasoning content or tokens despite") as raised:
                ADAPTER.generate(request())
            self.assertEqual(raised.exception.code,"ai_local_thinking_violated")
            self.assertEqual(raised.exception.structural_details["generationMeta"]
                             ["usage"]["inputTokens"],100)
            plain = replace(request(),model_capabilities={"reasoning":{"supported":False}})
            with self.assertRaises(Exception) as unreasoning:
                ADAPTER.generate(plain)
            self.assertEqual(unreasoning.exception.code,"ai_local_thinking_violated")
            self.assertNotIn("reasoning",json.loads(calls[-1].content))
            accepted = ADAPTER.generate(request(thinking="low"))
            self.assertEqual(accepted.provider_response_id,"resp_seen")
        self.assertEqual(len(calls),3)
        self.assertNotIn("PRIVATE_REASONING_DELTA",str(traced))
        self.assertNotIn("PRIVATE_FINAL_REASONING",str(traced))

    def test_provider_http_error_cannot_expose_private_cursor(self):
        actual_client = httpx.Client
        def handle(_):
            return httpx.Response(404, json={"error":{"type":"not_found",
                "message":"response resp_private123 not found"}})
        with patch.object(lmstudio_native.httpx, "Client", side_effect=lambda *, timeout:
                          actual_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            with self.assertRaises(Exception) as failure:
                ADAPTER.generate(request(prior="resp_private123"))
        self.assertIn("404", str(failure.exception))
        self.assertNotIn("resp_private123", str(failure.exception))

    def test_chat_end_does_not_wait_for_socket_eof(self):
        class NeverReadPastTerminal(httpx.SyncByteStream):
            def __iter__(self):
                yield events().encode()
                raise AssertionError("the stream was read after chat.end")
        actual_client = httpx.Client
        def handle(_):
            return httpx.Response(200, stream=NeverReadPastTerminal())
        with patch.object(lmstudio_native.httpx, "Client", side_effect=lambda *, timeout:
                          actual_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            result = ADAPTER.generate(request())
        self.assertTrue(result.terminal_completed)
        self.assertEqual(result.provider_response_id, "resp_ok")

    def test_unverified_off_fails_before_request(self):
        with self.assertRaisesRegex(Exception, "verified native control"):
            ADAPTER.generate(replace(request(), model_capabilities={}))
        with self.assertRaisesRegex(Exception, "validated provider cursor"):
            ADAPTER.generate(replace(request(), history_messages=({"role":"user","text":"old"},)))
        simple = replace(request(), model_capabilities={"reasoning": {"supported": False}})
        payload, applied = ADAPTER.prepare_native_payload(simple)
        self.assertNotIn("reasoning", payload)
        self.assertEqual(applied, "not_applicable_non_reasoning_model")

    def test_unresolved_minimum_uses_default_but_clamped_off_sends_zero_requests(self):
        minimum = replace(request(thinking="default"), model_capabilities={},
            cache_context={"translationMode":"conversation", "providerThinkingPreference":"minimum",
                           "reasoningCapabilityVerified":True})
        clamped = replace(request(thinking="low"),
            model_capabilities={"reasoning":{"supported":True,"mandatory":True,
                "control":"levels","supported_efforts":["low"]}},
            cache_context={"translationMode":"conversation", "providerThinkingPreference":"off",
                           "reasoningCapabilityVerified":True})
        with patch.object(local_lmstudio, "execute_lmstudio_chat",
                          return_value=ChatResult("text", "selected")) as dispatch:
            result = ADAPTER.generate(minimum)
            self.assertEqual(result.thinking_applied, "provider_managed_unverified")
            self.assertNotIn("reasoning", dispatch.call_args.kwargs["payload"])
            dispatch.reset_mock()
            with self.assertRaisesRegex(store.ConversationError, "cannot verify"):
                ADAPTER.generate(clamped)
            dispatch.assert_not_called()

    def test_independent_uses_native_thinking_off_without_storing_history(self):
        independent = replace(request(), cache_context={"thinkingRequested":"off", "reasoningCapabilityVerified":True})
        minimum = replace(request(thinking="default"), model_capabilities={},
            cache_context={"thinkingRequested":"minimum", "reasoningCapabilityVerified":True})
        with patch.object(local_lmstudio, "execute_lmstudio_chat",
                          return_value=ChatResult("text", "selected")) as dispatch:
            result = ADAPTER.generate(independent)
            self.assertEqual(result.thinking_applied, "requested_off_usage_unreported")
            self.assertEqual(dispatch.call_args.kwargs["payload"]["reasoning"], "off")
            self.assertIs(dispatch.call_args.kwargs["payload"]["store"], False)
            self.assertNotIn("previous_response_id", dispatch.call_args.kwargs["payload"])
            dispatch.reset_mock()
            with self.assertRaisesRegex(store.ConversationError, "lowest Thinking"):
                ADAPTER.generate(minimum)
            dispatch.assert_not_called()
            plain = replace(independent, model_capabilities={"reasoning":{"supported":False}})
            self.assertEqual(ADAPTER.generate(plain).thinking_applied,
                             "not_applicable_non_reasoning_model")
            self.assertNotIn("reasoning", dispatch.call_args.kwargs["payload"])
            dispatch.reset_mock()
            cursor = replace(independent, previous_response_id="resp_private")
            with self.assertRaisesRegex(ValueError, "cannot send conversation history"):
                ADAPTER.generate(cursor)
            dispatch.assert_not_called()

    def test_native_store_false_accepts_no_cursor_but_store_true_requires_it(self):
        independent = replace(request(), cache_context={"translationMode":"independent",
            "thinkingRequested":"off", "reasoningCapabilityVerified":True})
        sent, _, results = self.native(independent, response=events(response_id=None))
        self.assertEqual(sent[0]["store"], False)
        self.assertNotIn("previous_response_id", sent[0])
        self.assertEqual(results[0].provider_response_id, "")
        self.assertEqual((results[0].input_tokens, results[0].output_tokens), (100,20))
        for item, response in ((request(), events(response_id=None)),
                               (independent, events(response_id="resp_unexpected"))):
            with self.subTest(stored=item.cache_context.get("translationMode")), \
                 self.assertRaisesRegex(Exception, "stored response ID"):
                self.native(item, response=response)

    def test_independent_observed_thinking_violation_has_one_request_and_schema_rejects(self):
        independent = replace(request(), cache_context={"translationMode":"independent",
            "thinkingRequested":"off", "reasoningCapabilityVerified":True})
        posted = []
        real_client = httpx.Client
        def handle(req):
            posted.append(json.loads(req.content))
            return httpx.Response(200, text=events(response_id=None, reasoning_tokens=3))
        with patch.object(lmstudio_native.httpx, "Client", side_effect=lambda *, timeout:
            real_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            with self.assertRaisesRegex(Exception, "reasoning content or tokens despite") as failure:
                ADAPTER.generate(independent)
        self.assertEqual(failure.exception.code, "ai_local_thinking_violated")
        self.assertEqual(len(posted), 1)
        self.assertIs(posted[0]["store"], False)
        schema = replace(independent, response_schema={"type":"object"})
        with self.assertRaisesRegex(ValueError, "requires the marker output contract"):
            ADAPTER.generate(schema)
        self.assertEqual(len(posted), 1)

    def test_ollama_off_and_minimum_guard_both_paths(self):
        base = replace(request(), provider="ollama", base_url="http://localhost:11434",
            cache_context={"thinkingRequested":"off", "reasoningCapabilityVerified":True}, model_capabilities={})
        mandatory = replace(base, thinking="low", model_capabilities={"reasoning": {
            "supported":True, "mandatory":True, "control":"levels",
            "supported_efforts":["low", "medium"]}})
        unresolved = replace(base, thinking="default",
            cache_context={"thinkingRequested":"minimum", "reasoningCapabilityVerified":True})
        with patch.object(local_ollama, "generate", return_value=ChatResult("text", "selected")) as native:
            for unverified in (base, unresolved):
                result = local_ollama.ADAPTER.generate(unverified)
                self.assertEqual(native.call_args.kwargs["thinking"], "off")
                self.assertTrue(native.call_args.kwargs["reject_observed_thinking"])
                self.assertEqual(result.thinking_applied, "requested_off_unverified_metadata")
            native.reset_mock()
            for invalid in (mandatory,):
                with self.subTest(intent=invalid.cache_context["thinkingRequested"]), \
                     self.assertRaisesRegex(store.ConversationError, "cannot verify"):
                    local_ollama.ADAPTER.generate(invalid)
            native.assert_not_called()
            minimum_low = replace(mandatory,
                cache_context={"thinkingRequested":"minimum", "reasoningCapabilityVerified":True})
            result = local_ollama.ADAPTER.generate(minimum_low)
            self.assertEqual(result.thinking_applied, "requested_low")
            self.assertEqual(native.call_args.kwargs["thinking"], "low")
            native.reset_mock()
            plain = replace(base, model_capabilities={"reasoning":{"supported":False}})
            result = local_ollama.ADAPTER.generate(plain)
            self.assertEqual(result.thinking_applied, "not_applicable_non_reasoning_model")
            self.assertEqual(native.call_args.kwargs["thinking"], "default")

    def test_ollama_stream_thinking_after_off_rejected_without_history_commit(self):
        from backend.ai.provider_resolution import discovered_model_capabilities
        frames = [
            {"message":{"thinking":"PRIVATE_REASONING","content":""},"done":False},
            {"message":{"content":"<<TP_P0:Thai>>"},"done":False},
            {"message":{"content":""},"done":True,"done_reason":"stop",
             "prompt_eval_count":10,"eval_count":3},
        ]
        class Response:
            is_success = True
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def iter_lines(self):
                yield from (json.dumps(frame) for frame in frames)
            def close(self): pass
            def raise_for_status(self): pass
        class Client:
            _textphantom_streaming = True
            requests = []
            metadata_calls = []
            def __init__(self, *, timeout): pass
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def get(self, url, **kwargs):
                self.metadata_calls.append(url)
                return httpx.Response(200,request=httpx.Request("GET",url),
                    json={"models":[{"name":"selected"}]})
            def post(self, url, **kwargs):
                self.metadata_calls.append(url)
                return httpx.Response(200,request=httpx.Request("POST",url),
                    json={"capabilities":["completion","thinking"],
                    "thinking":{"values":[True,False],"default":True}})
            def stream(self, method, url, **kwargs):
                self.requests.append(kwargs["json"])
                return Response()
        traced = []
        cap = {"structured_output":{"supported":False},
               "reasoning":{"supported":True,"mandatory":False,"control":"boolean"},
               "limits":{"contextTokens":65536}}
        ai = AiConfig(api_key="", provider="ollama", model="selected",
            base_url="http://localhost:11434", thinking="off", source_lang="en",
            translation_mode="conversation", conversation=descriptor(
                {"documentId":"ollama-off-observed-reasoning"},
                context={"tp_tab_session":"fixture-observed-reasoning"}))
        with patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
             patch("backend.ai.provider_resolution.discovered_model_capabilities",
                   return_value=(True,cap)), \
             patch.object(local_ollama.httpx,"Client", Client), \
             patch.object(local_ollama.wire_trace,"append_text",
                  side_effect=lambda name,value:traced.append(str(value))):
            with self.assertRaises(Exception) as rejected:
                translate(markers.apply(["First"]),"th",ai)
            self.assertEqual(getattr(rejected.exception,"code", ""),"ai_local_thinking_violated")
            self.assertEqual(len(Client.requests),1)
            self.assertIs(Client.requests[0]["think"],False)
            self.assertNotIn("PRIVATE_REASONING",str(traced))
            frames.pop(0)
            accepted = translate(markers.apply(["Second"]),"th",ai)
            frames.insert(0,{"message":{"thinking":"PRIVATE_REASONING","content":""},"done":False})
            for selected in ("on", "default"):
                other = replace(ai, thinking=selected, conversation=descriptor(
                    {"documentId":"ollama-reasoning-redaction-"+selected},
                    context={"tp_tab_session":"redaction-"+selected}))
                self.assertEqual(translate(markers.apply(["Third"]),"th",other)
                                 ["meta"]["conversation"]["commitStatus"],"committed")
            self.assertNotIn("PRIVATE_REASONING",str(traced))
        self.assertEqual(accepted["meta"]["conversation"]["historyTurns"],0)
        self.assertEqual(accepted["meta"]["conversation"]["commitStatus"],"committed")
        self.assertEqual(len(Client.requests),4)
        self.assertEqual(len(Client.metadata_calls),12)

    def test_ollama_uncached_off_and_lowest_use_native_metadata_before_chat(self):
        from backend.ai.provider_resolution import discovered_model_capabilities
        base = "http://localhost:11434"
        original = httpx.Client
        cases=(("off","llama",False,"off"),
               ("minimum","gptoss","low","low"),
               ("off","plain",None,"off"),
               ("minimum","required_bool",True,"on"),
               ("off","optional_no_default",False,"off"),
               ("minimum","false_unknown",False,"off"),
               ("low","mixed_rank","low","low"))
        for requested, family, expected, resolved in cases:
            with self.subTest(requested=requested):
                forget_model_capabilities("ollama",base,"")
                calls=[]
                def handle(req):
                    calls.append(req)
                    if req.url.path == "/api/tags":
                        return httpx.Response(200,json={"models":[{"name":"selected"}]})
                    if req.url.path == "/api/show":
                        values, selected_default = (
                            (["low","medium","high"], "medium") if family == "gptoss" else
                            ([False],False) if family == "plain" else
                            ([True],True) if family == "required_bool" else
                            ([False,"nano"],"nano") if family == "false_unknown" else
                            (["low","nano"],"low") if family == "mixed_rank" else
                            ([True,False],True))
                        native_thinking={"values":values}
                        if family != "optional_no_default":
                            native_thinking["default"]=selected_default
                        return httpx.Response(200,json={"capabilities":["completion","thinking"],
                            "details":{"family":family},
                            "thinking":native_thinking})
                    if req.url.path == "/api/ps":
                        return httpx.Response(200,json={"models":[]})
                    self.assertEqual(req.url.path,"/api/chat")
                    lines=[{"message":{"content":"<<TP_P0:Thai>>"},"done":False},
                           {"message":{"content":""},"done":True,"done_reason":"stop",
                            "prompt_eval_count":10,"eval_count":3}]
                    return httpx.Response(200,text="\n".join(json.dumps(line) for line in lines)+"\n")
                ai = AiConfig(api_key="",provider="ollama",model="selected",base_url=base,
                    thinking=requested,source_lang="en",translation_mode="conversation",
                    output_contract="compact_markers_v1",
                    conversation=descriptor({"documentId":"ollama-first-use-"+requested+family},
                        context={"tp_tab_session":"first-use-"+requested+family}))
                with patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
                     patch.object(local_ollama.httpx,"Client",side_effect=lambda *, timeout:
                         original(transport=httpx.MockTransport(handle),timeout=timeout)):
                    self.assertEqual(discovered_model_capabilities("ollama",base,"selected"),(False,{}))
                    first=translate(markers.apply(["first"]),"th",ai)
                    second=translate(markers.apply(["second"]),"th",ai)
                self.assertEqual([call.url.path for call in calls],
                    ["/api/tags","/api/show","/api/ps","/api/chat",
                     "/api/tags","/api/show","/api/ps","/api/chat"])
                body=json.loads(calls[3].content)
                if expected is None:
                    self.assertNotIn("think",body)
                    self.assertEqual(first["meta"]["thinking_applied"],
                                     "not_applicable_non_reasoning_model")
                else:
                    self.assertEqual(body["think"],expected)
                self.assertEqual(first["meta"]["thinking_selected"],resolved)
                self.assertEqual(second["meta"]["conversation"]["historyTurns"],1)
        forget_model_capabilities("ollama",base,"")

    def test_ollama_unknown_metadata_attempts_off_and_known_unsupported_blocks(self):
        base="http://localhost:11434"
        original=httpx.Client
        scenarios=(("omitted",None,"minimum"),
                   ("empty",{"values":[],"default":False},"off"),
                   ("wrong_default",{"values":[False],"default":True},"off"),
                   ("number",{"values":[0],"default":0},"minimum"),
                   ("duplicate",{"values":[False,False],"default":False},"off"),
                   ("oversized",{"values":[False]*17},"off"),
                   ("named_off_is_not_boolean",{"values":["off"],"default":"off"},"off"),
                   ("mandatory_boolean",{"values":[True],"default":True},"off"),
                   ("mandatory_level",{"values":["low"],"default":"low"},"off"),
                   ("unknown_level",{"values":["fast"],"default":"fast"},"minimum"),
                   ("mixed_known_unknown",{"values":["low","nano"],"default":"low"},"minimum"))
        blocked={"named_off_is_not_boolean","mandatory_boolean","mandatory_level",
                 "unknown_level","mixed_known_unknown"}
        for label,thinking,requested in scenarios:
            with self.subTest(case=label):
                forget_model_capabilities("ollama",base,"")
                calls=[]
                def handle(req):
                    calls.append(req)
                    if req.url.path == "/api/tags":
                        return httpx.Response(200,json={"models":[{"name":"selected"}]})
                    if req.url.path == "/api/show":
                        return httpx.Response(200,json={"name":"selected",
                            "capabilities":["completion","thinking"],
                            "details":{"family":"gptoss"},
                            **({"thinking":thinking} if thinking is not None else {})})
                    if req.url.path == "/api/ps":
                        return httpx.Response(200,json={"models":[]})
                    if label not in blocked and req.url.path == "/api/chat":
                        body = json.loads(req.content)
                        self.assertIs(body.get("think"),False)
                        lines = [{"message":{"content":"<<TP_P0:Thai>>"},"done":False},
                                 {"message":{"content":""},"done":True,"done_reason":"stop",
                                  "prompt_eval_count":10,"eval_count":3}]
                        return httpx.Response(200,text="\n".join(json.dumps(line) for line in lines)+"\n")
                    raise AssertionError("unexpected model generation")
                with patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
                     patch.object(local_ollama.httpx,"Client",side_effect=lambda *, timeout:
                         original(transport=httpx.MockTransport(handle),timeout=timeout)):
                    ai = AiConfig(api_key="",provider="ollama", model="selected",base_url=base,
                        thinking=requested,source_lang="en",translation_mode="conversation",
                        output_contract="compact_markers_v1",
                        conversation=descriptor({"documentId":"ollama-missing-"+label},
                            context={"tp_tab_session":"missing-"+label}))
                    if label not in blocked:
                        result = translate(markers.apply(["first"]),"th",ai)
                        self.assertEqual(result["meta"]["thinking_applied"],
                                         "requested_off_unverified_metadata")
                        self.assertEqual(result["meta"]["thinking_selected"],"off")
                    else:
                        with self.assertRaises(store.ConversationError) as failure:
                            translate(markers.apply(["first"]),"th",ai)
                        self.assertEqual(failure.exception.code,"ai_local_thinking_unsupported")
                self.assertEqual([call.url.path for call in calls],
                    ["/api/tags","/api/show","/api/ps",*(["/api/chat"] if label not in blocked else [])])
        forget_model_capabilities("ollama",base,"")

    def test_ollama_probe_revalidates_image_and_context_without_erasing_other_models(self):
        from backend.ai.provider_resolution import (remember_model_capabilities,
            discovered_model_capabilities)
        base="http://localhost:11434"
        forget_model_capabilities("ollama",base,"")
        earlier={"reasoning":{"supported":True,"control":"boolean","mandatory":False,
                    "supported_efforts":["none","on"]},
                 "vision":{"supported":True},"structured_output":{"supported":False},
                 "limits":{"contextTokens":8192,"runtimeContextTokens":8192,
                           "modelContextTokens":16384,"source":"ollama-api-ps","scope":"runtime"}}
        other={"vision":{"supported":False},"limits":{"contextTokens":4096,
               "source":"ollama-api-ps","scope":"runtime"}}
        remember_model_capabilities("ollama",base,"",{"selected":earlier,"other":other},
                                     models=["selected","other"])
        calls=[]
        state={"vision":True,"thinking":{"values":[True,False]},"show_status":200}
        original=httpx.Client
        def handle(req):
            calls.append(req)
            path=req.url.path
            if path=="/api/tags":
                return httpx.Response(200,json={"models":[{"name":"selected"},{"name":"other"}]})
            if path=="/api/show":
                if state["show_status"]!=200:
                    return httpx.Response(state["show_status"],json={"error":"unavailable"})
                return httpx.Response(200,json={"capabilities":["completion"] +
                    (["vision"] if state["vision"] else []),"thinking":state["thinking"],
                    "model_info":{"general.architecture":"llama","llama.context_length":16384},
                    "parameters":"num_ctx 8192\ntemperature 0.7"})
            if path=="/api/ps":
                return httpx.Response(200,json={"models":[{"name":"selected",
                    "context_length":8192}]})
            self.assertEqual(path,"/api/chat")
            lines=[{"message":{"content":"<<TP_P0:Thai>>"},"done":False},
                   {"message":{"content":""},"done":True,"done_reason":"stop",
                    "prompt_eval_count":10,"eval_count":3}]
            return httpx.Response(200,text="\n".join(json.dumps(frame) for frame in lines)+"\n")
        ai=AiConfig(api_key="",provider="ollama",model="selected",base_url=base,
            thinking="off",source_lang="en",translation_mode="conversation",
            image_b64="aGVsbG8=",image_mime="image/png",
            model_capabilities={"vision":{"supported":True},
                "reasoning":{"supported":True,"mandatory":False,"control":"boolean"}},
            conversation=descriptor({"documentId":"ollama-image-context"},
                context={"tp_tab_session":"image-context"}))
        with patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
             patch.object(local_ollama.httpx,"Client",side_effect=lambda *,timeout:
                 original(transport=httpx.MockTransport(handle),timeout=timeout)):
            result=translate(markers.apply(["Image one"]),"th",ai)
            self.assertEqual(result["meta"]["conversation"]["commitStatus"],"committed")
            body=json.loads(next(call.content for call in calls if call.url.path=="/api/chat"))
            self.assertNotIn("format",body)
            # Native /api/show proves this model can grow past the loaded 8K context.
            self.assertEqual(body["options"]["num_ctx"],16384)
            self.assertEqual(body["messages"][-1]["images"],["aGVsbG8="])
            actual=discovered_model_capabilities("ollama",base,"selected")[1]
            self.assertEqual(actual["vision"]["supported"],True)
            self.assertEqual(actual["structured_output"]["supported"],False)
            self.assertEqual(actual["limits"]["runtimeContextTokens"],8192)
            self.assertEqual(discovered_model_capabilities("ollama",base,"other")[1],other)
            minimum_ai=replace(ai,thinking="minimum",conversation=descriptor(
                {"documentId":"ollama-image-context-minimum"},
                context={"tp_tab_session":"image-context-minimum"}))
            minimum=translate(markers.apply(["Image lowest"]),"th",minimum_ai)
            self.assertEqual(minimum["meta"]["conversation"]["commitStatus"],"committed")
            minimum_body=json.loads([call.content for call in calls if call.url.path=="/api/chat"][-1])
            self.assertIs(minimum_body["think"],False)
            self.assertEqual(minimum_body["messages"][-1]["images"],["aGVsbG8="])
            state["vision"]=False
            with self.assertRaisesRegex(ValueError,"unavailable"):
                translate(markers.apply(["Image two"]),"th",ai)
            self.assertEqual(sum(call.url.path=="/api/chat" for call in calls),2)
            self.assertIs(discovered_model_capabilities("ollama",base,"selected")[1]
                          ["vision"]["supported"],False)
            self.assertEqual(discovered_model_capabilities("ollama",base,"other")[1],other)
            state["show_status"]=503
            with self.assertRaises(store.ConversationError) as failed:
                translate(markers.apply(["Image three"]),"th",ai)
            self.assertEqual(failed.exception.code,"ai_local_thinking_unsupported")
            self.assertEqual(sum(call.url.path=="/api/chat" for call in calls),2)
            self.assertEqual(discovered_model_capabilities("ollama",base,"other")[1],other)
        forget_model_capabilities("ollama",base,"")

    def test_ollama_exact_probe_preserves_planned_schema_capability(self):
        from backend.ai.provider_resolution import (remember_model_capabilities,
            discovered_model_capabilities)
        base="http://localhost:11434"
        forget_model_capabilities("ollama",base,"")
        remember_model_capabilities("ollama",base,"",{"selected":{
            "structured_output":{"supported":True},
            "reasoning":{"supported":True,"mandatory":False,"control":"boolean",
                         "supported_efforts":["none","on"]}}},models=["selected"])
        calls=[]
        original=httpx.Client
        def handle(req):
            calls.append(req)
            if req.url.path=="/api/tags":
                return httpx.Response(200,json={"models":[{"name":"selected"}]})
            if req.url.path=="/api/show":
                return httpx.Response(200,json={"capabilities":["completion"],
                    "thinking":{"values":[True,False]}})
            if req.url.path=="/api/ps":
                return httpx.Response(200,json={"models":[]})
            self.assertEqual(req.url.path,"/api/chat")
            frames=[{"message":{"content":json.dumps({"P0":"Thai"})},"done":False},
                    {"message":{"content":""},"done":True,"done_reason":"stop",
                     "prompt_eval_count":10,"eval_count":3}]
            return httpx.Response(200,text="\n".join(json.dumps(frame) for frame in frames)+"\n")
        ai=AiConfig(api_key="",provider="ollama",model="selected",base_url=base,
            thinking="off",source_lang="en",output_contract="json_schema_object_v1")
        with patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
             patch.object(local_ollama.httpx,"Client",side_effect=lambda *,timeout:
                 original(transport=httpx.MockTransport(handle),timeout=timeout)):
            result=translate(markers.apply(["Source"]),"th",ai)
        self.assertEqual([call.url.path for call in calls],
            ["/api/tags","/api/show","/api/ps","/api/chat"])
        self.assertEqual(json.loads(calls[-1].content)["format"]["required"],["P0"])
        self.assertEqual(discovered_model_capabilities("ollama",base,"selected")[1]
                         ["structured_output"]["supported"],True)
        self.assertEqual(markers.extract_paragraphs_exact(result["aiTextFull"],1)[0],["Thai"])
        forget_model_capabilities("ollama",base,"")

    def test_ollama_failed_probe_does_not_accept_stale_explicit_low(self):
        from backend.ai.provider_resolution import remember_model_capabilities
        base="http://localhost:11434"
        forget_model_capabilities("ollama",base,"")
        previous={"reasoning":{"supported":True,"mandatory":True,"control":"levels",
                    "supported_efforts":["low","medium"]}}
        remember_model_capabilities("ollama",base,"",{"selected":previous},models=["selected"])
        calls=[]
        original=httpx.Client
        def handle(req):
            calls.append(req.url.path)
            if req.url.path=="/api/tags":
                return httpx.Response(200,json={"models":[{"name":"selected"}]})
            if req.url.path=="/api/show":
                return httpx.Response(503,json={"error":"unavailable"})
            raise AssertionError("stale Low reached generation")
        ai=AiConfig(api_key="",provider="ollama",model="selected",base_url=base,
            thinking="low",source_lang="en",translation_mode="conversation",
            model_capabilities=previous,conversation=descriptor({"documentId":"ollama-low-stale"},
                context={"tp_tab_session":"low-stale"}))
        with patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
             patch.object(local_ollama.httpx,"Client",side_effect=lambda *,timeout:
                 original(transport=httpx.MockTransport(handle),timeout=timeout)), \
             self.assertRaises(store.ConversationError) as failed:
            translate(markers.apply(["Source"]),"th",ai)
        self.assertEqual(failed.exception.code,"ai_local_thinking_unsupported")
        self.assertEqual(calls,["/api/tags","/api/show"])
        forget_model_capabilities("ollama",base,"")

    def test_ollama_stale_optional_capability_rechecked_before_dispatch(self):
        from backend.ai.provider_resolution import discovered_model_capabilities
        base="http://localhost:11434"
        forget_model_capabilities("ollama",base,"")
        state={"thinking":{"values":[True,False],"default":True}}
        calls=[]
        original=httpx.Client
        def handle(req):
            calls.append(req)
            if req.url.path=="/api/tags":
                return httpx.Response(200,json={"models":[{"name":"selected"}]})
            if req.url.path=="/api/show":
                return httpx.Response(200,json={"capabilities":["completion","thinking"],
                    **({"thinking":state["thinking"]} if state["thinking"] is not None else {})})
            if req.url.path=="/api/ps":
                return httpx.Response(200,json={"models":[]})
            self.assertEqual(req.url.path,"/api/chat")
            frames=[{"message":{"content":"<<TP_P0:Thai>>"},"done":False},
                    {"message":{"content":""},"done":True,"done_reason":"stop",
                     "prompt_eval_count":10,"eval_count":3}]
            return httpx.Response(200,text="\n".join(json.dumps(frame) for frame in frames)+"\n")
        ai=AiConfig(api_key="",provider="ollama",model="selected",base_url=base,
            thinking="off",source_lang="en",translation_mode="conversation",
            output_contract="compact_markers_v1",conversation=descriptor(
                {"documentId":"ollama-stale-optional"},
                context={"tp_tab_session":"stale-optional"}),
            model_capabilities={"reasoning":{"supported":True,"mandatory":False,
                "control":"boolean"}})
        with patch("backend.ai.translation.invocation.assert_ai_base_url_allowed"), \
             patch.object(local_ollama.httpx,"Client",side_effect=lambda *,timeout:
                 original(transport=httpx.MockTransport(handle),timeout=timeout)):
            first=translate(markers.apply(["First"]),"th",ai)
            self.assertEqual(first["meta"]["conversation"]["commitStatus"],"committed")
            self.assertIs(discovered_model_capabilities("ollama",base,"selected")[1]
                          ["reasoning"]["mandatory"],False)
            state["thinking"]={"values":["low","medium","high"],"default":"medium"}
            with self.assertRaises(store.ConversationError) as mandatory:
                translate(markers.apply(["Second"]),"th",ai)
            self.assertEqual(mandatory.exception.code,"ai_local_thinking_unsupported")
            self.assertIs(discovered_model_capabilities("ollama",base,"selected")[1]
                          ["reasoning"]["mandatory"],True)
            state["thinking"]=None  # Missing metadata must evict old optional proof.
            third=translate(markers.apply(["Third"]),"th",ai)
            self.assertEqual(third["meta"]["thinking_applied"],"requested_off_unverified_metadata")
            self.assertIs(json.loads(calls[-1].content).get("think"),False)
            self.assertEqual(discovered_model_capabilities("ollama",base,"selected"),(False,{}))
        self.assertEqual([call.url.path for call in calls],
            ["/api/tags","/api/show","/api/ps","/api/chat",
             "/api/tags","/api/show","/api/ps", "/api/tags","/api/show","/api/ps","/api/chat"])
        forget_model_capabilities("ollama",base,"")

    def test_stale_client_nonreasoning_claim_cannot_bypass_guards(self):
        spoof = {"reasoning":{"supported":False}}
        lm_independent = replace(request(), model_capabilities=spoof,
            cache_context={"thinkingRequested":"off", "reasoningCapabilityVerified":False})
        lm_native = replace(lm_independent,
            cache_context={"translationMode":"conversation", "providerThinkingPreference":"off",
                           "reasoningCapabilityVerified":False})
        ollama = replace(lm_independent, provider="ollama", base_url="http://localhost:11434")
        with patch.object(local_lmstudio.LocalOpenAIChatAdapter, "generate",
                          side_effect=AssertionError("compatibility request sent")) as compat, \
             patch.object(local_lmstudio, "execute_lmstudio_chat",
                          side_effect=AssertionError("native request sent")) as lm_chat, \
             patch.object(local_ollama, "generate",
                          side_effect=AssertionError("ollama request sent")) as ol_chat:
            for candidate, adapter in ((lm_independent, ADAPTER), (lm_native, ADAPTER),
                                       (ollama, local_ollama.ADAPTER)):
                with self.subTest(provider=candidate.provider,
                                  mode=candidate.cache_context.get("translationMode")), \
                     self.assertRaisesRegex(store.ConversationError, "verif"):
                    adapter.generate(candidate)
            compat.assert_not_called()
            lm_chat.assert_not_called()
            ol_chat.assert_not_called()

    def test_prepared_history_uses_only_accepted_cursor_and_budget_rollover(self):
        lease = store.Lease()
        lease.source_texts = ["SOURCE"]
        token = store._current.set(lease)
        ai = SimpleNamespace(conversation={"branch": "initial"}, provider="lmstudio", thinking="off")
        layout = {"userStaticChars": 6, "userPersistentStaticChars": 6,
                  "instructionLocale": "en"}
        first = replace(request(), user_parts=("ANCHOR\n\n<<I1_P0:SOURCE>>",),
            cache_context={"conversationSource": "<<I1_P0:SOURCE>>",
                "conversationRecordProtocol": "tp.translation.image-records/1"})
        try:
            prepared = conversation.prepare(first, layout, ai)
            self.assertFalse(prepared.previous_response_id)
            self.assertIn("ANCHOR", prepared.user_parts[0])
            prior = {"user": prepared.user_parts[0], "assistant": "<<I1_P0:Thai>>",
                     "anchor": True, "pages": [], "providerResponseId": "resp_first",
                     "inputTokens": 100, "rawEstimatedInput": 100}
            lease.history = [prior]
            lease.prefix = lease.prepared["prefix"]
            subsequent = replace(first, user_parts=("ANCHOR\n\n<<I2_P0:NEXT>>",),
                cache_context={"conversationSource": "<<I2_P0:NEXT>>",
                    "conversationRecordProtocol": "tp.translation.image-records/1"})
            prepared2 = conversation.prepare(subsequent, layout, ai)
            self.assertEqual(prepared2.previous_response_id, "resp_first")
            self.assertEqual(prepared2.user_parts, ("<<I2_P0:NEXT>>",))
            self.assertEqual([m["role"] for m in prepared2.history_messages], ["user", "assistant"])
            self.assertEqual(prepared2.cache_context["providerThinkingPreference"], "off")
            missing_cursor = ChatResult("<<I2_P0:Thai>>", "selected", terminal_completed=True)
            decoded = {"aiTextFull": markers.apply(["Thai"]), "meta": {"usage": {}}}
            with self.assertRaisesRegex(Exception, "did not return a valid conversation"):
                conversation.finish(missing_cursor, decoded, ai, ["NEXT"], "th")
            self.assertEqual(len(lease.history), 1)
            self.assertEqual(lease.prepared["evidence"]["commitStatus"], "not_committed_provider_cursor_missing")
            valid = ChatResult("<<I2_P0:Thai>>", "selected", terminal_completed=True,
                provider_response_id="resp_second")
            malformed = {"aiTextFull": markers.apply(["Thai"]), "meta": {
                "malformed_output_record_count":1, "malformed_output_recoverable":True,
                "usage":{"inputTokens":100,"outputTokens":20}}}
            conversation.finish(valid._replace(text="<<I2_P0:Thai>>\n<<bad>>"),
                malformed, ai, ["NEXT"], "th")
            self.assertEqual(malformed["meta"]["conversation"]["commitStatus"],
                             "not_committed_native_transcript_invalid")
            self.assertNotIn("resp_second",str(malformed))
            self.assertEqual(len(lease.history), 1)
            self.assertEqual(conversation.prepare(subsequent, layout, ai).previous_response_id,
                             "resp_first")
            decoded = {"aiTextFull": markers.apply(["Thai"]), "meta": {"usage": {}}}
            conversation.finish(valid, decoded, ai, ["NEXT"], "th")
            self.assertEqual(lease.history[-1]["providerResponseId"], "resp_second")
            self.assertNotIn("resp_second", str(decoded))
            lease.history[-1].pop("providerResponseId")
            with self.assertRaisesRegex(store.ConversationError, "no validated provider continuation cursor"):
                conversation.prepare(subsequent, layout, ai)
        finally:
            store._current.reset(token)

    def test_budget_trim_starts_new_server_thread_with_visible_reason(self):
        lease = store.Lease()
        lease.source_texts = ["SOURCE"]
        token = store._current.set(lease)
        ai = SimpleNamespace(conversation={"branch":"initial"}, provider="lmstudio", thinking="off")
        layout = {"userStaticChars":6, "userPersistentStaticChars":6, "instructionLocale":"en"}
        source = "<<I2_P0:NEXT>>"
        item = replace(request(), user_parts=("ANCHOR\n\n" + source,),
            model_capabilities={"limits":{"contextTokens":2048},
                "reasoning":{"supported":True,"control":"levels","supported_efforts":["off"]}},
            cache_context={"conversationSource":source,
                "conversationRecordProtocol":"tp.translation.image-records/1"})
        try:
            first = conversation.prepare(item, layout, ai)
            lease.history = [{"user": "ANCHOR\n\n" + "SOURCE "*1000,
                "assistant": "Thai "*1000, "anchor":True, "pages":[],
                "providerResponseId":"resp_previous"}]
            lease.prefix = lease.prepared["prefix"]
            next_item = conversation.prepare(item, layout, ai)
            self.assertFalse(next_item.previous_response_id)
            self.assertIn("ANCHOR", next_item.user_parts[0])
            self.assertEqual(next_item.history_messages, ())
            self.assertEqual(lease.prepared["evidence"]["rolloverReason"], "native_context_rollover")
        finally:
            store._current.reset(token)


if __name__ == "__main__":
    unittest.main()
