"""Offline forward acceptance checks;20 fails runtime-isolation cases intentionally.
No source changes. Native transport and PaidAdapter consume deterministic HTTP.
"""
from contextlib import contextmanager
import errno
import json
from pathlib import Path
import sys

import httpx
import pytest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'api'))
from backend import diagnostic_retention as retention
from backend.ai import wire_trace
from backend.ai.transports.openai_chat import execute_chat_completion
from backend.ai.providers import cloud_paid
from backend.ai.provider_contract import GenerationRequest


def windows_denial():
    error=PermissionError(errno.EACCES,'synthetic held reader target')
    error.winerror=5
    return error


@pytest.fixture
def capture(monkeypatch,tmp_path):
    monkeypatch.setenv('TP_AI_WIRE_TRACE','1')
    monkeypatch.setenv('TP_AI_WIRE_TRACE_DIR',str(tmp_path/'wire'))
    token=wire_trace.begin({'traceId':'trace-isolation-QA','operationId':'op-isolation-QA'})
    folder=wire_trace.active_folder()
    yield folder
    wire_trace.end(token)
    for item in list(wire_trace._relay_folders):wire_trace.finish_in(item)


def test_windows_counter_target_denies_rename_but_allows_regular_write(monkeypatch,tmp_path):
    root=tmp_path/'counter';root.mkdir()
    with retention.guard(root,'wire'):
        retention.store_usage(root,'wire',4096,1,checked_at=100)
    held=(root/'_wire-retention.json').open('r',encoding='utf8')
    original=retention.os.replace
    def blocked(source,destination,*a,**kw):
        if str(destination).endswith('_wire-retention.json'):raise windows_denial()
        return original(source,destination,*a,**kw)
    monkeypatch.setattr(retention.os,'replace',blocked)
    try:
        with retention.guard(root,'wire'):
            retention.store_usage(root,'wire',8192,2,checked_at=101)
        # Same inode can remain open. Both new and old reader observe new state.
        data=json.loads((root/'_wire-retention.json').read_text())
        assert data['bytes']==8192 and data['files']==2
        held.seek(0);assert json.loads(held.read())==data
        assert not list(root.glob('*.tmp'))
    finally:held.close()


def test_native_stream_drains_usage_when_trace_metadata_is_unwritable(monkeypatch,capture):
    writes=wire_trace._write_bytes_locked
    def fail_response_metadata(folder,name,body,**kwargs):
        if name.startswith('05_provider_response'):
            raise windows_denial()
        return writes(folder,name,body,**kwargs)
    monkeypatch.setattr(wire_trace,'_write_bytes_locked',fail_response_metadata)
    events=[]
    lines=[
        'data: '+json.dumps({'id':'QA-generation','model':'QA-model','choices':[{'delta':{'content':'<<TP_P0:คำแปล>>'}}]}),
        'data: '+json.dumps({'choices':[{'delta':{},'finish_reason':'stop'}],
            'usage':{'prompt_tokens':1000,'completion_tokens':50,'total_tokens':1050,
                'prompt_tokens_details':{'cached_tokens':900},'cost':'0.000123456789123'}}),
        'data: [DONE]',
    ]
    class Reply:
        is_success=True;status_code=200;headers={}
        def close(self):pass
        def read(self):return b""
        def raise_for_status(self):pass
        def iter_lines(self):
            for line in lines:
                events.append(line.split(':',1)[1].strip()=='[DONE]')
                yield line
    class Client:
        _textphantom_streaming=True
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*a):pass
        @contextmanager
        def stream(self,*a,**kw):yield Reply()
    monkeypatch.setattr(httpx,'Client',Client)
    result=execute_chat_completion(url='https://openrouter.ai/api/v1/chat/completions',
        headers={'Authorization':'Bearer synthetic-only'},payload={'messages':[]},model='QA-model',
        provider_id='openrouter',timeout=5,timeout_policy='QA',expected_ids=['P0'])
    assert result.text=='<<TP_P0:คำแปล>>'
    assert result.terminal_completed and any(events)
    assert (result.input_tokens,result.output_tokens,result.total_tokens)==(1000,50,1050)
    assert result.usage_details['cachedInputTokens']==900
    assert str(result.usage_details['providerCostUsd'])=='0.000123456789123'
    assert wire_trace.active_folder() in (capture,None)
    # Privacy invariant survives degradation; upstream raw body never persisted.
    raw=capture/'05_provider_response.raw'
    assert 'synthetic-only' not in raw.read_text() and 'QA-generation' not in raw.read_text()


