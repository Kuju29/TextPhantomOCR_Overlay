#!/usr/bin/env python3
"""Offline Ollama request checks for saved Off/Lowest with missing thinking.values."""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from backend.ai.clients.base import ProviderOutputError
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import local_ollama
from backend.ai.translation_paths.store import ConversationError


def request(*, saved="minimum", selected="default", reasoning=None):
    return GenerationRequest(
        provider="ollama", model="selected", base_url="http://localhost:11434",
        system_text="Translate accurately.", user_parts=("<<TP_P0:source>>",),
        expected_ids=("P0",), unit_count=1, thinking=selected,
        model_capabilities={"reasoning": reasoning or {}},
        cache_context={"thinkingRequested": saved, "reasoningCapabilityVerified": False},
    )


class OllamaOffAttemptTests(unittest.TestCase):
    def run_wire(self, candidate, frames):
        calls = []

        def handle(wire):
            calls.append(json.loads(wire.content))
            return httpx.Response(200, text="".join(json.dumps(frame) + "\n" for frame in frames),
                                  headers={"content-type": "application/x-ndjson"})

        actual_client = httpx.Client
        with patch.object(local_ollama.httpx, "Client", side_effect=lambda *, timeout:
                          actual_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            try:
                result = local_ollama.ADAPTER.generate(candidate)
                return calls, result, None
            except ProviderOutputError as error:
                return calls, None, error

    def test_unknown_lowest_and_off_request_false_with_unverified_audit(self):
        for saved, selected in (("minimum", "default"), ("off", "off")):
            with self.subTest(saved=saved):
                calls, result, error = self.run_wire(request(saved=saved, selected=selected), [
                    {"model": "selected", "message": {"content": "<<TP_P0:translated>>"},
                     "done": True, "done_reason": "stop", "prompt_eval_count": 80,
                     "eval_count": 12}])
                self.assertIsNone(error)
                self.assertEqual(len(calls), 1)
                self.assertIs(calls[0]["think"], False)
                self.assertLess(calls[0]["options"]["num_predict"], 8192)
                self.assertEqual(result.thinking_applied, "requested_off_unverified_metadata")

    def test_first_thinking_frame_fails_without_waiting_for_terminal(self):
        calls, result, error = self.run_wire(request(), [
            {"model": "selected", "message": {"thinking": "private"}, "done": False},
            {"model": "selected", "message": {"content": "<<TP_P0:wrong>>"},
             "done": True, "done_reason": "stop"},
        ])
        self.assertEqual(len(calls), 1)
        self.assertIs(calls[0]["think"], False)
        self.assertIsNone(result)
        self.assertEqual(error.code, "ai_local_thinking_violated")
        self.assertEqual(error.structural_details["validatorSubtype"],
                         "reasoning_reported_with_thinking_off")
        self.assertNotIn("private", str(error))

    def test_verified_mandatory_metadata_rejects_before_chat(self):
        mandatory = {"supported": True, "mandatory": True,
                     "control": "levels", "supported_efforts": ["low"]}
        for saved, selected in (("off", "off"), ("minimum", "default")):
            with self.subTest(saved=saved), patch.object(local_ollama, "generate") as generate:
                candidate = request(saved=saved, selected=selected, reasoning=mandatory)
                with self.assertRaises(ConversationError) as caught:
                    local_ollama.ADAPTER.generate(candidate)
                self.assertEqual(caught.exception.code, "ai_local_thinking_unsupported")
                generate.assert_not_called()

    def test_named_mode_stays_metadata_bound(self):
        with patch.object(local_ollama, "generate") as generate:
            with self.assertRaises(ConversationError):
                local_ollama.ADAPTER.generate(request(saved="low", selected="low"))
            generate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
