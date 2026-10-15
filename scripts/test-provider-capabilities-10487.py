#!/usr/bin/env python3
""".87 provider audit: non-reasoning models pass Lowest/Off, working streams finish.

Offline only. Covers the 2026-10-14 owner log classes:
  A. Thinking Lowest/Off refused for a model whose catalogue proves no reasoning
     (OpenRouter supported_parameters, Anthropic /v1/models capabilities).
  B. The OpenAI-compatible stream budget (core.py) cutting a stream that is
     still delivering data, while a stalled or silent stream still times out.
"""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
import sys
import threading
import time
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "api"))

import httpx

from backend.ai import markers
from backend.ai.clients.base import ChatResult
from backend.ai.cloud_reasoning import (
    CloudReasoningPreferenceUnavailable, PROVIDER_MANAGED_UNVERIFIED,
    ensure_cloud_reasoning_preflight, native_reasoning_capability,
)
from backend.ai.provider_contract import ModelListResult
from backend.ai.provider_registry import provider_registry
from backend.ai.provider_bootstrap import ensure_provider_registry
from backend.ai.provider_resolution import forget_model_capabilities
from backend.ai.providers import cloud_anthropic, cloud_openrouter
from backend.ai.providers.anthropic_reasoning import _apply_reasoning
from backend.ai.reasoning_preference import resolve_reasoning_preference
from backend.ai.transports.openai_compat import core
from backend.ai.transports import stream_progress  # 10489: phase limits replace the .87 600 s rule
from backend.ai.transports.openai_chat import execute_chat_completion
from backend.ai.translation import invocation
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.invocation import _translate_once_impl

ensure_provider_registry()


def preflight(provider, model, requested, cap, *, verified=True):
    native = native_reasoning_capability(provider, model)
    effective = native or cap
    selected = resolve_reasoning_preference(requested, effective)
    return ensure_cloud_reasoning_preflight(
        provider, model, requested, selected, effective,
        capability_verified=verified or bool(native))