def test_paid_receipt_survives_counter_storage_failure(monkeypatch,capture):
    posts=[];dispatched=[]
    monkeypatch.setattr(cloud_paid,'center_base_url',lambda:'https://center.example')
    monkeypatch.setattr(cloud_paid,'center_origin',lambda:'https://center.example')
    monkeypatch.setattr(cloud_paid.accounting,'mark_dispatched',lambda:dispatched.append(True))
    monkeypatch.setattr(retention,'store_usage',lambda *a,**kw:(_ for _ in ()).throw(windows_denial()))
    class Client:
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*a):pass
        def post(self,url,*,json,headers):
            posts.append(json)
            return httpx.Response(200,json={'id':'QA-generation','model':'QA-model',
                'choices':[{'message':{'content':'<<TP_P0:คำแปล>>'},'finish_reason':'stop'}],
                'usage':{'cost':'0.000123456789123','prompt_tokens':1000,'completion_tokens':50,
                    'total_tokens':1050,'prompt_tokens_details':{'cached_tokens':900}},
                'charged_tp':'102','balance_tp':'49898'})
    monkeypatch.setattr(httpx,'Client',Client)
    req=GenerationRequest(provider='paid',model='QA-model',api_key='synthetic-customer-only',
        system_text='Exact custom prompt',user_parts=('<<TP_P0:Hello>>',),thinking='minimum',
        cache_context={'operationId':'request-QA','thinkingRequested':'minimum'},
        model_capabilities={'reasoning':{'supported':False},'limits':{'maxOutputTokens':8192}})
    result=cloud_paid.ADAPTER.generate(req)
    assert len(posts)==1 and dispatched==[True]
    assert result.text=='<<TP_P0:คำแปล>>'
    usage=result.usage_details
    assert usage['providerCostUsd']=='0.000123456789123' and usage['cachedInputTokens']==900
    assert usage['billingAuthority']=='center_paid'
    assert usage['chargedTp']=='102' and usage['balanceTp']=='49898'
    assert req.system_text=='Exact custom prompt' and req.thinking=='minimum'
    for p in capture.glob('*'):
        if p.is_file():assert 'synthetic-customer-only' not in p.read_text(errors='replace')


@pytest.mark.parametrize('link',['symlink','hardlink'])
def test_counter_fallback_never_modifies_outside_link(monkeypatch,tmp_path,link):
    root=tmp_path/'counter';root.mkdir()
    outside=tmp_path/'protected.json';outside.write_text('{"protected":true}')
    state=root/'_wire-retention.json'
    if link=='symlink':state.symlink_to(outside)
    else:retention.os.link(outside,state)
    monkeypatch.setattr(retention.os,'replace',lambda *a,**kw:(_ for _ in ()).throw(windows_denial()))
    with pytest.raises(OSError):
        with retention.guard(root,'wire'):
            retention.store_usage(root,'wire',8192,2,checked_at=101)
    assert outside.read_text()=='{"protected":true}'
    assert not list(root.glob('*.tmp'))


def test_strict_storage_never_writes_content_without_counter_reservation(monkeypatch,capture):
    before=wire_trace._scan_usage(capture.parent)
    monkeypatch.setattr(retention,'store_usage',lambda *a,**kw:(_ for _ in ()).throw(windows_denial()))
    with pytest.raises(OSError):
        wire_trace._write_bytes_locked(capture,'02_system_prompt.txt','synthetic newcontent')
    assert not (capture/'02_system_prompt.txt').exists()
    assert wire_trace._scan_usage(capture.parent)==before


