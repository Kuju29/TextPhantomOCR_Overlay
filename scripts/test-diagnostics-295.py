"""Local-only boundary, logging ingestion, failures, and redaction checks."""
import sys
import json
from pathlib import Path
from unittest.mock import patch
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend import logfile,diagnostics
from backend.diagnostic_core import EventWriter,DiagnosticsMiddleware,scope
from backend.api.routes import logs,paid
from backend import paid_center

@pytest.fixture
def diag(tmp_path,monkeypatch):
    monkeypatch.setattr(logfile,'_ROOT',tmp_path/'logs')
    monkeypatch.setattr(logfile,'_ENABLED',True)
    monkeypatch.setattr(logfile,'_seen_ids',{})
    monkeypatch.setattr(logs,'_log_budget',[0.,0])
    writer=EventWriter(tmp_path/'logs',service='extension-api',release='qa')
    monkeypatch.setattr(diagnostics,'writer',writer)
    app=FastAPI();app.include_router(logs.router);app.include_router(paid.router)
    app.add_middleware(DiagnosticsMiddleware,writer=writer)
    with TestClient(app) as client:yield client,writer


def test_ingest_metadata_correlated_and_duplicate_ack(diag):
    client,w=diag
    record={'event':'paid.otp.submit','diagnostic':True,'run':'browser-run','n':1,'trace_id':'same-trace','outcome':'info','t':1}
    a=client.post('/v1/logs',json={'records':[record]});assert a.status_code==200
    b=client.post('/v1/logs',json={'records':[record]});assert b.status_code==200 and b.json()['duplicates']==1
    events=w.read_events(trace='same-trace')[0]
    assert len(events)==1 and events[0]['event']=='extension.paid.otp.submit'
    assert events[0]['source_trust']=='client_reported'
    assert 'http.request.started' not in [e['event'] for e in events]


def test_ingest_redacts_secrets_otp_content(diag):
    c,w=diag
    private='TEST-PRIVATE-CREDENTIAL-SENTINEL'
    r=c.post('/v1/logs',json={'records':[{'diagnostic':True,'event':'qa','run':'r','n':1,
        'password':private,'apiKey':private,'TP_CENTER_GATEWAY_KEY':private,'gatewayKey':private,
        'body':private,'otp_code':'123456','email':'user@example.com',
        'error':'Bearer '+private,'input_tokens':120,'code':'RATE_LIMITED'}]})
    assert r.status_code==200
    text='\n'.join(p.read_text() for p in w.directory.iterdir() if p.suffix in {'.log','.jsonl'})
    assert private not in text and '123456' not in text and 'user@example.com' not in text
    assert 'RATE_LIMITED' in text


@pytest.mark.parametrize('payload',[{'records':[{'x':'a'*17000}]},{'records':[{}]*501}, {'records':'bad'},[]])
def test_ingest_bounds(diag,payload):
    c,w=diag;r=c.post('/v1/logs',json=payload)
    assert r.status_code in (400,413)


def test_raw_body_cap_precedes_parse(diag):
    c,w=diag
    assert c.post('/v1/logs',content=b' '*140000).status_code==413
    assert c.post('/v1/logs',content=b'{bad').status_code==400


def test_disabled_is_explicit(diag,monkeypatch):
    c,w=diag;monkeypatch.setattr(logfile,'_ENABLED',False)
    r=c.post('/v1/logs',json={'records':[]})
    assert r.status_code==503 and 'diagnostic_logging_disabled' in r.text


def test_disk_failure_not_ack_and_retry_recover(diag,monkeypatch):
    c,w=diag;record={'event':'sample','diagnostic':True,'run':'same','n':42}
    with monkeypatch.context() as m:
        m.setattr(logfile,'write',lambda *a,**k:False)
        r=c.post('/v1/logs',json={'records':[record]})
        assert r.status_code==503 and 'diagnostic_write_failed' in r.text
    r=c.post('/v1/logs',json={'records':[record]})
    assert r.status_code==200 and r.json()['written']==1


