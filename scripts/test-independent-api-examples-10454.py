"""Local Independent API examples: real ingress/invocation/decoder, fake adapter.

No provider network, image OCR or chat history is used.  Synthetic provider
responses exercise actual production decoding and accepted-example eligibility.
The pipeline cache fixture mocks image processing only at its existing boundary;
its AI request still goes through the real ingress config and invocation.

Run with the API requirements installed:
  TP_AI_ENDPOINT_POLICY=personal PYTHONPATH=api python scripts/test-independent-api-examples-10454.py
An immutable baseline can be selected with TP_INDEPENDENT_API_TEST_SOURCE.
"""
from __future__ import annotations

import asyncio
import copy
import importlib
import json
import os
from pathlib import Path
import re
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager, asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(os.environ.get("TP_INDEPENDENT_API_TEST_SOURCE") or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(ROOT / "api"))
os.environ.setdefault("TP_AI_ENDPOINT_POLICY", "personal")
os.environ["TP_AI_WIRE_TRACE"] = "0"
os.environ["TP_USAGE_RECEIPTS"] = "off"

from backend.ai import markers
from backend.ai.clients.base import ChatResult
from backend.ai.translation import invocation
from backend.application.ai_translation.request_validation import build_config
from backend.jobs.stages.config import build_ai_config
from backend.jobs.stages.ai_repair import translate_with_one_repair
from backend.jobs import cache as job_cache

CAPABILITIES = {
    "reasoning": {"supported": False, "mandatory": False},
    "vision": {"supported": False},
    "structured_output": {"supported": False},
    "limits": {"contextTokens": 65536, "maxOutputTokens": 4096},
}
STYLE = "EXACT_SYNTHETIC_CUSTOM_STYLE"
SOURCE = "First accepted dialogue about the castle"
TARGET = "คำแปลจากครั้งแรก"
NEXT = "Next dialogue about the castle"
HUMAN_IDS = [f"H{i:02}" for i in range(1, 5)]


def example_module():
    try:
        return importlib.import_module("backend.ai.translation_paths.independent_examples")
    except ModuleNotFoundError as error:
        raise AssertionError("Local Independent API example ownership module is missing") from error


def human_ids(request):
    return re.findall(r"(?m)^(H[0-9]{2})\nEN:", request.user_parts[0])


