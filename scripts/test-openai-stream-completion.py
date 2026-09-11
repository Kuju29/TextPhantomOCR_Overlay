#!/usr/bin/env python3
"""Offline regressions for the OpenAI SSE completion hot path."""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "api"))

import httpx
from backend.ai import wire_trace
from backend.ai.transports.openai_chat import (
    _JsonClosureGate,
    _JsonObjectCompletionDetector,
    _WireStreamCapture,
    execute_chat_completion,
)


def sse(content_chunks, *, after=(), terminal=True):
    lines = ["data: " + json.dumps({
        "id": "response-1", "model": "actual-model", "provider": "upstream",
        "choices": [{"delta": {"content": chunk}, "finish_reason": None}],
    }) for chunk in content_chunks]
    lines.extend(after)
    if terminal:
        lines.extend([
            "data: " + json.dumps({
                "choices": [{"delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
            }),
            "data: [DONE]",
        ])
    return lines


class Response:
    is_success = True
    status_code = 200

    def __init__(self, lines): self.lines = lines
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def raise_for_status(self): return None
    def close(self): return None
    def iter_lines(self): yield from self.lines


class Client:
    _textphantom_streaming = True
    lines = []

    def __init__(self, *_, **__): pass
    def __enter__(self): return self
    def __exit__(self, *_): return False

    @contextmanager
    def stream(self, *_args, **_kwargs):
        yield Response(self.lines)


def run(chunks, *, after=(), terminal=True, expected_ids=("P0", "P1"), cancel_check=None):
    Client.lines = sse(chunks, after=after, terminal=terminal)
    with patch.object(httpx, "Client", Client):
        return execute_chat_completion(
            url="https://openrouter.ai/api/v1/chat/completions",
            headers={}, payload={"messages": []}, model="requested-model",
            provider_id="openrouter", timeout=1, timeout_policy="test",
            expected_ids=list(expected_ids), cancel_check=cancel_check,
        )


class JsonDetectorTests(unittest.TestCase):
    def valid(self, source):
        detector = _JsonObjectCompletionDetector(["P0", "P1"])
        return detector.inspect(source, 12.5)

    def test_accepts_only_exact_flat_nonempty_contract(self):
        self.assertEqual(self.valid('{"P0":"one","P1":"two"}'), "all_json_fields_closed")
        invalid = (
            '{"P0":"one"}',
            '{"P0":"one","P1":""}',
            '{"P0":"one","P1":{"nested":"two"}}',
            '{"P0":"one","P0":"again","P1":"two"}',
            '{"P0":"one","P1":"two","P2":"extra"}',
            '{"P0":"one","P1":"two"',
            '[]', '{}',
            'prefix {"P0":"one","P1":"two"}',
            '```json\n{"P0":"one","P1":"two"}\n```',
            '{"P0":"one","P1":"two"} suffix',
        )
        for source in invalid:
            with self.subTest(source=source): self.assertIsNone(self.valid(source))

    def test_gate_ignores_braces_in_strings_and_emits_once(self):
        gate = _JsonClosureGate()
        chunks = ['{"P0":"a } ', 'and \\" quoted","P1":"b"', '}']
        self.assertEqual([gate.feed(chunk) for chunk in chunks], [False, False, True])
        self.assertFalse(gate.feed("}"))

    def test_json_unicode_escapes_and_braces_in_strings(self):
        source = json.dumps({"P0": 'ไทย ก } { \\ "', "P1": "日本語"},
                            ensure_ascii=True, separators=(",", ":"))
        gate = _JsonClosureGate()
        detector = _JsonObjectCompletionDetector(["P0", "P1"])
        evidence = None
        assembled = []
        for character in source:
            assembled.append(character)
            if gate.feed(character):
                evidence = detector.inspect("".join(assembled), 2.0)
        self.assertEqual(evidence, "all_json_fields_closed")

    def test_empty_expected_ids_never_report_contract_completion(self):
        detector = _JsonObjectCompletionDetector([])
        self.assertIsNone(detector.inspect('{}', 1.0))
        result = run(["{}"], expected_ids=())
        self.assertIsNone(result.first_all_ids_ms)
        self.assertIsNone(result.early_completion_ms)

    def test_full_json_inspection_is_bounded_by_root_closure_not_chunk_count(self):
        source = '{"P0":"' + ("x" * 8000) + '","P1":"two"}'
        gate = _JsonClosureGate()
        detector = _JsonObjectCompletionDetector(["P0", "P1"])
        evidence = None
        assembled = []
        for chunk in source:  # worst-case one-character provider chunks
            assembled.append(chunk)
            if gate.feed(chunk):
                evidence = detector.inspect("".join(assembled), 1.0)
        self.assertEqual(evidence, "all_json_fields_closed")
        self.assertEqual(detector.full_inspections, 1)


class StreamTests(unittest.TestCase):
    def test_wire_trace_on_persists_exact_raw_assembled_and_terminal(self):
        lines = sse(["<<TP_P0:one>>"], terminal=True)
        Client.lines = lines
        previous = {key: os.environ.get(key) for key in
                    ("TP_AI_WIRE_TRACE", "TP_AI_WIRE_TRACE_DIR")}
        with tempfile.TemporaryDirectory(prefix="tp-openai-wire-") as temp:
            os.environ["TP_AI_WIRE_TRACE"] = "1"
            os.environ["TP_AI_WIRE_TRACE_DIR"] = temp
            token = wire_trace.begin({"traceId": "trace", "operationId": "stream"})
            try:
                with patch.object(httpx, "Client", Client):
                    result = execute_chat_completion(
                        url="https://example.invalid/chat", headers={}, payload={},
                        model="m", provider_id="openrouter", timeout=1,
                        timeout_policy="test", expected_ids=["P0"],
                    )
                wire_trace.terminal(state="succeeded", stage="test")
            finally:
                wire_trace.end(token)
                for key, value in previous.items():
                    if value is None: os.environ.pop(key, None)
                    else: os.environ[key] = value
            folder = Path(temp) / "trace--stream"
            self.assertEqual((folder / "05_provider_response.raw").read_text("utf-8"),
                             "\n".join(lines) + "\n")
            self.assertEqual((folder / "05_provider_response.assembled.txt").read_text("utf-8"),
                             result.text)
            terminal = json.loads((folder / "11_terminal.json").read_text("utf-8"))
            self.assertTrue(terminal["terminal"])
            self.assertEqual(terminal["state"], "succeeded")

    def test_chunked_json_keeps_golden_result_and_drains_terminal_frames(self):
        raw, assembled = [], []
        with patch("backend.ai.transports.openai_chat.wire_trace.append_text",
                   side_effect=lambda name, value: raw.append((name, value))), \
             patch("backend.ai.transports.openai_chat.wire_trace.assembled_response",
                   side_effect=assembled.append):
            result = run(['{"P0":"one with } text",', '"P1":"two"', '}'], after=(
                'data: {"choices":[],"usage":{"prompt_tokens":11}}',
            ))
        self.assertEqual(result.text, '{"P0":"one with } text","P1":"two"}')
        self.assertEqual(result.used_model, "actual-model")
        self.assertEqual((result.input_tokens, result.output_tokens, result.total_tokens), (11, 7, 18))
        self.assertEqual(result.finish_reason, "stop")
        self.assertTrue(result.terminal_completed)
        self.assertEqual(result.terminal_evidence, "protocol_done")
        self.assertEqual(result.upstream_provider, "upstream")
        self.assertIsNotNone(result.first_all_ids_ms)
        self.assertIsNotNone(result.early_completion_ms)
        self.assertEqual(assembled, [result.text])
        # Raw capture includes content, the post-contract usage frame, terminal
        # finish/usage, and [DONE]; completion evidence never truncates it.
        self.assertEqual(len(raw), 1)
        self.assertEqual(raw[0][0], "05_provider_response.raw")
        self.assertTrue(raw[0][1].strip().endswith("[DONE]"))

    def test_wire_buffer_preserves_exact_order_and_bounds_pending_memory(self):
        writes = []
        with patch("backend.ai.transports.openai_chat.wire_trace.append_text",
                   side_effect=lambda name, value: writes.append((name, value))), \
             patch("backend.ai.transports.openai_chat.wire_trace.assembled_response") as assembled:
            capture = _WireStreamCapture(max_lines=2, max_chars=1024)
            for line in ("one\n", "two\n", "three\n"):
                capture.raw(line)
            capture.finish("visible")
        self.assertEqual("".join(value for _, value in writes), "one\ntwo\nthree\n")
        self.assertEqual(len(writes), 2)
        assembled.assert_called_once_with("visible")

    def test_malformed_sse_flushes_exact_received_prefix_once(self):
        Client.lines = sse(["partial"], after=("data: not-json",), terminal=False)
        raw, assembled = [], []
        with patch.object(httpx, "Client", Client), \
             patch("backend.ai.transports.openai_chat.wire_trace.append_text",
                   side_effect=lambda _name, value: raw.append(value)), \
             patch("backend.ai.transports.openai_chat.wire_trace.assembled_response",
                   side_effect=assembled.append):
            with self.assertRaisesRegex(RuntimeError, "invalid SSE"):
                execute_chat_completion(
                    url="https://example.invalid/chat", headers={}, payload={},
                    model="m", provider_id="openrouter", timeout=1,
                    timeout_policy="test", expected_ids=["P0"],
                )
        self.assertEqual("".join(raw), "\n".join(Client.lines) + "\n")
        self.assertEqual(assembled, ["partial"])

    def test_marker_delimiter_split_at_both_record_boundaries(self):
        # Both record delimiters are split across SSE content frames.
        result = run(["<<TP_P0:one>", ">\n<<TP_P1:two>", ">"])
        self.assertEqual(result.text, "<<TP_P0:one>>\n<<TP_P1:two>>")
        self.assertIsNotNone(result.first_all_ids_ms)
        self.assertIsNotNone(result.early_completion_ms)

    def test_marker_contract_detected_at_every_single_split_boundary(self):
        source = "<<TP_P0:one>>\n<<TP_P1:two>>"
        for index in range(1, len(source)):
            with self.subTest(index=index):
                result = run([source[:index], source[index:]])
                self.assertEqual(result.text, source)
                self.assertIsNotNone(result.first_all_ids_ms)

    def test_marker_false_close_candidate_does_not_complete_early(self):
        result = run(["noise >>\n", "<<TP_P0:one>>\n", "<<TP_P1:two>>"])
        self.assertEqual(result.text, "noise >>\n<<TP_P0:one>>\n<<TP_P1:two>>")
        # The strict records contract rejects the prefixed noise even though
        # the candidate gate safely inspected it.
        # ``first_all_ids_ms`` is the legacy detector's loose diagnostic for
        # seeing all IDs; authoritative completion remains absent.
        self.assertIsNotNone(result.first_all_ids_ms)
        self.assertIsNone(result.early_completion_ms)

    def test_content_after_contract_is_retained_while_finish_usage_and_done_are_drained(self):
        result = run(["<<TP_P0:one>>\n<<TP_P1:two>>", " trailing"])
        self.assertEqual(result.text, "<<TP_P0:one>>\n<<TP_P1:two>> trailing")
        self.assertEqual(result.total_tokens, 18)
        self.assertEqual(result.finish_reason, "stop")
        self.assertEqual(result.terminal_evidence, "protocol_done")

    def test_missing_terminal_is_not_promoted_by_complete_contract(self):
        result = run(["<<TP_P0:one>>\n<<TP_P1:two>>"], terminal=False)
        self.assertFalse(result.terminal_completed)
        self.assertEqual(result.terminal_evidence, "none")
        self.assertIsNotNone(result.early_completion_ms)
        self.assertIsNone(result.total_tokens)

    def test_malformed_sse_preserves_protocol_error_semantics(self):
        Client.lines = ["data: not-json"]
        with patch.object(httpx, "Client", Client):
            with self.assertRaisesRegex(RuntimeError, "invalid SSE"):
                execute_chat_completion(
                    url="https://example.invalid/chat", headers={}, payload={},
                    model="m", provider_id="openrouter", timeout=1,
                    timeout_policy="test", expected_ids=["P0"],
                )

    def test_preflight_cancellation_does_not_open_stream(self):
        Client.lines = sse(["<<TP_P0:one>>\n<<TP_P1:two>>"])
        with patch.object(httpx, "Client", Client):
            from backend.ai.clients.base import ProviderGenerationCancelled
            with self.assertRaises(ProviderGenerationCancelled):
                execute_chat_completion(
                    url="https://example.invalid/chat", headers={}, payload={},
                    model="m", provider_id="openrouter", timeout=1,
                    timeout_policy="test", expected_ids=["P0", "P1"],
                    cancel_check=lambda: True,
                )

    def test_in_stream_cancellation_remains_provider_generation_cancelled(self):
        Client.lines = sse(["partial", " still partial"])
        calls = 0
        def cancel():
            nonlocal calls
            calls += 1
            return calls >= 2
        with patch.object(httpx, "Client", Client):
            from backend.ai.clients.base import ProviderGenerationCancelled
            with self.assertRaises(ProviderGenerationCancelled):
                execute_chat_completion(
                    url="https://example.invalid/chat", headers={}, payload={},
                    model="m", provider_id="openrouter", timeout=1,
                    timeout_policy="test", expected_ids=["P0"],
                    cancel_check=cancel,
                )

    def test_in_stream_cancellation_flushes_received_partial_trace(self):
        Client.lines = sse(["first", "second"])
        calls, raw, assembled = 0, [], []
        def cancel():
            nonlocal calls
            calls += 1
            return calls >= 3
        with patch.object(httpx, "Client", Client), \
             patch("backend.ai.transports.openai_chat.wire_trace.append_text",
                   side_effect=lambda _name, value: raw.append(value)), \
             patch("backend.ai.transports.openai_chat.wire_trace.assembled_response",
                   side_effect=assembled.append):
            from backend.ai.clients.base import ProviderGenerationCancelled
            with self.assertRaises(ProviderGenerationCancelled):
                execute_chat_completion(
                    url="https://example.invalid/chat", headers={}, payload={},
                    model="m", provider_id="openrouter", timeout=1,
                    timeout_policy="test", expected_ids=["P0"],
                    cancel_check=cancel,
                )
        self.assertEqual("".join(raw), Client.lines[0] + "\n")
        self.assertEqual(assembled, ["first"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
