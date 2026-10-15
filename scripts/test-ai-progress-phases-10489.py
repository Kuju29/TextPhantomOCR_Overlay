"""10489: phase-aware provider stream limits instead of a bigger wall clock.

Owner report (2026-10-14): GPT-5 Pro and Opus 4.1 (93 lines) were cut at
exactly 120 s while streaming; .87 extended that to 600 s whenever data kept
arriving, so a real hang could hold a user for ten minutes and the status said
nothing about the AI thinking. These tests drive fake provider streams through
the real transports and check that

  * the phase is read from the stream itself (waiting / thinking / writing /
    stalled), keep-alives never count as progress,
  * a hang ends at the idle window, thinking ends at a limit derived from the
    request's reasoning budget, writing ends when lines stop completing,
  * the reasoning budget sent to each provider is the shared derived cap,
  * phase rows reach the NDJSON response only when the client asked,
  * Paid forwards Center phase rows and counts lines from deltas,
  * stop codes map to typed API errors.
"""
from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

import httpx
from starlette.requests import Request

from backend.ai import content_stream
from backend.ai.clients.base import LineCompletionDetector
from backend.ai.failure_reason import classify, provider_http_failure
from backend.ai.generation_defaults import (
    ANSWER_FLOOR_TOKENS, REASONING_CAP_MAX_TOKENS, REASONING_CAP_MIN_TOKENS,
    output_token_budget, reasoning_token_cap,
)
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import cloud_anthropic, cloud_gemini, cloud_openrouter, cloud_paid
from backend.ai.transports import native_stream, stream_progress
from backend.ai.transports.openai_chat import execute_chat_completion
from backend.application.ai_translation import streaming

SP = stream_progress
IDS = [f"P{i}" for i in range(4)]


# --------------------------------------------------------------- fake wire
def oa(delta=None, finish=None, usage=None):
    item = {"id": "r", "model": "m", "choices": [{"delta": delta or {}, "finish_reason": finish}]}
    if usage:
        item["usage"] = usage
    return "data: " + json.dumps(item)


def reasoning(text="…"):
    return oa({"reasoning": text})


def content(text):
    return oa({"content": text})


DONE = (oa({}, "stop", {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}), "data: [DONE]")


def stream_client(script):
    """A fake httpx client; floats in ``script`` are waits that end early when
    the transport closes the response (as a real socket read would)."""

    class Response:
        is_success = True
        status_code = 200
        headers = {}
        request = httpx.Request("POST", "https://provider.invalid")

        def __init__(self, closed):
            self.closed = closed
        def __enter__(self): return self
        def __exit__(self, *_): return False
        def raise_for_status(self): return None
        def read(self): return b""
        def close(self): self.closed.set()

        def iter_lines(self):
            for item in script():
                if isinstance(item, float):
                    if self.closed.wait(item):
                        raise httpx.ReadError("closed", request=self.request)
                    continue
                if self.closed.is_set():
                    raise httpx.ReadError("closed", request=self.request)
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


@contextmanager
def limits(**values):
    """Shrink the documented limits to test scale."""
    names = {"idle": "STALL_IDLE_SEC", "first": "FIRST_PROGRESS_SEC", "tps": "MIN_REASONING_TOKENS_PER_SEC",
             "floor": "THINKING_FLOOR_SEC", "ceil": "THINKING_CEILING_SEC", "line": "LINE_PROGRESS_SEC",
             "abs": "ABSOLUTE_CEILING_SEC", "report": "REPORT_INTERVAL_SEC"}
    defaults = {"idle": 0.3, "first": 0.4, "tps": 15.0, "floor": 5.0, "ceil": 5.0, "line": 5.0, "abs": 10.0, "report": 0.0}
    defaults.update(values)
    patches = [patch.object(SP, names[key], value) for key, value in defaults.items()]
    for item in patches:
        item.start()
    try:
        yield
    finally:
        for item in patches:
            item.stop()


