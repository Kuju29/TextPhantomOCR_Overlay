"""Exercise public API partial salvage against a mocked LM Studio native server.

No local model or external network is needed. Run with PYTHONPATH=api python
scripts/test-lmstudio-native-partial-salvage.py.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from backend.ai.provider_resolution import forget_model_capabilities
from backend.ai.providers import local_lmstudio
from backend.api.routes.ai_v1 import router
from backend.config import settings
from backend.jobs.admission import AdmissionGate


BASE = "http://localhost:1234/v1"
ROUTE = "/v2/engine/runsextension/ai/translate"
MODEL_CATALOGUE = {"models": [{
    "type": "llm", "key": "selected",
    "loaded_instances": [{"id": "selected", "config": {"context_length": 65536}}],
    "capabilities": {"reasoning": {"allowed_options": ["off", "on"], "default": "on"}},
}]}


def events(answer: str, response_id: str) -> str:
    frames = [
        {"type": "chat.start", "model_instance_id": "selected"},
        {"type": "message.delta", "content": answer},
        {"type": "chat.end", "result": {
            "model_instance_id": "selected", "response_id": response_id,
            "output": [{"type": "message", "content": answer}],
            "stats": {"input_tokens": 100, "total_output_tokens": 20,
                      "reasoning_output_tokens": 0},
        }},
    ]
    return "".join("event: " + frame["type"] + "\ndata: " +
                   json.dumps(frame, ensure_ascii=False) + "\n\n" for frame in frames)


def payload(page: int, values: tuple[str, ...], *, branch: str = "initial") -> dict:
    ids = [f"I{page}_P{index}" for index in range(len(values))]
    return {
        "schema": "tp.ai.request/1", "translationMode": "conversation",
        "operationId": f"native-partial-{page}-{branch}",
        "context": {"tp_tab_session": "native-partial-test"},
        "conversation": {"documentId": "native-partial-document", "origins": [{
            "pageId": f"page-{page}", "pageIndex": page - 1, "pageOrder": page,
            "unitIds": ids, "originalIds": [f"g{page}_{i}" for i in range(len(ids))],
        }]},
        "sourceLang": "en", "targetLang": "th",
        "units": [{"id": uid, "text": value} for uid, value in zip(ids, values)],
        "provider": {"id": "lmstudio", "model": "selected", "apiKey": "",
                     "baseUrl": BASE, "thinking": "off"},
        "memory": {"mode": "off"},
        "repair": {"owner": "extension", "enabled": False, "branch": branch},
    }


class NativePartialSalvageTest(unittest.TestCase):
    def request_sequence(self, answers: list[str], verify) -> None:
        sent: list[dict] = []

        def handle(request: httpx.Request) -> httpx.Response:
            if request.method == "GET":
                self.assertEqual(request.url.path, "/api/v1/models")
                return httpx.Response(200, json=MODEL_CATALOGUE)
            self.assertEqual((request.method, request.url.path), ("POST", "/api/v1/chat"))
            body = json.loads(request.content)
            sent.append(body)
            self.assertLessEqual(len(sent), len(answers), "unexpected model generation")
            return httpx.Response(200, text=events(answers[len(sent) - 1],
                                                   f"resp_{len(sent)}"))

        original_client = httpx.Client
        with tempfile.TemporaryDirectory() as temp, ThreadPoolExecutor(max_workers=1) as executor, \
             patch.dict(os.environ, {"TP_CONVERSATION_STATE_FILE": temp + "/state.sqlite",
                                  "TP_AI_WIRE_TRACE": "0", "TP_USAGE_RECEIPTS": "off"}), \
             patch("backend.security.settings", replace(settings, ai_endpoint_policy="personal")), \
             patch.object(local_lmstudio.httpx, "Client", side_effect=lambda *, timeout:
                          original_client(transport=httpx.MockTransport(handle), timeout=timeout)):
            forget_model_capabilities("lmstudio", BASE, "")
            try:
                app = FastAPI()
                app.include_router(router)
                app.state.ai_admission_gate = AdmissionGate(1, max_waiters=2,
                                                            max_wait_sec=5)
                app.state.ai_executor = executor

                async def run() -> None:
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                                 base_url="http://fixture") as client:
                        await verify(client, sent)

                asyncio.run(run())
            finally:
                forget_model_capabilities("lmstudio", BASE, "")

    def test_recoverable_partial_maps_valid_unit_and_next_page_starts_fresh(self) -> None:
        answers = ["<<I1_P0:BROKEN>\n<<I1_P1:GOOD>>", "<<I2_P0:NEXT>>"]

        async def verify(client, sent):
            first = await client.post(ROUTE, json=payload(1, ("FIRST", "SECOND")))
            self.assertEqual(first.status_code, 200, first.text)
            body = first.json()
            self.assertEqual([item["id"] for item in body["translations"]], ["I1_P1"])
            self.assertEqual(body["translations"][0]["text"], "GOOD")
            self.assertEqual(body["missing"], ["I1_P0"])
            self.assertEqual(body["meta"]["contractDiagnostics"]["malformedMarkerIds"],
                             ["unknown"])
            self.assertEqual(body["meta"]["conversation"]["commitStatus"],
                             "not_committed_native_transcript_invalid")
            self.assertEqual(body["meta"]["conversation"]["providerState"],
                             "transcript_invalid")
            self.assertTrue(sent[0]["store"])
            self.assertIn("system_prompt", sent[0])

            second = await client.post(ROUTE, json=payload(2, ("NEXT_SOURCE",)))
            self.assertEqual(second.status_code, 200, second.text)
            self.assertEqual(second.json()["meta"]["conversation"]["historyTurns"], 0)
            self.assertEqual(second.json()["meta"]["conversation"]["commitStatus"],
                             "committed")
            self.assertNotIn("previous_response_id", sent[1])
            self.assertIn("system_prompt", sent[1])
            self.assertEqual(len(sent), 2)

        self.request_sequence(answers, verify)

    def test_partial_after_committed_turn_reuses_last_accepted_cursor(self) -> None:
        answers = ["<<I1_P0:FIRST>>", "<<I2_P0:BROKEN>\n<<I2_P1:GOOD>>",
                   "<<I3_P0:THIRD>>"]

        async def verify(client, sent):
            first = await client.post(ROUTE, json=payload(1, ("FIRST_SOURCE",)))
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(first.json()["meta"]["conversation"]["commitStatus"],
                             "committed")

            partial = await client.post(ROUTE, json=payload(2, ("BROKEN_SOURCE", "GOOD_SOURCE")))
            self.assertEqual(partial.status_code, 200, partial.text)
            self.assertEqual([row["id"] for row in partial.json()["translations"]],
                             ["I2_P1"])
            self.assertEqual(partial.json()["missing"], ["I2_P0"])
            self.assertEqual(partial.json()["meta"]["conversation"]["commitStatus"],
                             "not_committed_native_transcript_invalid")
            self.assertEqual(sent[1]["previous_response_id"], "resp_1")

            third = await client.post(ROUTE, json=payload(3, ("THIRD_SOURCE",)))
            self.assertEqual(third.status_code, 200, third.text)
            self.assertEqual(third.json()["meta"]["conversation"]["historyTurns"], 1)
            self.assertEqual(sent[2]["previous_response_id"], "resp_1")
            self.assertNotIn("system_prompt", sent[2])
            self.assertNotIn("FIRST_SOURCE", str(sent[2]))
            self.assertNotIn("GOOD_SOURCE", str(sent[2]))
            self.assertEqual(len(sent), 3)

        self.request_sequence(answers, verify)

    def test_partial_can_repair_missing_unit_without_reusing_bad_cursor(self) -> None:
        answers = ["<<I1_P0:BROKEN>\n<<I1_P1:GOOD>>",
                   "<<I1_P0:FIXED>>", "<<I2_P0:NEXT>>"]

        async def verify(client, sent):
            partial = await client.post(ROUTE, json=payload(1, ("BROKEN_SOURCE", "GOOD_SOURCE")))
            self.assertEqual(partial.status_code, 200, partial.text)
            self.assertEqual(partial.json()["missing"], ["I1_P0"])
            self.assertEqual([row["id"] for row in partial.json()["translations"]],
                             ["I1_P1"])

            repair = await client.post(ROUTE, json=payload(1, ("BROKEN_SOURCE",),
                                                         branch="repair"))
            self.assertEqual(repair.status_code, 200, repair.text)
            self.assertEqual([row["id"] for row in repair.json()["translations"]],
                             ["I1_P0"])
            self.assertEqual(repair.json()["meta"]["conversation"]["historyTurns"], 0)
            self.assertEqual(repair.json()["meta"]["conversation"]["commitStatus"],
                             "committed")
            self.assertNotIn("previous_response_id", sent[1])
            self.assertIn("system_prompt", sent[1])

            following = await client.post(ROUTE, json=payload(2, ("NEXT_SOURCE",)))
            self.assertEqual(following.status_code, 200, following.text)
            self.assertEqual(following.json()["meta"]["conversation"]["historyTurns"], 1)
            self.assertEqual(sent[2]["previous_response_id"], "resp_2")
            self.assertNotIn("GOOD_SOURCE", str(sent[2]))
            self.assertEqual(len(sent), 3)

        self.request_sequence(answers, verify)

    def test_no_valid_unit_remains_a_failure_and_does_not_store_cursor(self) -> None:
        answers = ["<<I1_P0:>>\n<<I1_P1:BROKEN>", "<<I2_P0:NEXT>>"]

        async def verify(client, sent):
            broken = await client.post(ROUTE, json=payload(1, ("FIRST", "SECOND")))
            self.assertEqual(broken.status_code, 502, broken.text)
            self.assertEqual(broken.json()["detail"]["code"],
                             "ai_conversation_native_transcript_invalid")
            following = await client.post(ROUTE, json=payload(2, ("NEXT_SOURCE",)))
            self.assertEqual(following.status_code, 200, following.text)
            self.assertEqual(following.json()["meta"]["conversation"]["historyTurns"], 0)
            self.assertNotIn("previous_response_id", sent[1])
            self.assertIn("system_prompt", sent[1])

        self.request_sequence(answers, verify)

    def test_replayed_page_with_partial_invalidates_future_cursor(self) -> None:
        answers = ["<<I1_P0:FIRST>>", "<<I2_P0:SECOND>>",
                   "<<I1_P0:BROKEN>\n<<I1_P1:GOOD>>", "<<I3_P0:THIRD>>"]

        async def verify(client, sent):
            for page in (1, 2):
                accepted = await client.post(ROUTE, json=payload(page, (f"SOURCE_{page}",)))
                self.assertEqual(accepted.status_code, 200, accepted.text)
                self.assertEqual(accepted.json()["meta"]["conversation"]["commitStatus"],
                                 "committed")
            self.assertEqual(sent[1]["previous_response_id"], "resp_1")

            replay = await client.post(ROUTE, json=payload(1, ("NEW_SOURCE", "SECOND")))
            self.assertEqual(replay.status_code, 200, replay.text)
            self.assertEqual(replay.json()["meta"]["conversation"]["commitStatus"],
                             "not_committed_native_transcript_invalid")
            self.assertEqual(replay.json()["meta"]["conversation"]["historyTurns"], 0)
            self.assertEqual(replay.json()["missing"], ["I1_P0"])
            self.assertNotIn("previous_response_id", sent[2])

            following = await client.post(ROUTE, json=payload(3, ("SOURCE_3",)))
            self.assertEqual(following.status_code, 200, following.text)
            self.assertEqual(following.json()["meta"]["conversation"]["historyTurns"], 0)
            self.assertNotIn("previous_response_id", sent[3])
            self.assertIn("system_prompt", sent[3])
            self.assertEqual(len(sent), 4)

        self.request_sequence(answers, verify)


if __name__ == "__main__":
    unittest.main(verbosity=2)
