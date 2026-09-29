"""API wire trace must never persist provider-private reasoning bodies."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from backend.ai import wire_trace
from backend.ai.clients.provider_error import ProviderHttpError
from backend.ai.transports.openai_compat import core


VISIBLE = "<<TP_P0:คำแปล>>"


class BodyMustNotBeRead:
    def __init__(self, status_code: int):
        self.status_code = status_code

    @property
    def text(self):
        raise AssertionError("private provider body was read for tracing")

    @property
    def content(self):
        raise AssertionError("private provider body was read for tracing")


class WirePrivacyTests(unittest.TestCase):
    def trace(self, root: str, operation: str):
        token = wire_trace.begin({"traceId": "privacy", "operationId": operation})
        folder = wire_trace.active_folder()
        self.assertIsNotNone(folder)
        return token, folder

    def assert_private_absent(self, folder: Path, *secrets: str):
        artifacts = "\n".join(path.read_text("utf-8") for path in folder.iterdir()
                              if path.is_file())
        for secret in secrets:
            self.assertNotIn(secret, artifacts)

    def test_stream_split_reasoning_omitted_but_visible_and_usage_survive(self):
        frames = [
            {"id": "r1", "choices": [{"delta": {"reasoning_content": "PRIVATE_THOUGHT_A"},
                                      "finish_reason": None}]},
            {"choices": [{"delta": {"reasoning_content": "PRIVATE_THOUGHT_B"},
                          "finish_reason": None}]},
            {"choices": [{"delta": {"content": VISIBLE}, "finish_reason": None}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}],
             "usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12,
                       "completion_tokens_details": {"reasoning_tokens": 3}}},
        ]
        stream = "".join(f"data: {json.dumps(frame, ensure_ascii=False)}\n\n"
                         for frame in frames) + "data: [DONE]\n\n"
        actual_client = httpx.Client

        def handle(request):
            self.assertEqual(request.url.path, "/v1/chat/completions")
            return httpx.Response(200, text=stream,
                                  headers={"content-type": "text/event-stream"})

        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                "TP_AI_WIRE_TRACE": "1", "TP_AI_WIRE_TRACE_DIR": temp}):
            token, folder = self.trace(temp, "sse")
            try:
                with patch.object(core.httpx, "Client", side_effect=lambda *, timeout:
                        actual_client(transport=httpx.MockTransport(handle), timeout=timeout)):
                    result = core.execute_openai_compatible_request(
                        url="https://url_user:URL_PASSWORD@provider.invalid/v1/chat/completions?session=URL_QUERY",
                        headers={"Authorization": "Bearer HEADER_SECRET",
                                 "X-Provider-Pin": "CUSTOM_SECRET"},
                        payload={"messages": [{"role": "user", "content": "source"}]},
                        model="selected", provider_id="openrouter", timeout=1,
                        timeout_policy="fixture", expected_ids=["P0"])
            finally:
                wire_trace.end(token)
            self.assertEqual(result.text, VISIBLE)
            self.assertEqual((result.input_tokens, result.output_tokens,
                              result.thinking_tokens), (5, 7, 3))
            self.assertTrue(result.reasoning_observed)
            self.assertEqual((folder / "05_provider_response.raw").read_text("utf-8"),
                             "[raw provider response omitted]\n")
            self.assertEqual((folder / "05_provider_response.assembled.txt").read_text("utf-8"),
                             VISIBLE)
            response_meta = json.loads((folder / "05_provider_response.meta.json").read_text("utf-8"))
            self.assertEqual((response_meta["status"], response_meta["streamed"],
                              response_meta["bodyStored"], response_meta["inputTokens"],
                              response_meta["outputTokens"], response_meta["reasoningTokens"]),
                             (200, True, False, 5, 7, 3))
            self.assert_private_absent(folder, "PRIVATE_THOUGHT_A", "PRIVATE_THOUGHT_B",
                                       "URL_PASSWORD", "URL_QUERY", "HEADER_SECRET",
                                       "CUSTOM_SECRET")

    def test_nonstream_body_and_http_error_omit_reasoning(self):
        class NonstreamClient:
            def __init__(self, *, timeout):
                pass
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return False
            def post(self, url, *, json, headers):
                body = {"choices": [{"message": {
                    "content": VISIBLE, "reasoning_content": "PRIVATE_NONSTREAM"},
                    "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 5, "completion_tokens": 7}}
                return httpx.Response(200, json=body,
                                      request=httpx.Request("POST", url))

        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                "TP_AI_WIRE_TRACE": "1", "TP_AI_WIRE_TRACE_DIR": temp}):
            token, folder = self.trace(temp, "nonstream")
            try:
                with patch.object(core.httpx, "Client", NonstreamClient):
                    result = core.execute_openai_compatible_request(
                        url="https://provider.invalid/chat", headers={}, payload={},
                        model="selected", provider_id="jan", timeout=1,
                        timeout_policy="fixture", expected_ids=["P0"])
            finally:
                wire_trace.end(token)
            self.assertEqual(result.text, VISIBLE)
            self.assertEqual((folder / "05_provider_response.assembled.txt").read_text("utf-8"),
                             VISIBLE)
            response_meta = json.loads((folder / "05_provider_response.meta.json").read_text("utf-8"))
            self.assertEqual((response_meta["status"], response_meta["streamed"],
                              response_meta["bodyStored"], response_meta["inputTokens"],
                              response_meta["outputTokens"]),
                             (200, False, False, 5, 7))
            self.assert_private_absent(folder, "PRIVATE_NONSTREAM")

            class ErrorClient(NonstreamClient):
                def post(self, url, *, json, headers):
                    return httpx.Response(503, text='{"private":"PRIVATE_ERROR_BODY"}',
                                          request=httpx.Request("POST", url))

            token, folder = self.trace(temp, "http-error")
            try:
                with patch.object(core.httpx, "Client", ErrorClient):
                    with self.assertRaises(Exception):
                        core.execute_openai_compatible_request(
                            url="https://provider.invalid/chat", headers={}, payload={},
                            model="selected", provider_id="jan", timeout=1,
                            timeout_policy="fixture")
            finally:
                wire_trace.end(token)
            self.assertEqual(json.loads((folder / "05_provider_response.meta.json").read_text("utf-8")),
                             {"status": 503, "streamed": False, "bodyStored": False})
            self.assert_private_absent(folder, "PRIVATE_ERROR_BODY")

    def test_native_gemini_anthropic_and_local_raw_seams_are_omitted(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                "TP_AI_WIRE_TRACE": "1", "TP_AI_WIRE_TRACE_DIR": temp}):
            for provider in ("gemini", "anthropic"):
                token, folder = self.trace(temp, provider)
                try:
                    wire_trace.append_text("response-stream.sse",
                        'data: {"thought":"PRIVATE_NATIVE_THOUGHT"}\n\n')
                    wire_trace.http_response(BodyMustNotBeRead(200))
                    wire_trace.assembled_response(VISIBLE)
                finally:
                    wire_trace.end(token)
                self.assertFalse((folder / "response-stream.sse").exists())
                self.assertEqual((folder / "05_provider_response.assembled.txt").read_text("utf-8"),
                                 VISIBLE)
                self.assertEqual(json.loads((folder / "05_provider_response.meta.json").read_text("utf-8")),
                                 {"status": 200, "streamed": None, "bodyStored": False})
                self.assert_private_absent(folder, "PRIVATE_NATIVE_THOUGHT")
            for provider in ("lmstudio", "ollama"):
                token, folder = self.trace(temp, provider)
                try:
                    wire_trace.append_text("05_provider_response.raw",
                        'data: {"reasoning":"PRIVATE_LOCAL_THOUGHT"}\n\n')
                    wire_trace.provider_response({"reasoning": "PRIVATE_NONSTREAM_THOUGHT"})
                    wire_trace.assembled_response(VISIBLE)
                finally:
                    wire_trace.end(token)
                self.assertEqual((folder / "05_provider_response.raw").read_text("utf-8"),
                                 "[raw provider response omitted]\n")
                self.assert_private_absent(folder, "PRIVATE_LOCAL_THOUGHT",
                                           "PRIVATE_NONSTREAM_THOUGHT")

    def test_local_relay_cannot_persist_supplied_raw_or_arbitrary_meta(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / "relay"
            wire_trace.begin_in(folder, {"traceId": "relay", "provider": "ollama"})
            wire_trace.write_text_in(folder, "05_provider_response.raw",
                                     '{"thinking":"PRIVATE_RELAY_THOUGHT"}')
            wire_trace.write_json_in(folder, "05_provider_response.meta.json", {
                "mode": "stream", "status": 200, "chunks": ["PRIVATE_RELAY_CHUNK"],
                "reasoning": "PRIVATE_RELAY_META", "complete": True,
            })
            wire_trace.write_text_in(folder, "05_provider_response.assembled.txt", VISIBLE)
            self.assertEqual((folder / "05_provider_response.raw").read_text("utf-8"),
                             "[raw provider response omitted]\n")
            self.assertEqual((folder / "05_provider_response.assembled.txt").read_text("utf-8"),
                             VISIBLE)
            self.assertEqual(json.loads((folder / "05_provider_response.meta.json").read_text("utf-8")),
                             {"status": 200, "streamed": True, "bodyStored": False,
                              "chunkCount": 1, "complete": True})
            self.assert_private_absent(folder, "PRIVATE_RELAY_THOUGHT",
                                       "PRIVATE_RELAY_CHUNK", "PRIVATE_RELAY_META")

    def test_provider_controlled_error_messages_are_absent_from_trace(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                "TP_AI_WIRE_TRACE": "1", "TP_AI_WIRE_TRACE_DIR": temp}):
            token, folder = self.trace(temp, "provider-error")
            try:
                failure = ProviderHttpError("Provider HTTP 502 PRIVATE_ERROR_THOUGHT",
                    provider="openrouter", model="selected", status=502,
                    provider_message="PRIVATE_ERROR_THOUGHT")
                wire_trace.record_error(failure, stage="provider_response")
                wire_trace.terminal(state="failed", stage="provider_response",
                                    message="PRIVATE_TERMINAL_THOUGHT")
            finally:
                wire_trace.end(token)
            error = json.loads((folder / "10_error.json").read_text("utf-8"))
            terminal = json.loads((folder / "11_terminal.json").read_text("utf-8"))
            self.assertEqual((error["stage"], error["upstreamStatus"], error["message"]),
                             ("provider_response", 502, "<omitted>"))
            self.assertEqual(terminal["message"], "<omitted>")
            self.assert_private_absent(folder, "PRIVATE_ERROR_THOUGHT",
                                       "PRIVATE_TERMINAL_THOUGHT")

            relay = Path(temp) / "relay-error"
            wire_trace.begin_in(relay, {"traceId": "relay", "provider": "ollama"})
            wire_trace.write_json_in(relay, "10_error.json", {
                "stage": "provider_response", "code": "provider_error",
                "message": "PRIVATE_RELAY_ERROR", "status": 503,
                "providerAttempts": 1, "detail": {"thinking": "PRIVATE_RELAY_DETAIL"},
            })
            wire_trace.write_json_in(relay, "11_terminal.json", {
                "terminal": True, "state": "failed", "message": "PRIVATE_RELAY_TERMINAL",
                "generationAttempts": 1,
            })
            saved = json.loads((relay / "10_error.json").read_text("utf-8"))
            self.assertEqual((saved["code"], saved["status"],
                              saved["providerAttempts"], saved["message"]),
                             ("provider_error", 503, 1, "<omitted>"))
            self.assert_private_absent(relay, "PRIVATE_RELAY_ERROR", "PRIVATE_RELAY_DETAIL",
                                       "PRIVATE_RELAY_TERMINAL")


if __name__ == "__main__":
    unittest.main()