class ReasoningCapabilityTests(unittest.TestCase):
    def assert_lowest_and_off_pass(self, provider, model, cap):
        for requested in ("minimum", "off", "default"):
            with self.subTest(provider=provider, requested=requested):
                self.assertIsNone(preflight(provider, model, requested, cap))
        # A model with no reasoning cannot honour an explicit On/effort.
        for requested in ("on", "low", "high"):
            with self.subTest(provider=provider, requested=requested):
                with self.assertRaises(CloudReasoningPreferenceUnavailable):
                    preflight(provider, model, requested, cap)

    def assert_unknown(self, provider, model, cap):
        self.assertNotIn("supported", cap)
        self.assertEqual(preflight(provider, model, "minimum", cap), PROVIDER_MANAGED_UNVERIFIED)
        with self.assertRaises(CloudReasoningPreferenceUnavailable):
            preflight(provider, model, "off", cap)

    # --- OpenRouter (Manual and Login OpenRouter share normalize_capabilities)
    def test_openrouter_plain_model_with_parameter_list_is_non_reasoning(self):
        row = {"id": "openai/gpt-4o", "supported_parameters": [
            "max_tokens", "temperature", "top_p", "response_format", "structured_outputs",
            "tools", "tool_choice", "seed", "stop", "frequency_penalty"]}
        cap = cloud_openrouter.normalize_capabilities(row)["reasoning"]
        self.assertIs(cap["supported"], False)
        self.assert_lowest_and_off_pass("openrouter", "openai/gpt-4o", cap)

    def test_openrouter_silent_or_reasoning_family_parameter_stays_unknown(self):
        for row in (
            {"id": "vendor/silent"},  # no parameter list at all
            {"id": "vendor/legacy", "supported_parameters": ["max_tokens", "include_reasoning"]},
            {"id": "vendor/budget", "supported_parameters": ["max_tokens", "reasoning.max_tokens"]},
        ):
            with self.subTest(row=row["id"]):
                cap = cloud_openrouter.normalize_capabilities(row)["reasoning"]
                if row["id"] == "vendor/budget":
                    # reasoning.max_tokens alone already proves a reasoning model.
                    self.assertIsNot(cap.get("supported"), False)
                    continue
                self.assert_unknown("openrouter", row["id"], cap)

    def test_openrouter_reasoning_model_unchanged(self):
        cap = cloud_openrouter.normalize_capabilities({
            "id": "openai/gpt-5-pro", "supported_parameters": ["max_tokens", "reasoning"],
            "reasoning": {"mandatory": True, "supported_efforts": ["high"]},
        })["reasoning"]
        self.assertIs(cap["supported"], True)
        self.assertEqual(cap["supported_efforts"], ["high"])
        self.assertIsNone(preflight("openrouter", "openai/gpt-5-pro", "minimum", cap))
        self.assertIsNone(preflight("openrouter", "openai/gpt-5-pro", "high", cap))
        with self.assertRaises(CloudReasoningPreferenceUnavailable):
            preflight("openrouter", "openai/gpt-5-pro", "off", cap)

    # --- Anthropic /v1/models capabilities.thinking
    def anthropic_listing(self, rows):
        response = httpx.Response(200, json={"data": rows},
                                  request=httpx.Request("GET", cloud_anthropic._MODELS_ENDPOINT))

        class Client:
            def __init__(self, *_, **__): pass
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def get(self, *_args, **_kwargs): return response

        with patch.object(httpx, "Client", Client):
            return cloud_anthropic.models_status("sk-ant-fixture")

    @staticmethod
    def anthropic_row(model, thinking, effort=False):
        caps = {"image_input": {"supported": True}}
        if thinking is not None:
            caps["thinking"] = {"supported": thinking, "types": {
                "adaptive": {"supported": False}, "disabled": {"supported": True},
                "enabled": {"supported": thinking}}}
        if effort is not None:
            caps["effort"] = {"supported": effort}
        return {"id": model, "type": "model", "capabilities": caps,
                "max_input_tokens": 200000, "max_tokens": 4096}

    def test_anthropic_catalogue_without_thinking_passes_lowest_and_off(self):
        listed = self.anthropic_listing([self.anthropic_row("claude-3-haiku-20240307", False)])
        cap = listed["capabilities"]["claude-3-haiku-20240307"]["reasoning"]
        self.assertEqual(cap["supported"], False)
        self.assertEqual(cap["source"], "anthropic_account_models_api")
        self.assert_lowest_and_off_pass("anthropic", "claude-3-haiku-20240307", cap)
        # The adapter sends no guessed thinking field for this model.
        for requested in ("minimum", "off", "default"):
            payload = {"max_tokens": 4096}
            _apply_reasoning(payload, "claude-3-haiku-20240307", requested, {"reasoning": cap})
            self.assertNotIn("thinking", payload)
            self.assertNotIn("output_config", payload)

    def test_anthropic_silent_or_contradictory_catalogue_stays_unknown(self):
        listed = self.anthropic_listing([
            {"id": "claude-future-a", "type": "model"},  # no capabilities object
            self.anthropic_row("claude-future-b", None),  # thinking key absent
            self.anthropic_row("claude-future-c", False, effort=True),  # contradictory
            self.anthropic_row("claude-future-d", True),
        ])
        for model in ("claude-future-a", "claude-future-b", "claude-future-c", "claude-future-d"):
            with self.subTest(model=model):
                cap = listed.get("capabilities", {}).get(model, {}).get("reasoning", {})
                self.assert_unknown("anthropic", model, cap)

    def test_anthropic_native_map_wins_over_catalogue(self):
        listed = self.anthropic_listing([self.anthropic_row("claude-opus-4-1", False)])
        cap = listed["capabilities"]["claude-opus-4-1"]["reasoning"]
        self.assertIs(cap["supported"], True)
        self.assertEqual(cap["control"], "toggle")

    def test_anthropic_end_to_end_lowest_dispatches_once(self):
        model = "claude-3-haiku-20240307"
        spec = provider_registry.require("anthropic")
        key = "sk-ant-fixture-10487"
        listing = cloud_anthropic.contract_model_status(
            self.anthropic_listing([self.anthropic_row(model, False)]))
        for thinking in ("minimum", "off"):
            with self.subTest(thinking=thinking):
                forget_model_capabilities("anthropic", spec.default_base_url, key)
                ai = AiConfig(api_key=key, provider="anthropic", model=model, thinking=thinking,
                              prompt_mode="replace", prompt_editable="Translate.")
                with patch.object(spec.adapter, "list_models", return_value=listing), \
                     patch.object(invocation, "assert_ai_base_url_allowed"), \
                     patch("backend.ai.accounting.generate_with_receipt",
                           return_value=ChatResult("translated", model)) as generated, \
                     patch.object(invocation, "decode_result",
                                  return_value={"meta": {"prompt_audit": {}}}):
                    _translate_once_impl(markers.apply(["source"]), "th", ai)
                self.assertEqual(generated.call_count, 1)
                request = generated.call_args.args[1]
                self.assertIs(request.model_capabilities["reasoning"]["supported"], False)
        self.assertIsInstance(listing, ModelListResult)

    def test_openrouter_end_to_end_gpt4o_lowest_dispatches_once(self):
        # The exact owner-log case: Manual OpenRouter, openai/gpt-4o, Lowest.
        model = "openai/gpt-4o"
        spec = provider_registry.require("openrouter")
        key = "sk-or-fixture-10487"
        caps = cloud_openrouter.normalize_capabilities({"id": model, "supported_parameters": [
            "max_tokens", "temperature", "response_format", "structured_outputs"]})
        listing = ModelListResult(models=(model,), status="valid", capabilities={model: caps})
        for thinking in ("minimum", "off"):
            with self.subTest(thinking=thinking):
                forget_model_capabilities("openrouter", spec.default_base_url, key)
                ai = AiConfig(api_key=key, provider="openrouter", model=model, thinking=thinking,
                              prompt_mode="replace", prompt_editable="Translate.")
                with patch.object(spec.adapter, "list_models", return_value=listing), \
                     patch.object(invocation, "assert_ai_base_url_allowed"), \
                     patch("backend.ai.accounting.generate_with_receipt",
                           return_value=ChatResult("translated", model)) as generated, \
                     patch.object(invocation, "decode_result",
                                  return_value={"meta": {"prompt_audit": {}}}):
                    _translate_once_impl(markers.apply(["source"]), "th", ai)
                self.assertEqual(generated.call_count, 1)
                payload = cloud_openrouter.prepare_payload(generated.call_args.args[1])
                self.assertNotIn("reasoning", payload)
                self.assertIn("max_tokens", payload)


