"""Synthetic HTTP transport contract, no network."""
import sys,json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import pytest,httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend import paid_center,diagnostics
from backend.api.routes import paid
from backend.diagnostic_core import EventWriter,DiagnosticsMiddleware

@pytest.fixture
def lab(tmp_path,monkeypatch):
 w=EventWriter(tmp_path/'logs',service='extension-api',release='qa');monkeypatch.setattr(diagnostics,'writer',w)
 monkeypatch.setattr(paid_center,'center_base_url',lambda:'http://127.0.0.1:8787');monkeypatch.setattr(paid,'center_base_url',lambda:'http://127.0.0.1:8787')
 app=FastAPI();app.include_router(paid.router);app.add_middleware(DiagnosticsMiddleware,writer=w)
 original=httpx.AsyncClient
 def transport(fn):
  monkeypatch.setattr(paid_center.httpx,'AsyncClient',lambda **kwargs:original(transport=httpx.MockTransport(fn),**kwargs))
 return TestClient(app),w,transport

@pytest.mark.parametrize('body',[b'<html>Proxy error</html>',b'[]',b'null',b'123'])
def test_invalid_200_is_not_false_success(lab,body):
 c,w,transport=lab;transport(lambda req:httpx.Response(200,content=body,headers={'X-Request-ID':'center-invalid'}))
 r=c.post('/paid/auth/request',json={'email':'test@gmail.com'})
 assert r.status_code==502 and r.json()['error']['code']=='CENTER_RESPONSE_INVALID'
 assert r.headers['X-TP-Center-Request-ID']=='center-invalid'


def test_customer_receipt_distinguished_from_mail_send(lab):
 c,w,transport=lab;seen=[]
 def fn(req):
  seen.append(json.loads(req.content));return httpx.Response(200,json={'ok':True,'request_status':'received','delivery_status':'unconfirmed'},headers={'X-Request-ID':'cc-trace'})
 transport(fn)
 r=c.post('/paid/auth/request',json={'email':'test@gmail.com','device_id':'a'*32},headers={'X-TP-Trace-ID':'shared-receipt'})
 assert r.status_code==200 and r.headers['X-TP-Center-Request-ID']=='cc-trace'
 events=w.read_events(trace='shared-receipt')[0]
 event=next(x for x in events if x['event']=='center.request.completed')
 assert event['outcome']=='received' and event['data']['delivery_status']=='unconfirmed'
 assert 'test@gmail.com' not in json.dumps(events) and 'a'*32 not in json.dumps(events)
 assert seen[0]['device_id']=='a'*32


def test_overlapping_requests_do_not_mix_center_reference(lab):
 c,w,transport=lab
 def fn(req):
  n=json.loads(req.content)['device_id']
  return httpx.Response(200,json={'ok':True},headers={'X-Request-ID':n})
 transport(fn)
 def call(n):
  rid='rid_'+str(n)+'_'*32
  r=c.post('/paid/auth/request',json={'email':'test@gmail.com','device_id':rid})
  return r.headers.get('X-TP-Center-Request-ID')==rid
 with ThreadPoolExecutor(max_workers=5) as p:assert all(p.map(call,range(12)))