def run_openai(script, *, payload=None, budget=5.0, ids=IDS):
    events, deltas = [], []
    started = time.perf_counter()
    with patch.object(httpx, "Client", stream_client(script)), \
         content_stream.scope(deltas.append, None, events.append):
        try:
            result = execute_chat_completion(
                url="https://openrouter.ai/api/v1/chat/completions", headers={},
                payload=dict(payload or {"messages": []}), model="m", provider_id="openrouter",
                timeout=budget, timeout_policy="test", expected_ids=list(ids))
        except Exception as error:  # noqa: BLE001 - the test inspects it
            result = error
    return result, time.perf_counter() - started, events, "".join(deltas)


def phases(events):
    out = []
    for event in events:
        if not out or out[-1] != event["phase"]:
            out.append(event["phase"])
    return out


def lines(n, start=0):
    return [content(f"<<TP_P{i}:คำแปล{i}>>\n") for i in range(start, start + n)]


# ---------------------------------------------------------------- phases
class PhaseTests(unittest.TestCase):
    def test_thinking_only_then_content_completes_past_old_budget(self):
        def script():
            yield ": OPENROUTER PROCESSING"
            for _ in range(8):  # 0.4 s of reasoning against a 0.25 s budget
                yield 0.05
                yield reasoning()
            for frame in lines(4):
                yield 0.05
                yield frame
            yield from DONE
        with limits():
            result, elapsed, events, text = run_openai(script, budget=0.25)
        self.assertNotIsInstance(result, Exception, result)
        self.assertGreater(elapsed, 0.25, "a working stream is not cut at the old wall clock")
        self.assertEqual(phases(events), ["waiting", "thinking", "writing"])
        self.assertTrue(any(e["keepalive"] for e in events if e["phase"] == "waiting"),
                        "keep-alive is reported as waiting at provider")
        self.assertEqual(max(e["linesDone"] or 0 for e in events), 4)
        self.assertTrue(all(e["linesTotal"] == 4 for e in events))
        self.assertIn("thinkingLimitMs", next(e for e in events if e["phase"] == "thinking"))
        self.assertEqual(text.count(">>"), 4)

    def test_content_steady_lines_keep_completing(self):
        ids = [f"P{i}" for i in range(12)]
        def script():
            for frame in lines(12):
                yield 0.05
                yield frame
            yield from DONE
        with limits(line=0.3):
            result, elapsed, events, _ = run_openai(script, budget=0.2, ids=ids)
        self.assertNotIsInstance(result, Exception, result)
        self.assertGreater(elapsed, 0.5)
        done = [e["linesDone"] for e in events if e["phase"] == "writing"]
        self.assertEqual(done, sorted(done), "line count only grows")
        self.assertEqual(done[-1], 12)

    def test_keepalives_only_after_thinking_stall_at_idle_window(self):
        def script():
            yield reasoning()
            for _ in range(200):
                yield 0.05
                yield ": OPENROUTER PROCESSING"
            yield from DONE
        with limits(idle=0.3):
            result, elapsed, events, _ = run_openai(script)
        self.assertIsInstance(result, SP.StreamStopped)
        self.assertEqual(result.stream_stop_code, "ai_provider_stalled")
        self.assertLess(elapsed, 1.2, "a hang ends at the idle window, never at a 600 s ceiling")
        self.assertEqual(events[-1]["phase"], "stalled")
        self.assertEqual(classify(result), "ai_provider_stalled")

    def test_keepalives_only_from_start_stall_at_first_progress_window(self):
        def script():
            for _ in range(200):
                yield 0.05
                yield ": OPENROUTER PROCESSING"
        with limits(first=0.4):
            result, elapsed, events, _ = run_openai(script)
        self.assertEqual(getattr(result, "stream_stop_code", None), "ai_provider_stalled")
        self.assertLess(elapsed, 1.2)
        self.assertEqual(phases(events), ["waiting", "stalled"])
        self.assertTrue(any(e["keepalive"] for e in events if e["phase"] == "waiting"))

    def test_empty_deltas_and_role_frames_are_not_progress(self):
        def script():
            for _ in range(200):
                yield 0.05
                yield oa({"role": "assistant", "content": ""})
        with limits(first=0.3):
            result, elapsed, _, _ = run_openai(script)
        self.assertEqual(getattr(result, "stream_stop_code", None), "ai_provider_stalled")
        self.assertLess(elapsed, 1.2)

    def test_silent_socket_stalls(self):
        def script():
            yield content("<<TP_P0:x>>\n")
            yield 5.0
            yield from DONE
        with limits(idle=0.3):
            result, elapsed, _, _ = run_openai(script)
        self.assertEqual(getattr(result, "stream_stop_code", None), "ai_provider_stalled")
        self.assertLess(elapsed, 1.2)

    def test_content_loop_without_new_lines_stops_and_keeps_completed_lines(self):
        def script():
            yield from lines(2)
            for _ in range(200):  # rambles inside one never-closed record
                yield 0.03
                yield content("ซ้ำ")
            yield from DONE
        with limits(line=0.4):
            result, elapsed, events, text = run_openai(script)
        self.assertEqual(getattr(result, "stream_stop_code", None), "ai_output_no_progress")
        self.assertLess(elapsed, 1.5)
        self.assertEqual(result.stream_stop["linesDone"], 2)
        self.assertEqual(result.stream_stop["phase"], "writing")
        self.assertEqual(events[-1]["phase"], "stopping")
        self.assertEqual(events[-1]["reason"], "ai_output_no_progress")
        # The completed lines were already delivered to the client stream.
        self.assertIn("<<TP_P0:คำแปล0>>", text)
        self.assertIn("<<TP_P1:คำแปล1>>", text)

    def test_thinking_beyond_derived_limit_stops(self):
        def script():
            for _ in range(400):
                yield 0.02
                yield oa({"reasoning_details": [{"type": "reasoning.summary", "summary": "…"}]})
        payload = {"messages": [], "max_completion_tokens": 4000, "reasoning": {"max_tokens": 1000}}
        with limits(tps=2000.0, floor=0.1, ceil=5.0):  # 1000 tokens / 2000 tok/s = 0.5 s
            result, elapsed, events, _ = run_openai(script, payload=payload)
        self.assertEqual(getattr(result, "stream_stop_code", None), "ai_thinking_too_long")
        self.assertGreater(elapsed, 0.45)
        self.assertLess(elapsed, 1.5)
        self.assertEqual(result.stream_stop["limitMs"], 500)
        self.assertEqual(events[-1]["reason"], "ai_thinking_too_long")
        failure = provider_http_failure(result)
        self.assertEqual((failure.status, failure.code, failure.retryable), (502, "ai_thinking_too_long", False))

    def test_absolute_ceiling_is_kept(self):
        def script():
            for i in range(400):
                yield 0.02
                yield content(f"<<TP_P{i % 4}:x>>\n")
        with limits(abs=0.5):
            result, elapsed, _, _ = run_openai(script, budget=0.2)
        self.assertEqual(getattr(result, "stream_stop_code", None), "ai_stream_ceiling")
        self.assertLess(elapsed, 1.5)

    def test_non_record_generation_is_not_cut_by_line_rule(self):
        def script():
            for _ in range(20):
                yield 0.03
                yield content("summary text ")
            yield from DONE
        with limits(line=0.2):
            result, _, _, _ = run_openai(script, ids=[])
        self.assertNotIsInstance(result, Exception, result)


