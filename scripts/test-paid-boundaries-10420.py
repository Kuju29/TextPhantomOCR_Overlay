"""Paid adapter outer Center404 vs structured upstream404 and admission proof."""
from pathlib import Path
import sys
import httpx
import pytest
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'api'))
sys.path.insert(0,str(ROOT/'scripts'/'lib'))
from paid_center_fake import HealthzClient, reset_protocol_cache
from backend.ai.providers import cloud_paid
from backend.ai.provider_contract import GenerationRequest
from backend.ai.clients.provider_error import ProviderHttpError
from backend.ai.failure_reason import provider_http_failure

@pytest.fixture
def adapter_env(monkeypatch):
    marks=[]
    monkeypatch.setattr(cloud_paid,'center_base_url',lambda:'http://127.0.0.1:8787')
    monkeypatch.setattr(cloud_paid,'center_origin',lambda:'http://127.0.0.1:8787')
    # The busy-admission wait queue is covered by test-paid-admission-wait-10466.py;
    # here one Center answer must surface at once so its evidence can be checked.
    monkeypatch.setattr(cloud_paid,'ADMISSION_WAIT_SECONDS',0)
    monkeypatch.setattr(cloud_paid.wire_trace,'provider_request',lambda **kw:None)
    monkeypatch.setattr(cloud_paid.wire_trace,'write_json',lambda *a,**kw:None)
    monkeypatch.setattr(cloud_paid.accounting,'mark_dispatched',lambda:marks.append(True))
    req=GenerationRequest(provider='paid',model='qa/test',api_key='synthetic-customer-session',system_text='QA',user_parts=('hello',),cache_context={'operationId':'synthetic-op','thinkingRequested':'minimum'},model_capabilities={'reasoning':{'supported':False}})
    return req,marks

def fail(adapter_env,monkeypatch,status,data):
    req,marks=adapter_env
    reset_protocol_cache()
    class Http(HealthzClient):  # also answers the Paid protocol health read
        def post(self,url,**kw):
            if url.endswith("/chat/receipt"): return httpx.Response(200, json={"found": False})
            if url.endswith("/price-quote"): return httpx.Response(200, json={"quote_token": "qa-fresh-quote"})
            assert url.endswith("/chat/completions")
            return httpx.Response(status,json=data)
    monkeypatch.setattr(cloud_paid.httpx,'Client',Http)
    with pytest.raises(ProviderHttpError) as captured:cloud_paid.ADAPTER.generate(req)
    return captured.value,marks


def test_upstream404_is_structured_and_preserved_separate_from_center502(adapter_env,monkeypatch):
    exc,marks=fail(adapter_env,monkeypatch,502,{'error':{'code':'PAID_PROVIDER_ROUTE','message':'Public-safe','details':{'upstream_http_status':404,'provider_error_category':'parameter_filter','credit_state':'released','provider_dispatched':True}}})
    assert exc.status==404 and exc.center_http_status==502
    f=provider_http_failure(exc)
    assert f.code=='paid_provider_route' and f.retryable is False
    assert marks==[True]


def test_unstructured_center404_does_not_invent_openrouter_route_error(adapter_env,monkeypatch):
    exc,marks=fail(adapter_env,monkeypatch,404,{'detail':'Not Found'})
    assert exc.status==404 and not hasattr(exc,'center_http_status')
    assert exc.provider_code!='PAID_PROVIDER_ROUTE'
    assert provider_http_failure(exc).code!='paid_provider_route'
    # .19 conservative unknown body cannot attest provider generation status.
    assert marks==[True]

@pytest.mark.parametrize('code,status',[('REASONING_INVALID',400),('CUSTOMER_ACCESS_UNAVAILABLE',409),('PAID_UNAVAILABLE',409),('VALIDATION_ERROR',422)])
def test_native_admission_invalid_controls_or_workspace_never_invent_dispatch(adapter_env,monkeypatch,code,status):
    exc,marks=fail(adapter_env,monkeypatch,status,{'error':{'code':code,'message':'Synthetic before generation'}})
    assert marks==[],code
    assert exc.centerAdmissionRejected is True
    assert exc.requestDispatched is False
    assert exc.providerAttempts==0 and exc.generationAttempts==0


def test_conflicting_dispatch_proof_wins_over_admission_code(adapter_env,monkeypatch):
    exc,marks=fail(adapter_env,monkeypatch,400,{'error':{'code':'REASONING_INVALID','message':'Synthetic','details':{'upstream_http_status':400,'provider_dispatched':True,'credit_state':'uncertain'}}})
    assert marks==[True] and not getattr(exc,'centerAdmissionRejected',False)
    assert exc.status==400 and exc.center_http_status==400
