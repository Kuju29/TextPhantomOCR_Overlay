"""Center admission evidence must not invent an AI dispatch or usage receipt."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(ROOT / "scripts" / "lib"))
os.environ["TP_CENTER_URL"] = "http://127.0.0.1:8787"
# The busy-admission wait queue (≤90 s) is covered by test-paid-admission-wait-10466.py;
# here a busy answer must surface at once so its evidence can be checked.
os.environ["TP_PAID_ADMISSION_WAIT_SECONDS"] = "0"

import httpx
from fastapi import HTTPException
from paid_center_fake import HealthzClient, reset_protocol_cache
from backend.ai import accounting
from backend.ai.clients.provider_error import ProviderHttpError, ProviderTransportError
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers.cloud_paid import ADAPTER
from backend.api.errors import classify_failure
from backend.application.ai_translation.provider_errors import raise_execution_error

checks = []
# The Center chat route performs the owned replay itself (cloud_paid.generate:
# "No separate receipt or price-quote round trip for every new operation"), so
# one admission request is the whole Center conversation for a new operation.
CHAT_URL = "http://127.0.0.1:8787/api/customer/chat/completions"

def check(name, passed):
    checks.append({"name": name, "passed": bool(passed)})
    assert passed, name

request = GenerationRequest(provider="paid", model="qa/test", api_key="synthetic-session",
    system_text="QA", user_parts=("hello",), cache_context={"operationId": "admission-qa"})
context = SimpleNamespace(unit_count=1, char_count=5, trace_id="qa10414",
    correlation={}, route_identity={}, requested_route="/v2/engine/runsextension/ai/translate",
    resolved_provider="paid", resolved_model="qa/test", rate={"enabled": False},
    unlimited=False, config=SimpleNamespace(provider="paid", model="qa/test", image_b64=""))

def run_response(status, body=None, transport_error=False):
    calls = []
    reset_protocol_cache()
    class CenterClient(HealthzClient):  # also answers the Paid protocol health read
        def post(self, url, **kwargs):
            calls.append(url)
            if url.endswith('/chat/receipt'):
                return httpx.Response(200, json={'found': False})
            if transport_error:
                raise httpx.ReadTimeout("synthetic transport loss")
            return httpx.Response(status, json=body)
    with patch("backend.ai.providers.cloud_paid.httpx.Client", CenterClient):
        with accounting.receipt_scope("runsextension", "admission-qa"):
            caught = None
            try:
                accounting.generate_with_receipt(ADAPTER, request)
            except (ProviderHttpError, ProviderTransportError) as exc:
                caught = exc
            observations = list(accounting._receipts.get())
    assert caught is not None
    with patch("backend.application.ai_translation.provider_errors.trace.write"), \
         patch("backend.application.ai_translation.provider_errors.failure_event"):
        try:
            raise_execution_error(context, caught, rate_wait_ms=0,
                                  admission_wait_ms=0, provider_ms=1)
        except HTTPException as exc:
            return caught, exc.detail, observations, calls
    raise AssertionError("Missing public failure")

for status, code in [(402, "INSUFFICIENT_CREDITS"), (429, "PAID_CAPACITY_BUSY"),
                     (503, "PAID_PAUSED"), (503, "PAID_MODEL_PAUSED"), (401, "AUTH_REQUIRED"),
                     (503, "MODEL_PRICE_UNVERIFIED")]:
    error, detail, receipts, calls = run_response(status, {"error": {"code": code}})
    check(code + " has exactly one Center chat request (no receipt round trip) and zero provider generations",
          calls == [CHAT_URL] and error.requestDispatched is False
          and error.providerAttempts == error.generationAttempts == 0)
    check(code + " does not create an unknown provider usage receipt", not receipts)
    check(code + " public failure distinguishes admission from upstream AI",
          detail["origin"] == "control_center" and detail["stage"] == "paid_admission"
          and detail["requestDispatched"] is False
          and detail["centerRequestDispatched"] is True
          and detail["providerAttempts"] == detail["generationAttempts"] == 0
          and "upstreamStatus" not in detail and detail["creditReserved"] is False)
    activity = classify_failure(detail)
    check(code + " diagnostic ownership is blocked Paid service",
          activity["owner"] == "paid_service" and activity["outcome"] == "blocked")

for name, status, body in [
    ("actual upstream 402", 502, {"error": {"code": "PAID_PROVIDER_BALANCE",
        "details": {"upstream_http_status": 402, "credit_state": "released"}}}),
    ("unknown Center 402", 402, {"error": {"code": "UNRECOGNIZED_402"}}),
    ("admission label with contrary dispatch evidence", 402, {"error": {
        "code": "INSUFFICIENT_CREDITS", "details": {"provider_dispatched": True}}}),
    ("admission label with upstream evidence", 402, {"error": {
        "code": "INSUFFICIENT_CREDITS", "details": {"upstream_http_status": 402}}}),
    ("admission label with reserved-credit evidence", 402, {"error": {
        "code": "INSUFFICIENT_CREDITS", "details": {"credit_state": "held"}}}),
    ("admission label with unexpected status", 500, {"error": {
        "code": "INSUFFICIENT_CREDITS"}}),
]:
    error, detail, receipts, calls = run_response(status, body)
    check(name + " preserves possible dispatch and a usage observation",
          calls == [CHAT_URL] and error.requestDispatched is True and len(receipts) == 1
          and detail["requestDispatched"] is True
          and detail["origin"] == "upstream_ai" and "centerAdmissionRejected" not in detail)

error, detail, receipts, calls = run_response(0, transport_error=True)
check("lost Center response remains uncertain after possible dispatch",
      calls == [CHAT_URL] and error.requestDispatched is True and len(receipts) == 1
      and detail["code"] == "paid_outcome_pending" and detail["origin"] == "upstream_ai")

print(json.dumps({"scope": "Actual Paid adapter, provider receipt and public error mapping; synthetic Center responses only",
                  "passed": True, "total": len(checks), "checks": checks}, indent=2))