class LimitMathTests(unittest.TestCase):
    def test_thinking_limit_from_budget(self):
        self.assertEqual(SP.thinking_limit_sec(2048), 2048 / SP.MIN_REASONING_TOKENS_PER_SEC)
        self.assertEqual(SP.thinking_limit_sec(256), SP.THINKING_FLOOR_SEC)
        self.assertEqual(SP.thinking_limit_sec(100_000), SP.THINKING_CEILING_SEC)
        self.assertEqual(SP.thinking_limit_sec(None), SP.THINKING_CEILING_SEC)
        self.assertLess(SP.STALL_IDLE_SEC, SP.FIRST_PROGRESS_SEC)
        self.assertLess(SP.THINKING_CEILING_SEC, SP.ABSOLUTE_CEILING_SEC)

    def test_reasoning_budget_from_each_provider_payload(self):
        budget = SP.reasoning_budget_from_payload
        self.assertEqual(budget({"max_completion_tokens": 3000, "reasoning": {"max_tokens": 900}}), 900)
        self.assertEqual(budget({"max_completion_tokens": 3000, "reasoning": {"effort": "high"}}), 3000)
        self.assertEqual(budget({"max_tokens": 5000, "thinking": {"type": "enabled", "budget_tokens": 1024}}), 1024)
        self.assertEqual(budget({"max_tokens": 5000, "thinking": {"type": "adaptive"}}), 5000)
        self.assertEqual(budget({"generationConfig": {"maxOutputTokens": 4000, "thinkingConfig": {"thinkingBudget": 1200}}}), 1200)
        self.assertEqual(budget({"generationConfig": {"maxOutputTokens": 4000, "thinkingConfig": {"thinkingLevel": "high"}}}), 4000)
        self.assertEqual(budget({"generationConfig": {"maxOutputTokens": 800, "thinkingConfig": {"thinkingBudget": 24576}}}), 800)
        self.assertIsNone(budget({}))

    def test_closed_line_count(self):
        detector = LineCompletionDetector(["P0", "P1", "P2"])
        self.assertEqual(detector.closed_count("<<TP_P0:a>>\n<<TP_P1:b"), 1)
        self.assertEqual(detector.closed_count("<<TP_P0:a>>\n<<TP_P1:b>>\n<<TP_P9:z>>"), 2, "unknown ids never count")
        self.assertEqual(detector.closed_count('{"P0": "a", "P1": "b'), 1)
        self.assertEqual(LineCompletionDetector(None).closed_count("<<I2_P0:a>>\n<<I2_P1:>>"), 1, "an empty record is not a line")


