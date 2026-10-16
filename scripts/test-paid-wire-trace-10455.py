"""Paid diagnostic response capture against the real adapter and trace writer.

All Center traffic is httpx.MockTransport. No customer account, wallet, live
provider, or paid generation is contacted. --app-root selects another source
tree for the same regression tests; the portable default is this script's app.
"""
from __future__ import annotations

import argparse
from contextlib import nullcontext
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument("--app-root", type=Path,
                     default=Path(__file__).resolve().parents[1])
_options, _unittest_args = _parser.parse_known_args()
sys.argv = [sys.argv[0], *_unittest_args]
sys.path.insert(0, str(_options.app_root.resolve() / "api"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
os.environ["TP_CENTER_URL"] = "https://center.fixture.invalid"
os.environ["TP_LOG_FILE"] = "0"

import httpx
from paid_center_fake import reset_protocol_cache, with_healthz
from backend.ai import accounting, wire_trace
from backend.ai.clients.provider_error import ProviderTransportError
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import cloud_paid


CUSTOMER_KEY = "SYNTHETIC_CUSTOMER_SECRET_10455_0123456789"
REASONING = "SYNTHETIC_PRIVATE_REASONING_10455"
ARBITRARY = "SYNTHETIC_UNVALIDATED_BODY_10455"
VISIBLE = "<<TP_P0:คำแปลทดสอบ>>"
OMITTED = "[raw provider response omitted]\n"


class PaidWireTraceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.sequence = 0

    def request(self):
        return GenerationRequest(
            provider="paid", model="fixture/selected", api_key=CUSTOMER_KEY,
            system_text="Translate the supplied synthetic unit.",
            user_parts=("<<TP_P0:synthetic source>>",), expected_ids=("P0",),
            source_unit_texts=("synthetic source",), unit_count=1,
            model_capabilities={"limits": {"maxOutputTokens": 2048}},
            cache_context={"operationId": "fixture-click-10455",
                           "conversationScope": "fixture-owned-run",
                           "paidPriceQuoteToken": "synthetic-click-approved-token"})

    def completion(self, text=VISIBLE):
        return {"id": "synthetic-result", "model": "fixture/selected",
                "choices": [{"message": {"content": text,
                                            "reasoning_content": REASONING},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5,
                          "total_tokens": 15, "cost": "0.0001"},
                "charged_tp": 3, "balance_tp": 997,
                "unvalidated_payload": ARBITRARY}

    def invoke(self, *, enabled=True, replay=False, body=None, status=200,
               raw_body=None, fail_write=None, prime_previous_secret=False):
        """Capture the actual response/exception plus every mocked HTTP call.

        Path.open failure is injected at the real trace disk writer, after
        trace ingress succeeds. It is not a replacement logging function.
        """
        self.sequence += 1
        trace_root = Path(self.temp.name) / f"case-{self.sequence}"
        calls = []
        writes_failed = []
        real_client = httpx.Client
        real_open = Path.open
        response_body = self.completion() if body is None else body

        def handle(request):
            self.assertEqual((request.url.scheme, request.url.host),
                             ("https", "center.fixture.invalid"))
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.headers["authorization"], "Bearer " + CUSTOMER_KEY)
            outgoing = json.loads(request.content)
            calls.append({"path": request.url.path, "body": outgoing})
            # No separate receipt or price-quote hop: the chat route admits the
            # current route atomically and performs the owned replay itself.
            self.assertEqual(request.url.path, "/api/customer/chat/completions")
            self.assertEqual(len(outgoing["operation_id"]), 64)
            self.assertNotIn(CUSTOMER_KEY, outgoing["operation_id"])
            self.assertNotIn("price_quote_token", outgoing)  # Center admits the current route atomically.
            # Paid sends the same workload output budget Manual would (prepare_payload).
            manual = cloud_paid.prepare_payload(self.request())
            self.assertEqual(outgoing["max_tokens"],
                             max(64, min(32768, manual.get("max_completion_tokens", manual.get("max_tokens")))))
            if raw_body is not None:
                return httpx.Response(status, content=raw_body)
            if replay:
                return httpx.Response(status, json={**response_body, "operation_replayed": True},
                                      headers={"x-tp-operation-replayed": "true"})
            return httpx.Response(status, json=response_body)

        def faulty_open(path, mode="r", *args, **kwargs):
            if path.name == fail_write and any(x in mode for x in ("w", "a", "+")):
                writes_failed.append(path.name)
                raise OSError("synthetic trace disk unavailable")
            return real_open(path, mode, *args, **kwargs)

        with patch.dict(os.environ, {"TP_AI_WIRE_TRACE": "1" if enabled else "0",
                                    "TP_AI_WIRE_TRACE_DIR": str(trace_root)}):
            if prime_previous_secret:
                old = wire_trace.begin({"traceId": "fixture-old", "operationId": "old"})
                try:
                    wire_trace.provider_request(url="https://center.fixture.invalid/old",
                        headers={"Authorization": "Bearer SYNTHETIC_OLD_SECRET"}, payload={})
                finally:
                    wire_trace.end(old)
            token = wire_trace.begin({"traceId": "fixture-current",
                                      "operationId": f"current-{self.sequence}"})
            folder = wire_trace.active_folder()
            result = failure = None
            try:
                reset_protocol_cache()  # + the Paid protocol health read (shared fake)
                with patch.object(cloud_paid.httpx, "Client", side_effect=lambda **kw:
                        real_client(**{**kw, "transport": httpx.MockTransport(with_healthz(handle))})), \
                        patch.object(accounting, "mark_dispatched",
                                     wraps=accounting.mark_dispatched) as dispatched, \
                        (patch.object(Path, "open", faulty_open)
                         if fail_write else nullcontext()):
                    try:
                        result = cloud_paid.PaidAdapter().generate(self.request())
                    except Exception as exc:
                        failure = exc
                    dispatch_count = dispatched.call_count
                active_after = wire_trace.active_folder()
            finally:
                wire_trace.end(token)
            artifacts = {} if folder is None else {
                path.name: path.read_text("utf-8") for path in folder.iterdir() if path.is_file()}
            all_files = [str(p.relative_to(trace_root)) for p in trace_root.rglob("*")
                         if p.is_file()] if trace_root.exists() else []
        return {"result": result, "failure": failure, "calls": calls,
                "dispatchCount": dispatch_count, "artifacts": artifacts,
                "allFiles": all_files, "writesFailed": writes_failed,
                "degraded": folder is not None and active_after is None}

    def assert_calls(self, outcome, *, replay=False, dispatch=1):
        self.assertEqual([row["path"] for row in outcome["calls"]],
                         ["/api/customer/chat/completions"])
        self.assertEqual(outcome["dispatchCount"], dispatch)

    def assert_success(self, outcome, *, text=VISIBLE, replay=False):
        self.assertIsNone(outcome["failure"])
        result = outcome["result"]
        self.assertEqual(result.text, text)
        self.assertEqual(result.used_model, "fixture/selected")
        self.assertEqual((result.input_tokens, result.output_tokens, result.total_tokens),
                         (10, 5, 15))
        self.assertEqual((result.finish_reason, result.usage_source,
                          result.terminal_completed, result.terminal_evidence),
                         ("stop", "center_paid", True, "center_http_json"))
        self.assertEqual(result.usage_details["providerCostUsd"], "0.0001")
        self.assertEqual(result.usage_details["billingAuthority"], "center_paid")
        self.assertEqual((result.usage_details["chargedTp"],
                          result.usage_details["balanceTp"],
                          result.usage_details["centerOperationReplayed"]), (3, 997, replay))
        self.assertEqual(result.usage_details["usageStatus"], "reported")
        if replay:
            self.assertEqual(result.provider_ms, 0)
        else:
            self.assertGreaterEqual(result.provider_ms, 0)
        self.assert_calls(outcome, replay=replay, dispatch=0 if replay else 1)
        return result

    def assert_safe_capture(self, outcome, *, status=200, visible=VISIBLE):
        artifacts = outcome["artifacts"]
        self.assertTrue("05_provider_response.meta.json" in artifacts,
                        "Paid response status metadata was not captured")
        self.assertEqual(json.loads(artifacts["05_provider_response.meta.json"]),
                         {"status": status, "streamed": False, "bodyStored": False})
        self.assertEqual(artifacts["05_provider_response.raw"], OMITTED)
        self.assertEqual(artifacts["05_provider_response.assembled.txt"], visible)
        all_text = "\n".join(artifacts.values())
        for private in (CUSTOMER_KEY, REASONING, ARBITRARY):
            self.assertNotIn(private, all_text)
        self.assertNotIn("response-stream.sse", artifacts)

    def test_fresh_completion_records_visible_status_without_raw_body(self):
        outcome = self.invoke()
        self.assert_success(outcome)
        self.assert_safe_capture(outcome)
        request = json.loads(outcome["artifacts"]["04_provider_request.json"])
        self.assertEqual(request["headers"]["Authorization"], "<redacted>")
        boundary = json.loads(outcome["artifacts"]["04_paid_boundary.json"])
        self.assertEqual((boundary["recordKind"], boundary["providerKeyOwner"]),
                         ("paid_proxy", "center"))

    def test_echoed_customer_key_redacts_only_fresh_diagnostic_copy(self):
        text = VISIBLE + " / " + CUSTOMER_KEY + " / " + CUSTOMER_KEY
        outcome = self.invoke(body=self.completion(text))
        self.assert_success(outcome, text=text)
        self.assert_safe_capture(outcome, visible=text.replace(CUSTOMER_KEY, "<redacted>"))

    def test_replay_after_secret_reset_has_no_quote_or_new_dispatch(self):
        text = VISIBLE + " / " + CUSTOMER_KEY
        outcome = self.invoke(replay=True, body=self.completion(text), prime_previous_secret=True)
        self.assert_success(outcome, text=text, replay=True)
        self.assert_safe_capture(outcome, visible=text.replace(CUSTOMER_KEY, "<redacted>"))
        # The replay now comes back from the Center chat route itself, so the
        # request to the Center is recorded (redacted) though no AI was dispatched.
        request = json.loads(outcome["artifacts"]["04_provider_request.json"])
        self.assertEqual(request["url"], "https://center.fixture.invalid/api/customer/chat/completions")
        self.assertEqual(request["headers"]["Authorization"], "<redacted>")
        self.assertNotIn("SYNTHETIC_OLD_SECRET", "\n".join(outcome["artifacts"].values()))

    def test_trace_off_creates_no_files_and_preserves_result_and_requests(self):
        captured = self.invoke()
        disabled = self.invoke(enabled=False)
        self.assert_success(disabled)
        self.assertEqual(disabled["artifacts"], {})
        self.assertEqual(disabled["allFiles"], [])
        self.assertEqual(captured["result"]._replace(provider_ms=None),
                         disabled["result"]._replace(provider_ms=None))
        self.assertEqual(captured["calls"], disabled["calls"])

    def test_real_disk_write_failure_never_changes_paid_result_or_retries(self):
        control = self.invoke()
        for target in ("05_provider_response.meta.json", "05_provider_response.assembled.txt"):
            with self.subTest(target=target):
                outcome = self.invoke(fail_write=target)
                result = self.assert_success(outcome)
                self.assertEqual(result._replace(provider_ms=None),
                                 control["result"]._replace(provider_ms=None))
                self.assertEqual(outcome["writesFailed"], [target])
                self.assertTrue(outcome["degraded"])
                self.assertEqual(outcome["calls"], control["calls"])
                self.assertNotIn(CUSTOMER_KEY, "\n".join(outcome["artifacts"].values()))

    def test_invalid_content_is_not_logged_as_visible_text(self):
        body = self.completion()
        body["choices"][0]["message"]["content"] = {"unvalidated": ARBITRARY,
                                                       "secret": CUSTOMER_KEY}
        outcome = self.invoke(body=body)
        self.assertIsInstance(outcome["failure"], ProviderTransportError)
        self.assertEqual(str(outcome["failure"]), "Center returned an invalid Paid completion")
        self.assertIsNone(outcome["result"])
        self.assert_calls(outcome)
        self.assert_safe_capture(outcome, visible="")

    def test_malformed_json_keeps_safe_status_and_no_assembled_payload(self):
        outcome = self.invoke(raw_body=(ARBITRARY + " " + REASONING + " " + CUSTOMER_KEY).encode())
        self.assertIsInstance(outcome["failure"], ProviderTransportError)
        self.assert_calls(outcome)
        self.assert_safe_capture(outcome, visible="")

    def test_known_admission_error_records_status_without_dispatch_or_error_body(self):
        outcome = self.invoke(status=503, body={"error": {"code": "PAID_PAUSED",
            "message": ARBITRARY + CUSTOMER_KEY, "reasoning": REASONING,
            "details": {"credit_state": "not_reserved"}}})
        failure = outcome["failure"]
        self.assertIsNotNone(failure)
        self.assertFalse(failure.requestDispatched)
        self.assertEqual((failure.providerAttempts, failure.generationAttempts), (0, 0))
        self.assert_calls(outcome, dispatch=0)
        self.assert_safe_capture(outcome, status=503, visible="")

    def test_uncertain_upstream_error_preserves_dispatch_and_status_without_body(self):
        outcome = self.invoke(status=502, body={"error": {"code": "UPSTREAM_FAILED",
            "message": ARBITRARY + CUSTOMER_KEY, "reasoning": REASONING,
            "details": {"provider_dispatched": True, "credit_reserved": True,
                        "credit_state": "released", "upstream_http_status": 429}}})
        failure = outcome["failure"]
        self.assertIsNotNone(failure)
        self.assertEqual((failure.status, failure.center_http_status), (429, 502))
        self.assert_calls(outcome, dispatch=1)
        self.assert_safe_capture(outcome, status=502, visible="")


if __name__ == "__main__":
    unittest.main(verbosity=2)