class IndependentApiExamples(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.lock = threading.Lock()
        self.response_factory = None
        self.scope_id = self.id().rsplit(".", 1)[-1]
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch(
            "backend.ai.provider_resolution.discovered_model_capabilities",
            return_value=(True, CAPABILITIES),
        ))
        # Both are ordinary named Local providers; no discovery/network call
        # is needed with the explicit fixture model and default Thinking.
        for provider in ("jan", "textgen"):
            adapter = invocation.provider_registry.require(provider).adapter
            self.stack.enter_context(patch.object(adapter, "generate", side_effect=self.generate))
        try:
            self.reset_examples()
        except AssertionError:
            pass  # Baseline behavior checks must still reach real invocation.

    def reset_examples(self):
        try:
            example_module().store.clear()
        except AssertionError:
            pass  # Missing baseline state must not prevent behavior probes.

    def generate(self, request):
        with self.lock:
            self.requests.append(request)
        if self.response_factory:
            response = self.response_factory(request)
            if isinstance(response, BaseException):
                raise response
            if isinstance(response, ChatResult):
                return response
            text = response
        else:
            text = "\n".join(f"<<TP_{uid}:{TARGET}>>" for uid in request.expected_ids)
        return ChatResult(text, request.model, finish_reason="stop",
                          terminal_completed=True, terminal_evidence="synthetic_complete")

    def payload(self, ingress="api", *, enabled=True, owner=None, batch=None,
                document="https://reader.invalid/manga/42/chapter/1", provider="jan",
                model="fixture-local-model", endpoint="http://127.0.0.1:1337/v1",
                prompt=STYLE, source_lang="ja", batch_in_context=True,
                batch_in_metadata=True):
        owner = owner if owner is not None else "fixture-owner-" + self.scope_id
        batch = batch if batch is not None else "fixture-run-" + self.scope_id
        context = {"tp_tab_session": owner, "page_url": document, "page_index": 0}
        if batch_in_context:
            context["batch_id"] = batch
        metadata = {"image_id": "fixture-image-1"}
        if batch_in_metadata:
            metadata["batch_id"] = batch
        if ingress == "api":
            return {"mode": "lens_text", "source": "ai", "lang": "th",
                "context": context, "metadata": metadata,
                "ai": {"provider": provider, "model": model, "base_url": endpoint,
                    "api_key": "", "thinking": "default", "translation_mode": "independent",
                    "style_examples": enabled, "memory_mode": "off", "prompt": prompt,
                    "source_lang": source_lang}}
        return {"translationMode": "independent", "targetLang": "th",
            "batchId": batch, "userRunId": batch,
            "context": context, "metadata": metadata,
            "conversation": {"documentId": document},
            "provider": {"id": provider, "model": model, "baseUrl": endpoint,
                         "apiKey": "", "thinking": "default"},
            "memory": {"mode": "off", "styleExamples": enabled},
            "prompt": prompt, "sourceLang": source_lang,
            "repair": {"owner": "extension", "enabled": False}}

    def config(self, ingress, payload):
        return build_ai_config(payload, "lens_text", "ai") if ingress == "api" else build_config(payload)

    def invoke(self, payload, *, ingress="api", sources=None, target="th", cancel_check=None,
               validated=False):
        sources = [SOURCE] if sources is None else sources
        ai = self.config(ingress, payload)
        source = markers.apply(sources)
        if validated:
            result = translate_with_one_repair(source, target, ai, len(sources),
                translate_fn=invocation.translate, cancel_check=cancel_check)
        else:
            result = invocation.translate(source, target, ai, cancel_check=cancel_check)
        return result

    def execution_context(self, payload, executor, gate, *, src=SOURCE, cancel_check=None):
        from backend.application.ai_translation.context import TranslationContext
        ai = self.config("text", payload)
        return TranslationContext(
            request=SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
                ai_admission_gate=gate, ai_executor=executor))),
            payload=payload, request_context={}, units=({"id": "P0", "text": src},),
            target_lang="th", config=ai, marked=markers.apply([src]),
            trace_id="", correlation={}, route_identity={},
            requested_route="/api/ai/translate", resolved_provider="jan",
            resolved_model=ai.model, rate={"enabled": False}, unlimited=False,
            identity="fixture-api-execution", prompt_meta={}, cancel_check=cancel_check)

    def first_then_next(self, ingress="api"):
        payload = self.payload(ingress)
        first = self.invoke(payload, ingress=ingress, validated=ingress == "api")
        self.assertIn(TARGET, first["aiTextFull"], "first fixture result must really decode")
        second = self.invoke(payload, ingress=ingress, sources=[NEXT], validated=ingress == "api")
        return first, second, self.requests[-2:]

    def assert_story(self, request, src=SOURCE, tgt=TARGET):
        self.assertEqual(human_ids(request), [], "human corpus must stop after eligible pairs exist")
        self.assertIn(src, request.user_parts[0], "next prompt must contain the accepted source")
        self.assertIn(tgt, request.user_parts[0], "next prompt must contain its accepted translation")
        self.assertEqual(len(request.history_messages), 0, "examples are not replayed chat history")

    def test_api_engine_human_first_then_accepted_story(self):
        _, second, requests = self.first_then_next("api")
        self.assertEqual(human_ids(requests[0]), HUMAN_IDS)
        self.assert_story(requests[1])
        self.assertIs(second["meta"]["repair_attempted"], False)
        self.assertEqual(len(self.requests), 2, "no hidden summary or repair generation")

    def test_extension_text_ingress_human_first_then_accepted_story(self):
        _, _, requests = self.first_then_next("text")
        self.assertEqual(human_ids(requests[0]), HUMAN_IDS)
        self.assert_story(requests[1])
        self.assertEqual(len(self.requests), 2)

    def test_single_toggle_suppresses_human_and_story_and_does_not_learn(self):
        for ingress in ("api", "text"):
            with self.subTest(ingress=ingress):
                self.reset_examples()
                payload = self.payload(ingress)
                self.invoke(payload, ingress=ingress)
                off = copy.deepcopy(payload)
                if ingress == "api": off["ai"]["style_examples"] = False
                else: off["memory"]["styleExamples"] = False
                off_source, off_target = "Off-only source must not teach", "คำแปลตอนปิดตัวเลือก"
                self.response_factory = lambda request: f"<<TP_P0:{off_target}>>"
                self.invoke(off, ingress=ingress, sources=[off_source])
                off_request = self.requests[-1]
                self.assertEqual(human_ids(off_request), [])
                self.assertNotIn(SOURCE, off_request.user_parts[0])
                self.assertNotIn(TARGET, off_request.user_parts[0])
                self.response_factory = None
                self.invoke(payload, ingress=ingress, sources=[NEXT])
                self.assert_story(self.requests[-1])
                self.assertNotIn(off_source, self.requests[-1].user_parts[0])
                self.assertNotIn(off_target, self.requests[-1].user_parts[0])

    def test_off_from_empty_pool_keeps_next_on_request_human(self):
        for ingress in ("api", "text"):
            with self.subTest(ingress=ingress):
                self.reset_examples()
                self.invoke(self.payload(ingress, enabled=False), ingress=ingress)
                self.invoke(self.payload(ingress), ingress=ingress, sources=[NEXT])
                self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS)
                self.assertNotIn(SOURCE, self.requests[-1].user_parts[0])

    def test_system_user_remain_each_request_without_chat_or_images(self):
        self.first_then_next()
        for request in self.requests:
            self.assertEqual(request.system_text.count(STYLE), 1)
            self.assertNotIn(STYLE, request.user_parts[0])
            self.assertEqual(len(request.user_parts), 1)
            self.assertEqual(len(request.history_messages), 0)
            self.assertEqual(request.image_b64, "")
            self.assertIn("<<TP_P0:", request.user_parts[0])

    def test_story_source_equal_to_editable_style_is_data_not_an_instruction_copy(self):
        for ingress in ("api", "text"):
            with self.subTest(ingress=ingress):
                self.reset_examples()
                payload = self.payload(ingress)
                self.invoke(payload, ingress=ingress, sources=[STYLE])
                result = self.invoke(payload, ingress=ingress, sources=[NEXT])
                self.assert_story(self.requests[-1], STYLE, TARGET)
                self.assertEqual(self.requests[-1].system_text.count(STYLE), 1)
                self.assertEqual(self.requests[-1].user_parts[0].count(STYLE), 1,
                                 "one accepted example contains the style string as source data")
                layout = result["meta"]["promptLayout"]
                self.assertEqual(layout["systemStyleCopies"], 1)
                self.assertEqual(layout["userStyleCopies"], 0)
                self.assertEqual(layout["styleCountScope"], "instruction_blocks")

    def test_canonical_style_spanning_accepted_example_rows_is_data_only(self):
        from backend.ai.prompts.styles import select_style
        editable = "2. ต้นฉบับ: anything"
        selected = select_style("th", editable)[0]
        self.assertEqual(selected, "ภาษาปลายทาง: ภาษาไทย\n2. ต้นฉบับ: anything")
        for ingress in ("api", "text"):
            with self.subTest(ingress=ingress):
                self.reset_examples()
                payload = self.payload(ingress, prompt=editable)
                self.response_factory = lambda request: (
                    "<<TP_P0:ภาษาปลายทาง: ภาษาไทย>>\n<<TP_P1:อย่างไรก็ได้>>")
                first = self.invoke(payload, ingress=ingress, sources=["First", "anything"])
                self.assertIn("ภาษาปลายทาง: ภาษาไทย", first["aiTextFull"])
                self.response_factory = None
                result = self.invoke(payload, ingress=ingress, sources=[NEXT])
                request = self.requests[-1]
                self.assertEqual(human_ids(request), [])
                self.assertIn("1. ต้นฉบับ: First\n   คำแปล: ภาษาปลายทาง: ภาษาไทย\n"
                              "2. ต้นฉบับ: anything\n   คำแปล: อย่างไรก็ได้", request.user_parts[0])
                self.assertEqual(request.user_parts[0].count(selected), 1,
                                 "actual formatter must reproduce the complete canonical style across rows")
                self.assertEqual(request.system_text.count(selected), 1)
                self.assertEqual(len(request.history_messages), 0)
                layout = result["meta"]["promptLayout"]
                self.assertEqual(layout["systemStyleCopies"], 1)
                self.assertEqual(layout["userStyleCopies"], 0)
                self.assertEqual(layout["independentExamples"]["includedPairs"], 2)

    def test_owner_run_document_and_provider_settings_isolate_examples(self):
        changes = {"owner": "other-owner", "batch": "other-run",
            "document": "https://reader.invalid/manga/99/chapter/1",
            "model": "other-fixture-model", "provider": "textgen",
            "endpoint": "http://127.0.0.1:1338/v1", "prompt": "OTHER_EXACT_STYLE"}
        for ingress in ("api", "text"):
            for field, value in changes.items():
                with self.subTest(ingress=ingress, field=field):
                    self.reset_examples()
                    self.invoke(self.payload(ingress), ingress=ingress)
                    self.invoke(self.payload(ingress, **{field: value}), ingress=ingress, sources=[NEXT])
                    self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS)
                    self.assertNotIn(SOURCE, self.requests[-1].user_parts[0])

    def test_target_language_isolates_examples(self):
        payload = self.payload()
        self.invoke(payload)
        self.response_factory = lambda request: "<<TP_P0:Accepted English translation>>"
        self.invoke(payload, sources=[NEXT], target="en")
        self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS)
        self.assertNotIn(SOURCE, self.requests[-1].user_parts[0])
        self.assertNotIn(TARGET, self.requests[-1].user_parts[0])

    def test_mixed_detected_source_language_keeps_same_run_examples(self):
        for ingress in ("api", "text"):
            with self.subTest(ingress=ingress):
                self.reset_examples()
                self.invoke(self.payload(ingress, source_lang="ja"), ingress=ingress)
                self.invoke(self.payload(ingress, source_lang="ko"), ingress=ingress, sources=[NEXT])
                self.assert_story(self.requests[-1])

    def test_full_owner_identifiers_do_not_collide_at_shared_prefix(self):
        prefix = "a" * 40
        self.invoke(self.payload(owner=prefix + "owner-one"))
        self.invoke(self.payload(owner=prefix + "owner-two"), sources=[NEXT])
        self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS)
        self.assertNotIn(SOURCE, self.requests[-1].user_parts[0])

    def test_context_and_metadata_batch_aliases_reuse_same_owned_run(self):
        for ingress in ("api", "text"):
            with self.subTest(ingress=ingress):
                self.reset_examples()
                self.invoke(self.payload(ingress, batch_in_context=False), ingress=ingress)
                self.invoke(self.payload(ingress, batch_in_metadata=False), ingress=ingress, sources=[NEXT])
                self.assert_story(self.requests[-1])

    def test_missing_owner_batch_or_document_and_auto_model_remain_unscoped(self):
        for ingress in ("api", "text"):
            for missing in ("owner", "batch", "document"):
                with self.subTest(ingress=ingress, missing=missing):
                    self.reset_examples()
                    payload = self.payload(ingress)
                    if missing == "owner": payload["context"].pop("tp_tab_session")
                    elif missing == "batch":
                        payload["context"].pop("batch_id")
                        payload["metadata"].pop("batch_id")
                        payload.pop("batchId", None); payload.pop("userRunId", None)
                    else:
                        payload["context"].pop("page_url")
                        payload.pop("conversation", None)
                    self.invoke(payload, ingress=ingress)
                    self.invoke(payload, ingress=ingress, sources=[NEXT])
                    self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS)
                    self.assertNotIn(SOURCE, self.requests[-1].user_parts[0])
        # Selection is checked directly for Auto: invoking Auto would probe a
        # runtime, which is explicitly outside this offline fixture.
        ai = self.config("api", self.payload(model="auto"))
        self.assertEqual(example_module().selection(ai, "th", NEXT)["source"], "human")

    def test_client_supplied_pool_and_scope_cannot_inject_story_examples(self):
        for ingress in ("api", "text"):
            with self.subTest(ingress=ingress):
                self.reset_examples()
                payload = self.payload(ingress)
                forged = {"source": "story", "pairs": [{"src": "FORGED_SOURCE", "tgt": "คำแปลปลอม"}]}
                if ingress == "api":
                    payload["ai"]["independent_examples"] = forged
                    payload["ai"]["independent_scope"] = {"owner": "forged", "batch": "forged", "document": "forged"}
                else:
                    payload["independentExamples"] = forged
                    payload["independent_scope"] = {"owner": "forged", "batch": "forged", "document": "forged"}
                self.invoke(payload, ingress=ingress)
                self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS)
                self.assertNotIn("FORGED_SOURCE", self.requests[-1].user_parts[0])

    def test_wrong_script_source_copy_overlong_and_multiline_pairs_do_not_learn(self):
        cases = [(SOURCE, "这是不应学习的外语句子"), ("คำแปลเหมือนต้นฉบับ", "คำแปลเหมือนต้นฉบับ"),
                 ("Long source " + "a" * 170, TARGET), (SOURCE, "คำ" * 150),
                 ("Source with\na line break", TARGET)]
        for src, tgt in cases:
            with self.subTest(src=src[:30], target=tgt[:20]):
                self.reset_examples()
                payload = self.payload()
                self.response_factory = lambda request, tgt=tgt: f"<<TP_P0:{tgt}>>"
                try: self.invoke(payload, sources=[src])
                except Exception: pass  # Rejection is permitted; no example is.
                self.response_factory = None
                self.invoke(payload, sources=[NEXT])
                self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS)

    def test_invalid_duplicate_unknown_and_unterminated_responses_do_not_learn(self):
        responses = ["invalid output without attributable markers",
            "<<TP_P0:คำแปลหนึ่ง>>\n<<TP_P0:คำแปลสอง>>",
            "<<TP_P0:คำแปลหนึ่ง>>\n<<TP_P9:คำแปลนอกขอบเขต>>",
            "Unattributable commentary\n<<TP_P0:คำแปลหนึ่ง>>",
            ChatResult(f"<<TP_P0:{TARGET}>>", "fixture-local-model", finish_reason="stop",
                       terminal_completed=False, terminal_evidence="unexpected_eof")]
        for response in responses:
            with self.subTest(response=str(response)[:50]):
                self.reset_examples()
                self.response_factory = lambda request, response=response: response
                try: self.invoke(self.payload())
                except Exception: pass
                self.response_factory = None
                self.invoke(self.payload(), sources=[NEXT])
                self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS)

    def test_korean_han_only_translation_cannot_become_accepted_example(self):
        payload = self.payload()
        self.response_factory = lambda request: "<<TP_P0:这是汉字文本>>"
        self.invoke(payload, target="ko")
        self.response_factory = lambda request: "<<TP_P0:한국어 번역입니다>>"
        self.invoke(payload, sources=[NEXT], target="ko")
        self.assertNotIn("这是汉字文本", self.requests[-1].user_parts[0])
        self.assertNotIn(SOURCE, self.requests[-1].user_parts[0])
        # Korean has no shipped human bootstrap; a genuine Hangul pair can
        # nevertheless become a private story example on the following turn.
        self.invoke(payload, sources=["Third Korean page source"], target="ko")
        self.assert_story(self.requests[-1], NEXT, "한국어 번역입니다")

    def test_partial_result_learns_only_attributable_valid_pair(self):
        payload = self.payload()
        omitted_source = "Omitted dialogue must not be taught"
        self.response_factory = lambda request: f"<<TP_P0:{TARGET}>>"
        self.invoke(payload, sources=[SOURCE, omitted_source])
        self.response_factory = None
        self.invoke(payload, sources=[NEXT])
        self.assert_story(self.requests[-1])
        self.assertNotIn(omitted_source, self.requests[-1].user_parts[0])

    def test_provider_failure_releases_scope_without_learning(self):
        self.response_factory = lambda request: RuntimeError("synthetic provider failure")
        with self.assertRaises(RuntimeError): self.invoke(self.payload())
        self.response_factory = None
        self.invoke(self.payload(), sources=[NEXT])
        self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS)

    def test_predispatch_cancel_sends_nothing_and_does_not_learn(self):
        with self.assertRaises(Exception): self.invoke(self.payload(), cancel_check=lambda: True)
        self.assertEqual(len(self.requests), 0)
        self.invoke(self.payload(), sources=[NEXT])
        self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS)

    def test_cancel_after_provider_result_does_not_learn(self):
        cancelled = threading.Event()
        def response(request):
            cancelled.set()
            return f"<<TP_P0:{TARGET}>>"
        self.response_factory = response
        try: self.invoke(self.payload(), cancel_check=cancelled.is_set)
        except Exception: pass
        self.response_factory = None
        self.invoke(self.payload(), sources=[NEXT])
        self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS)

    def test_no_text_first_page_does_not_become_a_story_example(self):
        skipped = self.invoke(self.payload(), sources=["!"])
        self.assertEqual(skipped["meta"]["generationAttempts"], 0)
        self.assertEqual(len(self.requests), 0)
        self.invoke(self.payload(), sources=[NEXT])
        self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS)

    def test_repair_reuses_owned_examples_without_history_or_repair_instructions(self):
        payload = self.payload("text")
        self.invoke(payload, ingress="text")
        repair = copy.deepcopy(payload)
        repair["conversation"]["branch"] = "repair"
        repair["repair"]["reason"] = "wrong_target_script"
        self.invoke(repair, ingress="text", sources=["Remaining source only"])
        self.assert_story(self.requests[-1])
        self.assertEqual(len(self.requests), 2)
        self.assertNotIn("wrong_target_script", self.requests[-1].user_parts[0])

    def test_same_scope_waits_for_acceptance_while_other_scope_can_overlap(self):
        first_started, release_first = threading.Event(), threading.Event()
        same_started, same_dispatched, other_dispatched = threading.Event(), threading.Event(), threading.Event()
        first_source, same_source, other_source = "First blocked source", "Same run next source", "Other run source"
        def response(request):
            user = request.user_parts[0]
            if f"<<TP_P0:{first_source}>>" in user:
                first_started.set()
                if not release_first.wait(5): raise AssertionError("test release did not arrive")
            elif f"<<TP_P0:{same_source}>>" in user: same_dispatched.set()
            elif f"<<TP_P0:{other_source}>>" in user: other_dispatched.set()
            return f"<<TP_P0:{TARGET}>>"
        self.response_factory = response
        def same_call():
            same_started.set()
            return self.invoke(self.payload(), sources=[same_source])
        with ThreadPoolExecutor(max_workers=3) as pool:
            first = pool.submit(self.invoke, self.payload(), sources=[first_source])
            try:
                self.assertTrue(first_started.wait(2))
                same = pool.submit(same_call)
                self.assertTrue(same_started.wait(2))
                other = pool.submit(self.invoke, self.payload(owner="different-owner"), sources=[other_source])
                self.assertTrue(other_dispatched.wait(2), "different scope must not wait for first run")
                self.assertFalse(same_dispatched.wait(.15), "same scope must wait for prior accepted result")
                other.result(timeout=2)
            finally:
                release_first.set()
            first.result(timeout=2); same.result(timeout=2)
        same_request = next(r for r in self.requests if f"<<TP_P0:{same_source}>>" in r.user_parts[0])
        self.assert_story(same_request, first_source, TARGET)
        self.assertEqual(len(self.requests), 3)

    def test_async_wait_cancellation_releases_queued_ticket(self):
        module = example_module()
        ai = self.config("api", self.payload())
        async def check():
            async with module.async_execution_scope(ai, "th"):
                entered = asyncio.Event()
                async def waiter():
                    # Start from an independent context, as a separate HTTP
                    # task does; inherited same-request context is reentrant.
                    async with module.async_execution_scope(self.config("api", self.payload()), "th"):
                        entered.set()
                import contextvars
                task = asyncio.create_task(waiter(), context=contextvars.Context())
                await asyncio.sleep(.1)
                self.assertFalse(entered.is_set())
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
            async with module.async_execution_scope(self.config("api", self.payload()), "th"):
                pass
        asyncio.run(check())

    def test_text_api_waits_outside_admission_and_copies_owned_executor_context(self):
        from backend.application.ai_translation import provider_execution
        from backend.application.ai_translation.context import TranslationContext
        started, release = threading.Event(), threading.Event()
        gate_entered = []
        first_source, next_source = "First executor-owned source", "Next executor-owned source"
        class Gate:
            @asynccontextmanager
            async def slot(_self, identity):
                gate_entered.append(identity)
                yield
        def response(request):
            if f"<<TP_P0:{first_source}>>" in request.user_parts[0]:
                started.set()
                if not release.wait(5): raise AssertionError("executor release did not arrive")
            return f"<<TP_P0:{TARGET}>>"
        self.response_factory = response
        async def check(executor):
            request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
                ai_admission_gate=Gate(), ai_executor=executor)))
            def context(src, identity, owner=None):
                payload = self.payload("text", owner=owner)
                ai = self.config("text", payload)
                return TranslationContext(request=request, payload=payload,
                    request_context={}, units=({"id": "P0", "text": src},),
                    target_lang="th", config=ai, marked=markers.apply([src]),
                    trace_id="", correlation={}, route_identity={},
                    requested_route="/api/ai/translate", resolved_provider="jan",
                    resolved_model=ai.model, rate={"enabled": False}, unlimited=False,
                    identity=identity, prompt_meta={})
            first = asyncio.create_task(provider_execution.run(context(first_source, "first"), rate_wait_ms=0))
            same = other = None
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                same = asyncio.create_task(provider_execution.run(context(next_source, "same"), rate_wait_ms=0))
                other = asyncio.create_task(provider_execution.run(
                    context("Other executor-owned source", "other", "another-owner"), rate_wait_ms=0))
                await asyncio.wait_for(other, timeout=2)
                self.assertEqual(gate_entered, ["first", "other"],
                                 "same-run dependency must wait before entering AI admission")
                self.assertFalse(same.done())
            finally:
                release.set()
                await asyncio.gather(first, *[task for task in (same, other) if task is not None],
                                     return_exceptions=True)
            self.assertEqual(gate_entered, ["first", "other", "same"])
            self.assertIn(TARGET, first.result().result["aiTextFull"])
            self.assertIn(TARGET, same.result().result["aiTextFull"])
        with ThreadPoolExecutor(max_workers=3) as executor:
            asyncio.run(check(executor))
        same_request = next(r for r in self.requests if f"<<TP_P0:{next_source}>>" in r.user_parts[0])
        self.assert_story(same_request, first_source, TARGET)
        self.assertEqual(len(self.requests), 3)

    def test_cancelled_text_api_keeps_executor_ownership_until_thread_exits(self):
        from backend.application.ai_translation import provider_execution
        from backend.application.ai_translation.context import TranslationContext
        started, release = threading.Event(), threading.Event()
        gate_active = set()
        class Gate:
            @asynccontextmanager
            async def slot(_self, identity):
                gate_active.add(identity)
                try: yield
                finally: gate_active.remove(identity)
        def response(request):
            started.set()
            if not release.wait(5): raise AssertionError("cancelled executor was not released")
            return f"<<TP_P0:{TARGET}>>"
        self.response_factory = response
        async def check(executor):
            payload = self.payload("text")
            ai = self.config("text", payload)
            request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
                ai_admission_gate=Gate(), ai_executor=executor)))
            ctx = TranslationContext(request=request, payload=payload,
                request_context={}, units=({"id": "P0", "text": SOURCE},),
                target_lang="th", config=ai, marked=markers.apply([SOURCE]),
                trace_id="", correlation={}, route_identity={},
                requested_route="/api/ai/translate", resolved_provider="jan",
                resolved_model=ai.model, rate={"enabled": False}, unlimited=False,
                identity="cancelled-executor", prompt_meta={})
            task = asyncio.create_task(provider_execution.run(ctx, rate_wait_ms=0))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                task.cancel()
                await asyncio.sleep(.05)
                self.assertFalse(task.done(), "HTTP cancel must drain its still-running executor")
                self.assertEqual(gate_active, {"cancelled-executor"})
                self.assertTrue(example_module().cache_snapshot(ai, "th")["busy"])
            finally:
                release.set()
                await asyncio.gather(task, return_exceptions=True)
            self.assertTrue(task.cancelled())
            self.assertEqual(gate_active, set())
            self.assertFalse(example_module().cache_snapshot(ai, "th")["busy"])
        with ThreadPoolExecutor(max_workers=1) as executor:
            asyncio.run(check(executor))
        self.response_factory = None
        self.invoke(self.payload("text"), ingress="text", sources=[NEXT])
        self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS,
                         "cancelled executor output cannot become an accepted example")

    def test_queued_event_cancellation_is_http409_without_dispatch_or_ticket_leak(self):
        import contextvars
        from fastapi import HTTPException
        from backend.application.ai_translation import provider_execution
        module = example_module()
        cancelled, waiting = threading.Event(), threading.Event()
        admission_entries = []
        class Gate:
            @asynccontextmanager
            async def slot(_self, identity):
                admission_entries.append(identity)
                yield
        def checker():
            waiting.set()
            return cancelled.is_set()
        async def check(executor):
            ctx = self.execution_context(self.payload("text"), executor, Gate(), cancel_check=checker)
            async with module.async_execution_scope(ctx.config, "th"):
                task = asyncio.create_task(provider_execution.run(ctx, rate_wait_ms=0),
                                           context=contextvars.Context())
                try:
                    self.assertTrue(await asyncio.to_thread(waiting.wait, 2))
                    self.assertFalse(task.done())
                    cancelled.set()
                    with self.assertRaises(HTTPException) as caught:
                        await asyncio.wait_for(task, timeout=2)
                    error = caught.exception
                    self.assertEqual(error.status_code, 409)
                    self.assertEqual(error.detail["code"], "cancelled")
                    self.assertEqual(error.detail["providerAttempts"], 0)
                    self.assertEqual(error.detail["generationAttempts"], 0)
                    self.assertIs(error.detail["requestDispatched"], False)
                    self.assertEqual(admission_entries, [])
                    self.assertEqual(len(self.requests), 0)
                finally:
                    if not task.done(): task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            self.assertFalse(module.cache_snapshot(ctx.config, "th")["busy"],
                             "cancelled queue ticket must be removed when predecessor releases")
            cancelled.clear()
            result = await asyncio.wait_for(provider_execution.run(ctx, rate_wait_ms=0), timeout=2)
            self.assertIn(TARGET, result.result["aiTextFull"])
        with ThreadPoolExecutor(max_workers=1) as executor:
            asyncio.run(check(executor))
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(human_ids(self.requests[0]), HUMAN_IDS)

    def test_post_scope_cancellation_preserves_actual_usage_and_discards_learning(self):
        from fastapi import HTTPException
        from backend.application.ai_translation import provider_execution
        cancelled = threading.Event()
        completed = {}
        class Gate:
            @asynccontextmanager
            async def slot(_self, identity):
                yield
        self.response_factory = lambda request: ChatResult(
            f"<<TP_P0:{TARGET}>>", request.model, input_tokens=37, output_tokens=11,
            total_tokens=48, usage_source="synthetic_provider_usage", finish_reason="stop",
            terminal_completed=True, terminal_evidence="synthetic_complete")
        actual_run = provider_execution._run
        async def finish_then_cancel(ctx, **kwargs):
            result = await actual_run(ctx, **kwargs)
            completed["result"] = result.result
            cancelled.set()  # Only the outer private scope exit observes this.
            return result
        async def check(executor):
            ctx = self.execution_context(self.payload("text"), executor, Gate(),
                                         cancel_check=cancelled.is_set)
            with patch.object(provider_execution, "_run", side_effect=finish_then_cancel):
                with self.assertRaises(HTTPException) as caught:
                    await provider_execution.run(ctx, rate_wait_ms=0)
            error = caught.exception
            self.assertEqual(error.status_code, 409)
            self.assertEqual(error.detail["code"], "cancelled")
            self.assertEqual(error.detail["providerAttempts"], 1)
            self.assertEqual(error.detail["generationAttempts"], 1)
            self.assertIs(error.detail["requestDispatched"], True)
            generation = error.detail["structuralDetails"]["generationMeta"]
            self.assertEqual(generation["provider"], "jan")
            self.assertEqual(generation["model"], "fixture-local-model")
            self.assertEqual(generation["usage"], completed["result"]["meta"]["usage"])
            self.assertEqual(generation["usage"]["inputTokens"], 37)
            self.assertEqual(generation["usage"]["outputTokens"], 11)
            self.assertEqual(generation["usage"]["totalTokens"], 48)
            self.assertFalse(example_module().cache_snapshot(ctx.config, "th")["busy"])
        with ThreadPoolExecutor(max_workers=1) as executor:
            asyncio.run(check(executor))
        cancelled.clear()
        self.response_factory = None
        self.invoke(self.payload("text"), ingress="text", sources=[NEXT])
        self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS,
                         "a successful provider result rejected at scope exit must not teach examples")

    def test_full_api_owned_run_waits_before_ai_stage_admission(self):
        from backend.jobs.stages import ai_stage
        started, release, same_started = threading.Event(), threading.Event(), threading.Event()
        entered = []
        gate_lock = threading.Lock()
        first_source, next_source = "First canonical stage source", "Next canonical stage source"
        @contextmanager
        def stage_slot(stage, identity, **kwargs):
            self.assertEqual(stage, "ai")
            with gate_lock: entered.append(identity)
            yield
        def response(request):
            if f"<<TP_P0:{first_source}>>" in request.user_parts[0]:
                started.set()
                if not release.wait(5): raise AssertionError("stage release did not arrive")
            return f"<<TP_P0:{TARGET}>>"
        self.response_factory = response
        def run(src, identity, owner=None):
            if identity == "same": same_started.set()
            payload = self.payload(owner=owner)
            ai = self.config("api", payload)
            # These are synthetic canonical paragraphs at the existing OCR/
            # grouping boundary. The production conservation reader, AI stage,
            # one-generation/script check and accepted-pair transaction run.
            original = {"paragraphs": [{"text": src}]}
            canonical = {"schema": "tp.canonical-original-tree/1",
                "coverage": {"complete": True},
                "paragraphs": [{"text": src, "ai_eligible": True,
                    "source": {"contract": "tp.ai-source-members/1", "rawParagraphIndices": [0]}}]}
            out = {}
            ai_stage.run_ai_layer(out, original, None, ai, "th", 100, 100,
                "synthetic-font", "synthetic-font", canonical, admission_identity=identity)
            return out
        with patch.object(ai_stage, "stage_slot", stage_slot), \
             patch.object(ai_stage, "build_ai_tree", return_value={"paragraphs": []}), \
             patch.object(ai_stage.render_stage, "annotate_text_light", return_value=None), \
             patch.object(ai_stage, "render_tree_overlay", return_value="<div>synthetic overlay</div>"), \
             ThreadPoolExecutor(max_workers=3) as pool:
            first = pool.submit(run, first_source, "first")
            same = other = None
            try:
                self.assertTrue(started.wait(2))
                same = pool.submit(run, next_source, "same")
                self.assertTrue(same_started.wait(2))
                other = pool.submit(run, "Other canonical stage source", "other", "other-stage-owner")
                self.assertIn(TARGET, other.result(timeout=2)["AiTextFull"])
                self.assertEqual(entered, ["first", "other"],
                                 "owned-run wait must precede full API AI admission")
                self.assertFalse(same.done())
            finally:
                release.set()
            self.assertIn(TARGET, first.result(timeout=2)["AiTextFull"])
            self.assertIn(TARGET, same.result(timeout=2)["AiTextFull"])
        self.assertEqual(entered, ["first", "other", "same"])
        same_request = next(r for r in self.requests if f"<<TP_P0:{next_source}>>" in r.user_parts[0])
        self.assert_story(same_request, first_source, TARGET)
        self.assertEqual(len(self.requests), 3)

    def signature(self, payload, target="th"):
        module = example_module()
        ai = self.config("api", payload)
        with module.execution_scope(ai, target):
            return module.cache_signature(ai, target), job_cache.build_cache_key(
                "fixed-image-hash", target, "lens_text", "ai", ai, owner_scope="fixture-cache-owner")

    def test_cache_signature_changes_on_new_accepted_pool_and_no_rejected_learning(self):
        payload = self.payload()
        empty, empty_key = self.signature(payload)
        self.assertEqual(self.signature(payload), (empty, empty_key))
        self.invoke(payload)
        learned, learned_key = self.signature(payload)
        self.assertNotEqual(learned, empty)
        self.assertNotEqual(learned_key, empty_key, "actual job cache must include the effective examples")
        self.invoke(payload)  # Same accepted source/translation is deduplicated.
        self.assertEqual(self.signature(payload), (learned, learned_key))
        self.response_factory = lambda request: "<<TP_P0:这不能成为泰语例子>>"
        self.invoke(payload, sources=["Rejected extra source"])
        self.assertEqual(self.signature(payload), (learned, learned_key))

    def test_off_cache_inputs_ignore_private_pool_and_do_not_expose_example_text(self):
        module = example_module()
        payload, off = self.payload(), self.payload(enabled=False)
        off_signature, off_key = self.signature(off)
        self.assertEqual(off_signature, "")
        self.assertNotIn("examples_pool_", off_key)
        self.invoke(payload)
        self.assertEqual(self.signature(off), (off_signature, off_key))
        self.invoke(payload, sources=[NEXT])
        self.assertEqual(self.signature(off), (off_signature, off_key))
        learned_signature, learned_key = self.signature(payload)
        self.assertNotEqual(learned_key, off_key)
        for private_text in (SOURCE, NEXT, TARGET, payload["context"]["tp_tab_session"],
                             payload["context"]["batch_id"]):
            self.assertNotIn(private_text, learned_key)
            self.assertNotIn(private_text, learned_signature)
        ai = self.config("api", off)
        self.assertEqual(module.cache_snapshot(ai, "th"), {"signature": "", "busy": False})

    def test_auto_and_unscoped_cache_snapshot_never_observe_other_owned_pool(self):
        module = example_module()
        owned = self.payload()
        variants = [self.payload(model="auto"), self.payload()]
        variants[1]["context"].pop("tp_tab_session")
        before = [self.signature(payload) for payload in variants]
        ai = self.config("api", owned)
        with module.execution_scope(ai, "th"):
            self.assertTrue(module.cache_snapshot(ai, "th")["busy"])
            for payload in variants:
                variant = self.config("api", payload)
                self.assertEqual(module.selection(variant, "th", NEXT)["source"], "human")
                self.assertFalse(module.cache_snapshot(variant, "th")["busy"])
            invocation.translate(markers.apply([SOURCE]), "th", ai)
        self.assertEqual([self.signature(payload) for payload in variants], before)
        for payload in variants:
            self.assertEqual(module.selection(self.config("api", payload), "th", NEXT)["source"], "human")

    def test_request_pool_and_cache_signature_are_frozen_until_scope_exit(self):
        module = example_module()
        payload = self.payload()
        ai = self.config("api", payload)
        with module.execution_scope(ai, "th"):
            before = module.cache_signature(ai, "th")
            self.assertEqual(module.selection(ai, "th", SOURCE)["source"], "human")
            invocation.translate(markers.apply([SOURCE]), "th", ai)
            self.assertEqual(module.cache_signature(ai, "th"), before)
            self.assertEqual(module.selection(ai, "th", NEXT)["source"], "human",
                             "pending acceptance cannot alter this request snapshot")
        with module.execution_scope(self.config("api", payload), "th"):
            self.assertNotEqual(module.cache_signature(self.config("api", payload), "th"), before)
            self.assertEqual(module.selection(self.config("api", payload), "th", NEXT)["source"], "story")

    def test_outer_acceptance_failure_discards_staged_pairs(self):
        module = example_module()
        payload = self.payload()
        ai = self.config("api", payload)
        with self.assertRaisesRegex(RuntimeError, "acceptance failed"):
            with module.execution_scope(ai, "th"):
                invocation.translate(markers.apply([SOURCE]), "th", ai)
                raise RuntimeError("acceptance failed after decoded output")
        self.invoke(payload, sources=[NEXT])
        self.assertEqual(human_ids(self.requests[-1]), HUMAN_IDS)

    def test_pipeline_cache_hit_preserves_same_owned_examples_without_new_call(self):
        from backend.jobs import pipeline
        payload = self.payload()
        payload["src"] = "https://fixture.invalid/image.png"
        payload["idempotency_key"] = self.scope_id
        # Replace only external image boundaries and the renderer. The real
        # pipeline config, cache key, invocation, decoder and example store run.
        @contextmanager
        def temporary_image(_bytes, _mime):
            yield "/synthetic-image-path-not-read"
        def process_image(_path, lang, _mode, ai, **kwargs):
            answer = translate_with_one_repair(markers.apply([SOURCE]), lang, ai, 1,
                translate_fn=invocation.translate, cancel_check=kwargs.get("cancel_check"))
            return {"AiTextFull": answer["aiTextFull"],
                    "Ai": {"meta": answer["meta"], "aihtml": "<div>synthetic verified overlay</div>"}}
        with patch.object(pipeline, "extract_image_bytes", return_value=(b"same-fixture-image-" + self.scope_id.encode(), "image/png")), \
             patch.object(pipeline, "temporary_image_file", temporary_image), \
             patch.object(pipeline, "process_image", side_effect=process_image):
            one = pipeline.process_payload(copy.deepcopy(payload))
            two = pipeline.process_payload(copy.deepcopy(payload))
            before = len(self.requests)
            three = pipeline.process_payload(copy.deepcopy(payload))
        self.assertIn(TARGET, one["AiTextFull"])
        self.assertIn(TARGET, two["AiTextFull"])
        self.assertEqual(three["perf"]["cache"], "hit")
        self.assertEqual(len(self.requests), before, "cache hit must not create a provider request")
        self.assertEqual(len(self.requests), 2, "only changed effective example inputs require a fresh request")
        self.assert_story(self.requests[-1])



if __name__ == "__main__":
    unittest.main(verbosity=2)
