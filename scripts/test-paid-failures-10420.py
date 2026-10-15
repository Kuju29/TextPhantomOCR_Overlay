"""Run separately from Center imports; real PaidAdapter, synthetic Center HTTP."""
import sys
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'api'))
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import cloud_paid
from backend.ai.clients.provider_error import ProviderHttpError, ProviderTransportError


@pytest.fixture
def boundary(monkeypatch):
    state = {"posts": [], "dispatched": [], "response": None}
    monkeypatch.setattr(cloud_paid, "center_base_url", lambda: "https://center.example")
    monkeypatch.setattr(cloud_paid, "center_origin", lambda: "https://center.example")
    monkeypatch.setattr(cloud_paid.accounting, "mark_dispatched", lambda: state["dispatched"].append(True))
    monkeypatch.setattr(cloud_paid.wire_trace, "provider_request", lambda **kwargs: None)
    monkeypatch.setattr(cloud_paid.wire_trace, "write_json", lambda *args, **kwargs: None)
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, *, json, headers):
            if url.endswith("/chat/receipt"): return httpx.Response(200, json={"found": False})
            if url.endswith("/price-quote"): return httpx.Response(200, json={"quote_token": "qa-fresh-quote"})
            assert url.endswith("/chat/completions")
            state["posts"].append((url, json, headers))
            response = state["response"]
            if isinstance(response, BaseException): raise response
            return response
    monkeypatch.setattr(cloud_paid.httpx, "Client", Client)
    state["request"] = GenerationRequest(provider="paid", model="qa/test", api_key="QA-customer-session",
        system_text="Exact custom prompt", user_parts=("<<TP_P0:Hello>>",), thinking="minimum",
        cache_context={"operationId": "request-QA", "thinkingRequested": "minimum"},
        model_capabilities={"reasoning": {"supported": False}, "limits": {"maxOutputTokens": 8192}})
    return state


@pytest.mark.parametrize("status, code", [
    (402, "INSUFFICIENT_CREDITS"), (403, "MODEL_NOT_ALLOWED"), (429, "PAID_BUSY"), (429, "PAID_CREDITS_RESERVED"),
    (400, "PAID_THINKING_UNSUPPORTED"), (409, "PAID_QUEUE_CANCELLED"),
])
def test_trusted_admission_negative_dispatch_is_retained(boundary, status, code):
    boundary["response"] = httpx.Response(status, json={"error": {"code": code,
        "message": "Admission rejection", "details": {"provider_dispatched": False,
        "credit_reserved": False, "credit_state": "not_reserved"}}})
    with pytest.raises(ProviderHttpError) as error:
        cloud_paid.ADAPTER.generate(boundary["request"])
    failure = error.value
    assert failure.centerAdmissionRejected is True
    assert failure.requestDispatched is False
    assert failure.providerAttempts == failure.generationAttempts == 0
    assert boundary["dispatched"] == [] and len(boundary["posts"]) == 1


@pytest.mark.parametrize("status, code, details, expected", [
    (502, "PAID_PROVIDER_ROUTE", {"upstream_http_status": 404, "provider_dispatched": True, "credit_state": "released"}, 404),
    (502, "PAID_PROVIDER_ROUTE", {"upstream_http_status": 404, "provider_dispatched": True, "credit_state": "uncertain"}, 404),
    (502, "PAID_PROVIDER_AUTH", {"upstream_http_status": 401, "provider_dispatched": True, "credit_state": "released"}, 401),
    (503, "USAGE_UNCONFIRMED", {}, 503),
    (503, "PROVIDER_OUTCOME_UNKNOWN", {}, 503),
    (429, "PAID_BUSY", {"credit_reserved": True, "credit_state": "held"}, 429),
    (429, "PAID_BUSY", {"provider_dispatched": True}, 429),
])
def test_upstream_failure_does_not_invent_admission_evidence_or_retry(boundary, status, code, details, expected):
    boundary["response"] = httpx.Response(status, json={"error": {"code": code,
        "message": "Sanitized customer error", "details": details}})
    with pytest.raises(ProviderHttpError) as error:
        cloud_paid.ADAPTER.generate(boundary["request"])
    failure = error.value
    assert not getattr(failure, "centerAdmissionRejected", False)
    assert failure.status == expected
    assert boundary["dispatched"] == [True] and len(boundary["posts"]) == 1


@pytest.mark.parametrize("reply", [
    httpx.ReadTimeout("QA transport loss"),
    httpx.Response(200, content=b"malformed"),
    httpx.Response(200, json={}),
    httpx.Response(200, json={"choices": []}),
    httpx.Response(200, json={"choices": [{"message": {"content": None}}]}),
])
def test_unknown_transport_or_malformed_completion_has_uncertain_dispatch(boundary, reply):
    boundary["response"] = reply
    with pytest.raises(ProviderTransportError):
        cloud_paid.ADAPTER.generate(boundary["request"])
    assert boundary["dispatched"] == [True] and len(boundary["posts"]) == 1


def test_actual_receipt_and_cache_usage_preserved_without_prompt_mutation(boundary):
    boundary["response"] = httpx.Response(200, json={"id": "gen-QA", "model": "qa/test",
        "choices": [{"message": {"content": "<<TP_P0:สวัสดี>>"}, "finish_reason": "stop"}],
        "usage": {"cost": "0.000123456789123", "prompt_tokens": 1000, "completion_tokens": 50,
        "total_tokens": 1050, "prompt_tokens_details": {"cached_tokens": 900}},
        "charged_tp": "102", "balance_tp": "49898"})
    result = cloud_paid.ADAPTER.generate(boundary["request"])
    assert result.usage_details["providerCostUsd"] == "0.000123456789123"
    assert result.usage_details["cachedInputTokens"] == 900
    assert result.usage_details["billingAuthority"] == "center_paid"
    assert result.usage_details["chargedTp"] == "102" and result.usage_details["balanceTp"] == "49898"
    assert boundary["request"].system_text == "Exact custom prompt"
    assert boundary["request"].thinking == "minimum"
    outgoing = boundary["posts"][0][1]
    assert outgoing["messages"][0]["content"] == "Exact custom prompt"
    assert outgoing["thinking"] == "minimum" and "reasoning" not in outgoing
    assert boundary["dispatched"] == [True] and len(boundary["posts"]) == 1


@pytest.mark.parametrize("parameters, include", [
    (["max_tokens"], False), (["max_tokens", "temperature"], True), (None, True),
])
def test_default_sampling_is_not_sent_when_metadata_proves_unsupported(boundary, parameters, include):
    boundary["response"] = httpx.Response(200, json={"id": "gen-QA", "model": "qa/test",
        "choices": [{"message": {"content": "<<TP_P0:สวัสดี>>"}}],
        "usage": {"cost": "0.00001", "prompt_tokens": 30, "completion_tokens": 10},
        "charged_tp": "9", "balance_tp": "9991"})
    caps = dict(boundary["request"].model_capabilities)
    if parameters is not None: caps["supported_parameters"] = parameters
    req = replace(boundary["request"], model_capabilities=caps)
    cloud_paid.ADAPTER.generate(req)
    outgoing = boundary["posts"][0][1]
    assert ("temperature" in outgoing) is include
    assert req.thinking == "minimum" and req.system_text == "Exact custom prompt"