def test_direct_local_relay_storage_fault_releases_abandoned_lease(monkeypatch,tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from backend.api.routes import local_wire_trace as relay_route
    from backend.ai import local_wire_relay
    monkeypatch.setenv('TP_AI_WIRE_TRACE','1')
    monkeypatch.setenv('TP_AI_WIRE_TRACE_DIR',str(tmp_path/'wire'))
    app=FastAPI();app.include_router(relay_route.router)
    identity={'executionKey':'QA-relay','operationId':'QA-relay','traceId':'QA-relay',
        'jobId':'','batchId':'','imageId':''}
    headers={'X-TP-AI-Wire-Capability':local_wire_relay.CAPABILITY_TOKEN,
        **{h:identity[k] for h,k in [('X-TP-Trace-Id','traceId'),('X-TP-Request-Id','operationId'),
            ('X-TP-Job-Id','jobId'),('X-TP-Batch-Id','batchId'),('X-TP-Image-Id','imageId')]}}
    try:
        with TestClient(app) as client:
            start=client.post('/v2/engine/runsextension/ai/local-wire-trace',
                json={'identity':identity,'stage':'trace_started'},headers=headers)
            assert start.status_code==202
            folder=next((tmp_path/'wire').glob('img-*'))
            assert folder in wire_trace._relay_folders
            writes=wire_trace._write_bytes_locked
            def fail_content(folder,name,body,**kw):
                if name=='02_system_prompt.txt':raise windows_denial()
                return writes(folder,name,body,**kw)
            monkeypatch.setattr(wire_trace,'_write_bytes_locked',fail_content)
            failed=client.post('/v2/engine/runsextension/ai/local-wire-trace',
                json={'identity':identity,'stage':'systemPrompt','value':'synthetic exact'},headers=headers)
            assert failed.status_code==202 and failed.json()['recorded'] is False
            assert str(folder) not in local_wire_relay._operation_sizes
            assert folder not in wire_trace._relay_folders
            assert folder not in wire_trace._folder_leases
            assert not list(folder.parent.glob('_wire-active-*.lock'))
    finally:
        for folder in list(wire_trace._relay_folders):wire_trace.finish_in(folder)


def test_primary_provider_http_failure_survives_diagnostic_fault(monkeypatch,capture):
    from backend.ai.clients.provider_error import ProviderHttpError
    writes=wire_trace._write_bytes_locked
    def fail_metadata(folder,name,body,**kwargs):
        if name.startswith('05_provider_response'):raise windows_denial()
        return writes(folder,name,body,**kwargs)
    monkeypatch.setattr(wire_trace,'_write_bytes_locked',fail_metadata)
    class Client:
        _textphantom_streaming=True
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*a):pass
        @contextmanager
        def stream(self,*a,**kw):
            yield httpx.Response(404,json={'error':{'code':'model_not_found','message':'Synthetic unavailable'}},
                request=httpx.Request('POST','https://openrouter.ai/api/v1/chat/completions'))
    monkeypatch.setattr(httpx,'Client',Client)
    with pytest.raises(ProviderHttpError) as caught:
        execute_chat_completion(url='https://openrouter.ai/api/v1/chat/completions',headers={},
            payload={'messages':[]},model='QA-model',provider_id='openrouter',timeout=5,
            timeout_policy='QA',expected_ids=['P0'])
    assert caught.value.status==404
    assert caught.value.provider=='openrouter' and caught.value.model=='QA-model'


def test_nested_ingress_worker_degradation_balances_leases(monkeypatch,capture):
    child=wire_trace.resume(capture)
    assert wire_trace._folder_leases[capture][1]==2
    writes=wire_trace._write_bytes_locked
    def fail_metadata(folder,name,body,**kwargs):
        if name=='09_timing.json':raise windows_denial()
        return writes(folder,name,body,**kwargs)
    monkeypatch.setattr(wire_trace,'_write_bytes_locked',fail_metadata)
    try:
        wire_trace.write_json('09_timing.json',{'providerMs':1})
        assert wire_trace.active_folder() is None
        assert wire_trace._folder_leases[capture][1]==1
    finally:
        wire_trace.end(child)
    assert wire_trace.active_folder()==capture
    assert wire_trace._folder_leases[capture][1]==1
