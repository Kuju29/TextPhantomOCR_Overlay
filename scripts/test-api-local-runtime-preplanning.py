"""Live Local READY evidence, model identity, and no-network preflight regressions."""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from backend.ai.providers import local_ollama, local_openai_runtime, local_koboldcpp
from backend.ai.provider_resolution import forget_model_capabilities, remember_model_capabilities
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.invocation import translate
from backend.ai.translation_paths import ready_batch
from backend.ai.translation_paths.batch_policy import select_rows, learn
from backend.ai.translation_paths.mode import descriptor
from backend.ai.workload import WorkloadBudgetError
from backend.ai import markers
from backend.config import settings
from backend.security import UnsafeBaseUrl


class LocalRuntimePlanning(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, {
            "TP_CONVERSATION_STATE_FILE": self.tmp.name + "/c.db",
            "TP_AI_WIRE_TRACE": "1",
            "TP_AI_WIRE_TRACE_DIR": self.tmp.name + "/wire",
            "TP_USAGE_RECEIPTS": "off",
            "TP_AI_ENDPOINT_POLICY": "personal",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.policy = patch("backend.security.settings",
            replace(settings, ai_endpoint_policy="personal"))
        self.policy.start()
        self.addCleanup(self.policy.stop)
        self.calls = []
        self.completion_payloads = []
        self.completion_answers = []
        self.context = 32768
        self.kobold_metadata_missing = False
        self.kobold_extra_model = False
        self.model = "selected"
        self.real_client = httpx.Client

    def compat_handler(self, req):
        self.calls.append((req.method, req.url.path))
        if req.method == "GET":
            self.assertEqual(req.url.path, "/v1/models")
            item = {"id": self.model}
            if self.context is not None:
                item.update(max_model_len=self.context,
                            meta={"n_ctx": self.context, "n_ctx_train": 131072})
            return httpx.Response(200, json={"data": [item]})
        self.assertEqual(req.url.path, "/v1/chat/completions")
        body = json.loads(req.content)
        self.completion_payloads.append(body)
        current = body["messages"][-1]["content"]
        unit_ids = re.findall(r"<<(I\d+_P\d+):", current)
        if not unit_ids:
            unit_ids = ["TP_P0"]
        answer = "\n".join(f"<<{unit}:คำแปล>>" for unit in unit_ids)
        self.completion_answers.append(answer)
        chunks = [
            {"choices": [{"delta": {"content": answer}, "finish_reason": None}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {
                "prompt_tokens": 120, "completion_tokens": 32, "total_tokens": 152}},
        ]
        return httpx.Response(200, text="".join("data: " + json.dumps(chunk) + "\n\n"
                                              for chunk in chunks) + "data: [DONE]\n\n",
                              headers={"content-type": "text/event-stream"})

    def patch_compat(self):
        return patch.object(local_openai_runtime.httpx, "Client",
            side_effect=lambda *, timeout: self.real_client(
                transport=httpx.MockTransport(self.compat_handler), timeout=timeout))

    def kobold_handler(self, req):
        if req.url.path == "/v1/chat/completions":
            return self.compat_handler(req)
        self.calls.append((req.method, req.url.path))
        self.assertEqual(req.method, "GET")
        if req.url.path == "/v1/models":
            rows = [{"id": self.model}]
            if self.kobold_extra_model:
                rows.append({"id": "other"})
            return httpx.Response(200, json={"data": rows})
        self.assertEqual(req.url.path, "/api/extra/true_max_context_length")
        return (httpx.Response(404) if self.kobold_metadata_missing else
                httpx.Response(200, json={"value": self.context}))

    def patch_kobold(self):
        return patch.object(local_openai_runtime.httpx, "Client",
            side_effect=lambda *, timeout: self.real_client(
                transport=httpx.MockTransport(self.kobold_handler), timeout=timeout))

    def config(self, provider="vllm", *, text_index=1, base=None):
        return AiConfig(provider=provider, api_key="", model=self.model,
            base_url=base or ("http://localhost:8000/v1" if provider == "vllm"
                              else "http://localhost:8080/v1"),
            source_lang="en", thinking="minimum", translation_mode="conversation",
            output_contract="compact_markers_v1",
            conversation=descriptor({"documentId": self.tmp.name, "pageId": str(text_index)},
                context={"tp_tab_session": self.tmp.name}))

    def rows(self, ai, text):
        class Ticket:
            pass
        ticket = Ticket()
        ticket.ai = ai
        return [{"ticket": ticket, "index": 0, "text": text}]

    def test_current_32k_to_4k_and_back_changes_ready_admission(self):
        for provider in ("vllm", "llamacpp"):
            with self.subTest(provider=provider), self.patch_compat():
                ai = self.config(provider)
                self.context = 32768
                rows = self.rows(ai, "ก" * 4500)
                chosen, estimate, _ = select_rows(rows, ai, "th", {"successes": 0})
                self.assertEqual(chosen, rows)
                self.assertEqual(estimate["_preparedCapabilities"]["limits"]["contextTokens"], 32768)
                self.context = 4096
                with self.assertRaises(WorkloadBudgetError):
                    select_rows(rows, ai, "th", {"successes": 0})
                self.context = 32768
                again, _, _ = select_rows(rows, ai, "th", {"successes": 0})
                self.assertEqual(again, rows)
                self.assertEqual(self.calls, [("GET", "/v1/models")] * 3)
                self.calls.clear()
        # The opposite direction must not keep rejecting a model that grew.
        with self.patch_compat():
            ai = self.config()
            rows = self.rows(ai, "ก" * 4500)
            self.context = 4096
            with self.assertRaises(WorkloadBudgetError):
                select_rows(rows, ai, "th", {"successes": 0})
            self.context = 32768
            self.assertEqual(select_rows(rows, ai, "th", {"successes": 0})[0], rows)
            self.assertEqual(self.calls, [("GET", "/v1/models")] * 2)

    def test_kobold_live_32k_to_4k_to_32k_and_single_probe_per_ready_request(self):
        ai = self.config("koboldcpp")
        long_rows = self.rows(ai, "ก" * 4500)
        pair = [("GET", "/v1/models"),
                ("GET", "/api/extra/true_max_context_length")]
        with self.patch_kobold():
            selected, estimate, _ = select_rows(long_rows, ai, "th", {})
            self.assertEqual(selected, long_rows)
            self.assertEqual(estimate["_preparedCapabilities"]["limits"]["contextTokens"], 32768)
            self.context = 4096
            with self.assertRaises(WorkloadBudgetError):
                select_rows(long_rows, ai, "th", {})
            self.context = 32768
            self.assertEqual(select_rows(long_rows, ai, "th", {})[0], long_rows)
            self.assertEqual(self.calls, pair * 3)
            self.calls.clear()
            translated = ready_batch.translate_ready(["Hello"], "th", ai,
                admission_identity="fixture", cancel_check=lambda: False)
            self.assertIn("คำแปล", translated["aiTextFull"])
            self.assertEqual(self.calls, pair + [("POST", "/v1/chat/completions")],
                "READY proof must be consumed at POST without a redundant model/context probe")

    def test_kobold_missing_bound_and_changed_prepared_bound_are_not_reused(self):
        ai = self.config("koboldcpp")
        pair = [("GET", "/v1/models"),
                ("GET", "/api/extra/true_max_context_length")]
        with self.patch_kobold():
            adapter = local_koboldcpp.ADAPTER
            verified = adapter.inspect_runtime_context(model=self.model, base_url=ai.base_url,
                api_key="")
            self.assertEqual(verified.limits["contextTokens"], 32768)
            self.kobold_metadata_missing = True
            with self.assertRaises(WorkloadBudgetError):
                adapter.inspect_runtime_context(model=self.model, base_url=ai.base_url,
                    api_key="", prior_limits=verified.limits)
            self.assertEqual(self.calls, pair * 2)
            self.calls.clear()
            _, estimate, _ = select_rows(self.rows(ai, "Short"), ai, "th", {})
            self.assertEqual(estimate["_preparedCapabilities"]["limits"], {},
                "a cold missing native endpoint cannot invent a numeric budget")
            self.assertEqual(self.calls, pair)
            self.kobold_extra_model = True
            self.calls.clear()
            unknown = adapter.inspect_runtime_context(model=self.model, base_url=ai.base_url,
                api_key="")
            self.assertEqual(unknown.limits, {},
                "the unqualified endpoint does not describe one of multiple models")
            self.assertEqual(self.calls, [("GET", "/v1/models")])

    def test_kobold_expired_ready_proof_detects_changed_or_missing_context_before_post(self):
        ai = self.config("koboldcpp")
        pair = [("GET", "/v1/models"),
                ("GET", "/api/extra/true_max_context_length")]
        with self.patch_kobold():
            for new_context in (4096, None):
                with self.subTest(new_context=new_context):
                    self.context = 32768
                    ai._runtime_context_evidence = local_koboldcpp.ADAPTER.inspect_runtime_context(
                        model=self.model, base_url=ai.base_url, api_key="")
                    ai.model_capabilities = {"limits": dict(ai._runtime_context_evidence.limits)}
                    ai._runtime_context_evidence.issued_at -= 6
                    self.context = new_context
                    self.kobold_metadata_missing = new_context is None
                    with self.assertRaises(WorkloadBudgetError) as caught:
                        translate(markers.apply(["Short"]), "th", ai)
                    self.assertEqual(caught.exception.diagnostics["constraint"],
                        "runtime_context_unverified" if new_context is None else
                        "runtime_context_changed")
                    self.assertEqual(self.calls, pair * 2)
                    self.calls.clear()
                    self.kobold_metadata_missing = False

    def test_exact_model_missing_numeric_is_unknown_but_disappearance_fails(self):
        from backend.ai.providers.local_vllm import ADAPTER
        self.context = None
        with self.patch_compat():
            ai = self.config()
            selected, estimate, _ = select_rows(self.rows(ai, "Short"), ai, "th", {})
            self.assertEqual(len(selected), 1)
            self.assertEqual(estimate["_preparedCapabilities"]["limits"], {})
            with self.assertRaises(WorkloadBudgetError):
                ADAPTER.inspect_runtime_context(model=self.model, base_url=ai.base_url,
                    api_key="", prior_limits={"contextTokens": 32768,
                        "source": "vllm-models", "scope": "runtime"})
        self.assertEqual(self.calls, [("GET", "/v1/models")] * 2)

    def test_llamacpp_props_only_with_one_exact_model_and_current_window(self):
        ai = self.config("llamacpp")
        state = {"context": 4096, "extra": False}
        paths = []
        real_client = httpx.Client
        def handle(req):
            paths.append(req.url.path)
            if req.url.path == "/v1/models":
                rows = [{"id": "selected", "meta": {"n_ctx_train": 131072}}]
                if state["extra"]:
                    rows.append({"id": "other", "meta": {"n_ctx_train": 131072}})
                return httpx.Response(200, json={"data": rows})
            self.assertEqual(req.url.path, "/props")
            return httpx.Response(200, json={"default_generation_settings": {
                "n_ctx": state["context"]}})
        with patch.object(local_openai_runtime.httpx, "Client",
                side_effect=lambda *,timeout:real_client(
                    transport=httpx.MockTransport(handle),timeout=timeout)):
            rows = self.rows(ai, "ก" * 4500)
            with self.assertRaises(WorkloadBudgetError):
                select_rows(rows, ai, "th", {})
            self.assertEqual(paths, ["/v1/models", "/props"])
            state["context"] = 32768
            selected, estimate, _ = select_rows(rows, ai, "th", {})
            self.assertEqual(selected, rows)
            self.assertEqual(estimate["_preparedCapabilities"]["limits"]["contextTokens"], 32768)
            self.assertEqual(paths, ["/v1/models", "/props"] * 2)
            state["extra"] = True
            _, estimate, _ = select_rows(self.rows(ai, "Short"), ai, "th", {})
            self.assertEqual(estimate["_preparedCapabilities"]["limits"], {})
            self.assertEqual(paths[-1], "/v1/models")

    def test_ready_proof_one_get_one_post_and_private(self):
        with self.patch_compat():
            try:
                first = ready_batch.translate_ready(["Hello"], "th", self.config(text_index=1),
                    admission_identity="fixture", cancel_check=lambda: False)
            except Exception as exc:
                self.fail(f"{exc!r}; answer: {self.completion_answers!r}; "
                    f"trace: {[(p.name,p.read_text()[-800:]) for p in Path(self.tmp.name,'wire').glob('**/*provider_response*')]} ")
            self.assertEqual(self.calls, [("GET", "/v1/models"),
                                          ("POST", "/v1/chat/completions")])
            second = ready_batch.translate_ready(["World"], "th", self.config(text_index=2),
                admission_identity="fixture", cancel_check=lambda: False)
            self.assertEqual(self.calls, [("GET", "/v1/models"),
                ("POST", "/v1/chat/completions")] * 2)
            self.assertIn("คำแปล", first["aiTextFull"])
            self.assertIn("คำแปล", second["aiTextFull"])
        for record in Path(self.tmp.name, "wire").glob("**/*.json"):
            content = record.read_text()
            self.assertNotIn("_runtimeContextEvidence", content)
            self.assertNotIn("_localRuntimeEvidence", content)

    def test_invalid_local_url_stops_before_any_get_or_post(self):
        ai = self.config(base="https://example.org/v1")
        with self.patch_compat(), self.assertRaises(UnsafeBaseUrl):
            select_rows(self.rows(ai, "Source"), ai, "th", {})
        self.assertEqual(self.calls, [])

    def test_ollama_stale_plain_cache_reads_live_mandatory_and_16k(self):
        base = "http://localhost:11434"
        forget_model_capabilities("ollama", base, "")
        remember_model_capabilities("ollama", base, "", {
            "selected": {"reasoning": {"supported": False},
                "limits": {"contextTokens": 256, "runtimeContextTokens": 256,
                    "source": "ollama-api-ps", "scope": "runtime"}}}, models=["selected"])
        real_client = httpx.Client
        calls = []
        payloads = []
        def handle(req):
            calls.append((req.method, req.url.path))
            if req.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "selected"}]})
            if req.url.path == "/api/show":
                return httpx.Response(200, json={"capabilities": ["completion", "thinking"],
                    "thinking": {"values": ["low", "medium"], "default": "medium"},
                    "model_info": {"general.architecture": "llama",
                                   "llama.context_length": 65536}})
            if req.url.path == "/api/ps":
                return httpx.Response(200, json={"models": [
                    {"name": "selected", "context_length": 16384}]})
            self.assertEqual(req.url.path, "/api/chat")
            payloads.append(json.loads(req.content))
            answer = "<<I1_P0:คำแปล>>"
            frames = [{"message": {"content": answer}, "done": False},
                      {"message": {"content": ""}, "done": True,
                       "done_reason": "stop", "prompt_eval_count": 110,
                       "eval_count": 30}]
            return httpx.Response(200, text="\n".join(json.dumps(f) for f in frames) + "\n")
        ai = self.config("ollama")
        ai.base_url = base
        try:
            with patch.object(local_ollama.httpx, "Client",
                    side_effect=lambda *, timeout: real_client(
                        transport=httpx.MockTransport(handle), timeout=timeout)):
                result = ready_batch.translate_ready(["Short source"], "th", ai,
                    admission_identity="fixture", cancel_check=lambda: False)
            self.assertIn("คำแปล", result["aiTextFull"])
            self.assertEqual(calls, [("GET", "/api/tags"), ("POST", "/api/show"),
                ("GET", "/api/ps"), ("POST", "/api/chat")])
            self.assertEqual(payloads[0]["think"], "low")
            self.assertGreaterEqual(payloads[0]["options"]["num_ctx"], 16384)
            self.assertEqual(payloads[0]["options"]["num_predict"], 8192)
        finally:
            forget_model_capabilities("ollama", base, "")

    def test_current_plain_retire_historical_reasoning_reserve(self):
        base = "http://localhost:11434"
        real_client = httpx.Client
        def handle(req):
            if req.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "selected"}]})
            if req.url.path == "/api/show":
                return httpx.Response(200, json={"capabilities": ["completion"],
                    "thinking": {"values": [False], "default": False},
                    "model_info": {"general.architecture": "llama",
                                   "llama.context_length": 12288}})
            self.assertEqual(req.url.path, "/api/ps")
            return httpx.Response(200, json={"models": [
                {"name": "selected", "context_length": 12288}]})
        ai = self.config("ollama")
        ai.base_url = base
        profile = {"reasoningSeen": True, "reasoning": 7000,
                   "zeroReasoningSamples": 0}
        with patch.object(local_ollama.httpx, "Client",
                side_effect=lambda *, timeout: real_client(
                    transport=httpx.MockTransport(handle), timeout=timeout)):
            selected, estimate, _ = select_rows(self.rows(ai, "Hi"), ai, "th", profile)
        self.assertEqual(len(selected), 1)
        self.assertEqual(estimate["reasoningReserve"], 0,
                         estimate["_preparedCapabilities"])
        self.assertGreater(estimate["completionAvailable"], 0)
        # The reason history can also retire when two complete generations
        # report zero actual thinking, even without a native plain model fact.
        valid = {"meta": {"conversation": {"commitStatus": "committed"},
                          "usage": {"thinkingTokens": 0}}}
        learn(profile, valid, {"baseOutput": 1})
        learn(profile, valid, {"baseOutput": 1})
        self.assertFalse(profile["reasoningSeen"])
        self.assertEqual(profile["reasoning"], 0)

    def test_ollama_live_4k_rejects_oversized_ready_source_without_chat(self):
        ai = self.config("ollama")
        ai.base_url = "http://localhost:11434"
        calls = []
        real_client = httpx.Client
        def handle(req):
            calls.append(req.url.path)
            if req.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "selected"}]})
            if req.url.path == "/api/show":
                return httpx.Response(200, json={"capabilities": ["completion"],
                    "thinking": {"values": [False], "default": False},
                    "model_info": {"general.architecture": "llama",
                                   "llama.context_length": 4096}})
            self.assertEqual(req.url.path, "/api/ps")
            return httpx.Response(200, json={"models": [
                {"name": "selected", "context_length": 4096}]})
        with patch.object(local_ollama.httpx, "Client",
                side_effect=lambda *, timeout: real_client(
                    transport=httpx.MockTransport(handle), timeout=timeout)):
            with self.assertRaises(WorkloadBudgetError):
                select_rows(self.rows(ai, "ก" * 5000), ai, "th", {})
        self.assertEqual(calls, ["/api/tags", "/api/show", "/api/ps"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