# --------------------------------------------------------- reasoning budget
def request(provider, model, thinking, caps, **extra):
    return GenerationRequest(provider=provider, model=model, thinking=thinking, system_text="s",
                             user_parts=tuple(f"<<TP_P{i}:source {i}>>" for i in range(30)),
                             unit_count=30, model_capabilities=caps, **extra)


class ReasoningBudgetTests(unittest.TestCase):
    def test_shared_cap_formula(self):
        self.assertEqual(reasoning_token_cap(1024), REASONING_CAP_MIN_TOKENS)
        self.assertEqual(reasoning_token_cap(3000), 1000)
        self.assertEqual(reasoning_token_cap(8192), REASONING_CAP_MAX_TOKENS)
        for total in (1024, 2000, 4096, 8192):
            self.assertLessEqual(reasoning_token_cap(total), max(REASONING_CAP_MIN_TOKENS, total - ANSWER_FLOOR_TOKENS))

    def test_openrouter_budget_field_uses_shared_cap(self):
        caps = {"reasoning": {"supported": True, "control": "toggle", "supports_max_tokens": True}}
        payload = cloud_openrouter.prepare_payload(request("openrouter", "vendor/r", "on", caps))
        self.assertEqual(payload["reasoning"]["max_tokens"], reasoning_token_cap(payload["max_completion_tokens"]))
        self.assertEqual(SP.reasoning_budget_from_payload(payload), payload["reasoning"]["max_tokens"])

    def test_openrouter_without_max_tokens_support_sends_no_budget(self):
        caps = {"reasoning": {"supported": True, "control": "toggle"}}
        payload = cloud_openrouter.prepare_payload(request("openrouter", "vendor/r", "on", caps))
        self.assertNotIn("max_tokens", payload.get("reasoning") or {}, "never a field the model does not support")
        self.assertEqual(SP.reasoning_budget_from_payload(payload), payload["max_completion_tokens"],
                         "the thinking-time limit then derives from the completion ceiling")

    def test_openrouter_effort_only_sends_no_budget(self):
        caps = {"reasoning": {"supported": True, "control": "levels", "supported_efforts": ["low", "high"],
                              "supports_max_tokens": True}}
        payload = cloud_openrouter.prepare_payload(request("openrouter", "vendor/r", "high", caps))
        self.assertEqual(payload["reasoning"], {"effort": "high"}, "OpenRouter: effort OR max_tokens, not both")
        self.assertEqual(SP.reasoning_budget_from_payload(payload), payload["max_completion_tokens"])

    def test_anthropic_manual_thinking_budget_is_bounded(self):
        payload = {"max_tokens": 4000}
        cloud_anthropic._apply_reasoning(payload, "claude-opus-4-1", "on")
        self.assertEqual(payload["thinking"], {"type": "enabled", "budget_tokens": 1024})
        payload = {"max_tokens": 4000}
        cloud_anthropic._apply_reasoning(payload, "claude-opus-4-7", "high")
        self.assertNotIn("budget_tokens", payload["thinking"], "adaptive effort has no budget field")

    def test_gemini_dynamic_budget_is_replaced_by_shared_cap(self):
        captured = {}
        def post(_key, _model, payload, _cancel):
            captured.update(payload)
            raise httpx.ConnectError("stop")
        toggle = {"supported": True, "mandatory": False, "control": "toggle"}
        with patch.object(cloud_gemini, "_reasoning_capability", return_value=toggle), \
             patch.object(cloud_gemini, "_post_once", post):
            with self.assertRaises(Exception):
                cloud_gemini.generate("k", "gemini-x", "s", ["<<TP_P0:a>>"], thinking="on")
        config = captured["generationConfig"]
        self.assertEqual(config["thinkingConfig"]["thinkingBudget"], reasoning_token_cap(config["maxOutputTokens"]))
        self.assertNotEqual(config["thinkingConfig"]["thinkingBudget"], -1)

    def test_gemini_effort_budgets_unchanged(self):
        self.assertEqual(cloud_gemini._thinking_state("gemini-2.5-flash", "low")[1], {"thinkingBudget": 1024})
        self.assertEqual(cloud_gemini._thinking_state("gemini-3.5-flash", "high")[1], {"thinkingLevel": "high"})

    def test_output_budget_unchanged_by_refactor(self):
        self.assertEqual(output_token_budget(["x" * 100], "s" * 1000, reasoning=True, unit_count=10),
                         max(1024, min(8192, int(100 * 2.2) + 10 * 112 + 384 + min(4096, 768 + 1280 + 40))))