class Frame:
    @staticmethod
    def data(text):
        return "data: " + json.dumps({"id": "r", "model": "m",
                                      "choices": [{"delta": {"content": text}, "finish_reason": None}]})

    DONE = ("data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": "stop"}],
                                   "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}}),
            "data: [DONE]")


def stream_client(script):
    """A fake httpx client whose iter_lines follows ``script`` until closed."""

    class Response:
        is_success = True
        status_code = 200
        headers = {}

        def __init__(self, closed):
            self.closed = closed
        def __enter__(self): return self
        def __exit__(self, *_): return False
        def raise_for_status(self): return None
        def close(self): self.closed.set()

        def iter_lines(self):
            for item in script():
                if isinstance(item, float):
                    if self.closed.wait(item):
                        raise httpx.ReadError("closed", request=httpx.Request("POST", "https://x.invalid"))
                    continue
                if self.closed.is_set():
                    raise httpx.ReadError("closed", request=httpx.Request("POST", "https://x.invalid"))
                yield item

    class Client:
        _textphantom_streaming = True

        def __init__(self, *_, **__):
            self.closed = threading.Event()
        def __enter__(self): return self
        def __exit__(self, *_): return False
        def close(self): self.closed.set()

        @contextmanager
        def stream(self, *_args, **_kwargs):
            yield Response(self.closed)

    return Client


def run_stream(script, *, budget, idle=0.15, ceiling=3.0):
    started = time.perf_counter()
    with patch.object(stream_progress, "STALL_IDLE_SEC", idle), \
         patch.object(stream_progress, "ABSOLUTE_CEILING_SEC", ceiling), \
         patch.object(httpx, "Client", stream_client(script)):
        try:
            result = execute_chat_completion(
                url="https://openrouter.ai/api/v1/chat/completions", headers={},
                payload={"messages": []}, model="m", provider_id="openrouter",
                timeout=budget, timeout_policy="test", expected_ids=["P0"])
        except TimeoutError as error:
            return error, time.perf_counter() - started
    return result, time.perf_counter() - started


class StreamBudgetTests(unittest.TestCase):
    def test_stream_delivering_data_finishes_past_budget(self):
        def script():
            yield Frame.data("<<TP_P0:")
            for _ in range(12):  # 0.6 s of steady data against a 0.25 s budget
                yield 0.05
                yield Frame.data("x")
            yield Frame.data(">>")
            yield from Frame.DONE
        result, elapsed = run_stream(script, budget=0.25)
        self.assertNotIsInstance(result, TimeoutError, result)
        self.assertGreater(elapsed, 0.25)
        self.assertEqual(result.text, "<<TP_P0:" + "x" * 12 + ">>")
        self.assertTrue(result.terminal_completed)

    def test_stream_stalling_past_budget_times_out(self):
        def script():
            yield Frame.data("<<TP_P0:x")
            yield 5.0  # silence: no data frame, only the budget/idle watcher ends it
            yield Frame.data(">>")
            yield from Frame.DONE
        result, elapsed = run_stream(script, budget=0.25)
        self.assertIsInstance(result, TimeoutError)
        self.assertEqual(getattr(result, "stream_stop_code", None), "ai_provider_stalled")  # 10489
        self.assertLess(elapsed, 1.5)

    def test_keepalive_comments_do_not_count_as_progress(self):
        def script():
            yield Frame.data("<<TP_P0:x")
            for _ in range(100):
                yield 0.05
                yield ": OPENROUTER PROCESSING"
            yield from Frame.DONE
        result, elapsed = run_stream(script, budget=0.25)
        self.assertIsInstance(result, TimeoutError)
        self.assertLess(elapsed, 1.5)

    def test_progress_stops_at_ceiling(self):
        def script():
            yield Frame.data("<<TP_P0:")
            for _ in range(400):
                yield 0.05
                yield Frame.data("x")
            yield from Frame.DONE
        result, elapsed = run_stream(script, budget=0.25, ceiling=0.8)
        self.assertIsInstance(result, TimeoutError)
        self.assertGreater(elapsed, 0.75)
        self.assertLess(elapsed, 2.0)

    def test_silent_stream_times_out_at_budget_even_when_budget_below_idle_window(self):
        # Regression: before any data frame there is no progress to extend.
        def script():
            yield 5.0
            yield from Frame.DONE
        result, elapsed = run_stream(script, budget=0.12, idle=30.0, ceiling=600.0)
        self.assertIsInstance(result, TimeoutError)
        self.assertLess(elapsed, 0.8)


if __name__ == "__main__":
    unittest.main()