def test_structured_failure_not_ack(diag,monkeypatch):
    c,w=diag;record={'event':'sample','diagnostic':True,'run':'same','n':99}
    with monkeypatch.context() as m:
        m.setattr(w,'emit',lambda *a,**k:False)
        r=c.post('/v1/logs',json={'records':[record]})
        assert r.status_code==503
    assert c.post('/v1/logs',json={'records':[record]}).json()['written']==1


def test_rate_budget_cannot_affect_other_routes(diag,monkeypatch):
    c,w=diag
    import time
    monkeypatch.setattr(logs,'_log_budget',[time.monotonic(),6000])
    assert c.post('/v1/logs',json={'records':[{}]}).status_code==429
    assert c.get('/v1/logs/where').status_code==200


def test_center_forward_propagates_trace_no_credentials_in_log(diag,monkeypatch):
    c,w=diag
    monkeypatch.setattr(paid_center,'center_base_url',lambda:'http://127.0.0.1:8787')
    monkeypatch.setattr(paid,'center_base_url',lambda:'http://127.0.0.1:8787')
    original=httpx.AsyncClient;seen=[]
    def responder(request):
        seen.append(request)
        return httpx.Response(200,json={'ok':True},headers={'X-Request-ID':'center-rid','X-TP-Trace-ID':'shared-trace'})
    def factory(**kwargs):return original(transport=httpx.MockTransport(responder),**kwargs)
    monkeypatch.setattr(paid_center.httpx,'AsyncClient',factory)
    r=c.post('/paid/auth/request',headers={'X-TP-Trace-ID':'shared-trace'},json={'email':'private@example.com'})
    assert r.status_code==200
    assert seen[0].headers['x-tp-trace-id']=='shared-trace'
    assert seen[0].headers['x-tp-request-id']==r.headers['x-request-id']
    events=w.read_events(trace='shared-trace')[0]
    assert any(e['event']=='center.request.completed' and e['data']['center_request_id']=='center-rid' for e in events)
    assert 'private@example.com' not in json.dumps(events)


def test_network_failure_records_class_before_503(diag,monkeypatch):
    c,w=diag
    monkeypatch.setattr(paid_center,'center_base_url',lambda:'http://127.0.0.1:8787')
    monkeypatch.setattr(paid,'center_base_url',lambda:'http://127.0.0.1:8787')
    original=httpx.AsyncClient
    def responder(request):raise httpx.ConnectError('private-sentinel')
    monkeypatch.setattr(paid_center.httpx,'AsyncClient',lambda **kwargs:original(transport=httpx.MockTransport(responder),**kwargs))
    r=c.get('/paid/auth/status',headers={'X-TP-Trace-ID':'offline-trace'})
    assert r.status_code==503
    events=w.read_events(trace='offline-trace')[0]
    assert any(e['event']=='center.request.failed' and e['data']['error_type']=='ConnectError' for e in events)
    assert 'private-sentinel' not in json.dumps(events)


def test_telemetry_write_fails_do_not_break_unrelated_request(diag,monkeypatch):
    c,w=diag
    monkeypatch.setattr(w,'emit',lambda *a,**k:False)
    assert c.get('/v1/logs/where').status_code==200


def test_executor_bind_context_isolated_between_concurrent_requests(diag):
    from concurrent.futures import ThreadPoolExecutor
    c,w=diag
    callbacks=[]
    for n in range(8):
        with scope(w,trace_id=f'parallel-{n}',request_id=f'request-{n}'):
            callbacks.append(diagnostics.bind_context(lambda:diagnostics.current()['trace_id']))
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(lambda fn:fn(),callbacks))==[f'parallel-{n}' for n in range(8)]


def test_exception_location_retains_backend_module_not_user_directory():
    namespace={}
    exec(compile('def bad():\n raise ValueError("private-message")','/home/private-operator/project/api/backend/customer/example.py','exec'),namespace)
    try: namespace['bad']()
    except ValueError as exc: result=diagnostics.fault(exc)
    assert result['frames'][-1]['file']=='backend/customer/example.py'
    assert 'private-operator' not in json.dumps(result) and 'private-message' not in json.dumps(result)