# ------------------------------------------------------------ native path
def sse(event):
    return ["data: " + json.dumps(event), ""]


class NativeTests(unittest.TestCase):
    def run_native(self, script, payload=None):
        events = []
        started = time.perf_counter()
        with patch.object(native_stream.httpx, "Client", stream_client(script)), \
             content_stream.scope(lambda _text: None, None, events.append):
            try:
                result = native_stream.post_native_stream(
                    "https://api.anthropic.invalid", json=payload or {"max_tokens": 2000}, headers={},
                    timeout=5.0, cancel_check=None, provider="anthropic", model="claude-x", trace_file="t")
            except Exception as error:  # noqa: BLE001
                result = error
        return result, time.perf_counter() - started, events

    def test_anthropic_pings_only_stall(self):
        def script():
            yield from sse({"type": "message_start", "message": {"id": "m", "usage": {}}})
            for _ in range(200):
                yield 0.05
                yield from sse({"type": "ping"})
        with limits(first=0.4):
            result, elapsed, events = self.run_native(script)
        self.assertEqual(getattr(result, "stream_stop_code", None), "ai_provider_stalled")
        self.assertLess(elapsed, 1.2)
        self.assertEqual(events[-1]["phase"], "stalled")

    def test_anthropic_thinking_then_text_counts_lines(self):
        def script():
            yield from sse({"type": "message_start", "message": {"id": "m", "usage": {}}})
            yield from sse({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}})
            for _ in range(5):
                yield 0.03
                yield from sse({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "…"}})
            yield from sse({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}})
            for i in range(3):
                yield from sse({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": f"<<TP_P{i}:t>>\n"}})
            yield from sse({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 9}})
            yield from sse({"type": "message_stop"})
        with limits(floor=1.0, ceil=600.0):
            expected_limit = round(SP.thinking_limit_sec(1024) * 1000)
            result, _, events = self.run_native(script, {"max_tokens": 4000, "thinking": {"type": "enabled", "budget_tokens": 1024}})
        self.assertIsInstance(result, httpx.Response, result)
        self.assertEqual(phases(events)[-2:], ["thinking", "writing"])
        self.assertEqual(max(e["linesDone"] or 0 for e in events), 3)
        thinking = next(e for e in events if e["phase"] == "thinking")
        self.assertEqual(thinking["thinkingLimitMs"], expected_limit)
        self.assertEqual(expected_limit, round(1024 / SP.MIN_REASONING_TOKENS_PER_SEC * 1000))

    def test_adapter_line_ids_give_native_stream_a_line_total(self):
        def script():
            yield from sse({"type": "message_start", "message": {"id": "m", "usage": {}}})
            yield from sse({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
            for i in range(2):
                yield from sse({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": f"<<TP_P{i}:t>>\n"}})
            yield from sse({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "<<TP_P9:not ours>>\n"}})
            yield from sse({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 9}})
            yield from sse({"type": "message_stop"})
        with limits(), SP.expected_lines(["P0", "P1", "P2"]):
            result, _, events = self.run_native(script)
        self.assertIsInstance(result, httpx.Response, result)
        writing = [e for e in events if e["phase"] == "writing"]
        self.assertTrue(writing and all(e["linesTotal"] == 3 for e in writing))
        self.assertEqual(writing[-1]["linesDone"], 2, "only the request's own IDs count")
        self.assertEqual(SP.current_line_ids(), [], "the scope ends with the request")

    def test_native_adapters_publish_request_line_ids(self):
        seen = []
        def capture(*_args, **_kwargs):
            seen.append(SP.current_line_ids())
            raise RuntimeError("stop")
        for module in (cloud_anthropic, cloud_gemini):
            with patch.object(module.ADAPTER, "_generate", side_effect=capture):
                with self.assertRaises(RuntimeError):
                    module.ADAPTER.generate(SimpleNamespace(expected_ids=("P0", "P1")))
        self.assertEqual(seen, [["P0", "P1"], ["P0", "P1"]])

    def test_gemini_thought_parts_are_thinking(self):
        state = native_stream.NativeResponse("gemini", "g")
        seen = []
        class Guard:
            def thinking(self): seen.append("thinking")
            def keepalive(self): seen.append("waiting")
            def writing(self, _n=None): seen.append("writing")
        state.guard = Guard()
        state.accept({"candidates": [{"content": {"parts": [{"thought": True, "text": "plan"}]}}]})
        state.accept({"usageMetadata": {"promptTokenCount": 1}})
        state.accept({"candidates": [{"content": {"parts": [{"text": "<<TP_P0:a>>"}]}}]})
        self.assertEqual(seen, ["thinking", "waiting", "writing"])


# ----------------------------------------------------------- NDJSON + Paid
def http_request(headers=()):
    messages = asyncio.Queue()
    scope = {"type": "http", "method": "POST", "path": "/translate", "headers": list(headers),
             "asgi": {"spec_version": "2.3"}}
    return Request(scope, messages.get)


class DeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def collect(self, phases_on):
        async def invoke(**_kwargs):
            def work():
                content_stream.report({"phase": "thinking", "phaseElapsedMs": 1200, "elapsedMs": 1500,
                                       "linesDone": None, "linesTotal": 93, "thinkingLimitMs": 136000,
                                       "keepalive": False, "text": "never forwarded"})
                content_stream.emit("<<TP_P0:x>>")
            await asyncio.to_thread(work)
            return {"schema": "tp.ai.result/1", "translations": []}
        response = await streaming.respond(http_request(), invoke, phases=phases_on)
        return [json.loads(line) async for line in response.body_iterator]

    async def test_progress_rows_only_when_requested(self):
        rows = await self.collect(True)
        self.assertEqual([r["type"] for r in rows], ["progress", "delta", "result"])
        self.assertEqual([r["sequence"] for r in rows], [1, 2, 3])
        progress = rows[0]
        self.assertEqual(progress["phase"], "thinking")
        self.assertEqual(progress["linesTotal"], 93)
        self.assertNotIn("text", progress, "phase rows never carry model text")
        rows = await self.collect(False)
        self.assertEqual([r["type"] for r in rows], ["delta", "result"])

    def test_header_and_row_projection(self):
        self.assertTrue(streaming.phases_requested(http_request([(b"x-tp-stream-phases", b"1")])))
        self.assertFalse(streaming.phases_requested(http_request()))
        self.assertIsNone(streaming.progress_row({"phase": "dreaming"}))
        self.assertEqual(streaming.progress_row({"phase": "writing", "linesDone": 12, "linesTotal": 93, "elapsedMs": -1}),
                         {"phase": "writing", "linesDone": 12, "linesTotal": 93})


class WritingStopEndToEndTests(unittest.IsolatedAsyncioTestCase):
    """A writing-phase stop, from the fake provider through the real API error
    mapper and NDJSON envelope: completed lines reach the client as deltas
    before the typed error, which carries what the extension needs to keep
    them (code, requestDispatched, generationAttempts). The extension half is
    test-ai-progress-phases-10489.mjs ("partial lines kept")."""

    async def test_completed_lines_precede_typed_stop(self):
        from fastapi import HTTPException
        from backend.application.ai_translation import provider_errors

        def script():
            yield ": OPENROUTER PROCESSING"
            yield reasoning()
            yield from lines(2)
            for _ in range(200):
                yield 0.03
                yield content("ซ้ำ")
            yield from DONE

        ctx = SimpleNamespace(trace_id="t", correlation={}, requested_route="server", route_identity={},
                              resolved_provider="openrouter", resolved_model="m", unit_count=4, char_count=8,
                              rate={"enabled": False}, unlimited=False,
                              config=SimpleNamespace(image_b64="", provider="openrouter", model="m",
                                                     base_url="", api_key=""))

        def work():
            with patch.object(httpx, "Client", stream_client(script)):
                try:
                    execute_chat_completion(
                        url="https://openrouter.ai/api/v1/chat/completions", headers={},
                        payload={"messages": []}, model="m", provider_id="openrouter",
                        timeout=5.0, timeout_policy="test", expected_ids=list(IDS))
                except Exception as error:  # noqa: BLE001 - mapped like orchestration does
                    provider_errors._raise_provider_failure(ctx, error, 0, 0, 0)
            raise AssertionError("the looping stream must be stopped")

        async def invoke(**_kwargs):
            return await asyncio.to_thread(work)

        with limits(line=0.4, report=0.05), \
             patch.object(provider_errors, "trace_failure", lambda *a, **k: None), \
             patch.object(provider_errors, "failure_event", lambda *a, **k: None):
            response = await streaming.respond(http_request(), invoke, phases=True)
            rows = [json.loads(line) async for line in response.body_iterator]
        kinds = [row["type"] for row in rows]
        self.assertEqual(kinds[0], "progress", "the waiting/thinking phase is visible before any text")
        self.assertEqual(kinds[-1], "error")
        text = "".join(row["text"] for row in rows if row["type"] == "delta")
        self.assertIn("<<TP_P0:คำแปล0>>", text)
        self.assertIn("<<TP_P1:คำแปล1>>", text)
        last_delta = max(i for i, kind in enumerate(kinds) if kind == "delta")
        stopping = [row for row in rows if row["type"] == "progress" and row["phase"] == "stopping"]
        self.assertEqual(stopping[-1]["reason"], "ai_output_no_progress")
        self.assertEqual(stopping[-1]["linesDone"], 2)
        self.assertLess(last_delta, len(rows) - 1)
        phases_seen = phases([row for row in rows if row["type"] == "progress"])
        self.assertEqual(phases_seen, ["waiting", "thinking", "writing", "stopping"])
        detail = rows[-1]["body"]["detail"]
        self.assertEqual(rows[-1]["status"], 502)
        self.assertEqual(detail["code"], "ai_output_no_progress")
        self.assertIs(detail["requestDispatched"], True)
        self.assertEqual(detail["generationAttempts"], 1)
        self.assertEqual(detail["streamStop"]["linesDone"], 2)
        self.assertEqual(detail["streamStop"]["linesTotal"], 4)
        self.assertNotIn("ซ้ำ", json.dumps(detail, ensure_ascii=False), "no model text in the error")


class PaidTests(unittest.TestCase):
    def test_center_progress_rows_and_deltas_drive_phase(self):
        rows = [{"type": "progress", "phase": "waiting"}, {"type": "progress", "phase": "thinking"},
                {"type": "delta", "text": "<<TP_P0:a>>\n<<TP_P1"}, {"type": "delta", "text": ":b>>\n"},
                {"type": "final", "status": 200, "body": {"ok": True}}]

        class Response:
            is_success = True
            headers = {"content-type": "application/x-ndjson"}
            request = httpx.Request("POST", "https://center.invalid")
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def iter_lines(self):
                return (json.dumps(row) for row in rows)

        class Client:
            @contextmanager
            def stream(self, *_a, **_k):
                yield Response()

        events = []
        progress = SP.StreamProgress(enforce=False, report=events.append, lines_total=2)
        with patch.object(SP, "REPORT_INTERVAL_SEC", 0.0), content_stream.scope(lambda _t: None, None, events.append):
            result = cloud_paid._post_center(Client(), "https://center.invalid/x", {"stream": True}, {},
                                             progress=progress, expected_ids=("P0", "P1"))
        self.assertEqual(result.status_code, 200)
        self.assertEqual(phases(events), ["waiting", "thinking", "writing"])
        self.assertEqual(events[-1]["linesDone"], 2)
        self.assertIsNone(progress.check(), "Paid progress is report-only: the Center owns the deadline")

    def test_center_rejection_sends_no_phase_row(self):
        # A Center refusal (credits/admission/replay) is ordinary JSON. It must
        # not open the phase display, or the client's NDJSON response would be
        # committed (HTTP 200) before the Center's HTTP status is known.
        class Response:
            is_success = False
            status_code = 402
            headers = {"content-type": "application/json"}
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self): return b"{}"

        class Client:
            @contextmanager
            def stream(self, *_a, **_k):
                yield Response()

        events = []
        progress = SP.StreamProgress(enforce=False, report=events.append, lines_total=2)
        result = cloud_paid._post_center(Client(), "https://center.invalid/x", {"stream": True}, {},
                                         progress=progress, expected_ids=("P0", "P1"))
        self.assertEqual(result.status_code, 402)
        self.assertEqual(events, [])


class PaidCenterStreamStop10490(unittest.TestCase):
    def test_specific_reason(self):
        """Center .90 stops a streamed Paid call with details.stream_stop: the page shows why."""
        from backend.ai.clients.provider_error import ProviderHttpError
        from backend.ai.failure_reason import provider_http_failure
        error = ProviderHttpError("x", provider="paid", model="m", status=503, provider_code="PROVIDER_OUTCOME_UNKNOWN")
        assert provider_http_failure(error).code == "paid_outcome_pending"
        error.stream_stop_code = "ai_thinking_too_long"
        failure = provider_http_failure(error)
        assert (failure.status, failure.code, failure.retryable) == (503, "ai_thinking_too_long", False)


if __name__ == "__main__":
    unittest.main()
