"""Independent offline ASGI tests for public support relay routing and bytes."""
import json, os, sys, asyncio
from pathlib import Path
os.environ['TP_CENTER_URL']='https://center.example'
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.api.routes import paid

ORIGINAL=httpx.AsyncClient
requests=[]; cases=[]; next_response=None
def upstream(request):
    requests.append({'url':str(request.url),'method':request.method,'headers':dict(request.headers),'body':request.content})
    if request.url.path=='/api/customer/support':
        if request.headers.get('authorization')=='Bearer '+'z'*64:
            return httpx.Response(401,json={'error':{'code':'AUTH_REQUIRED','message':'Sign in'}},request=request)
        return httpx.Response(200,json={'enabled':True,'max_file_mb':20},request=request)
    return next_response(request) if callable(next_response) else next_response
def transport_client(*args,**kwargs):
    kwargs['transport']=httpx.MockTransport(upstream)
    return ORIGINAL(*args,**kwargs)
paid.httpx.AsyncClient=transport_client
app=FastAPI();app.include_router(paid.router)
client=TestClient(app,raise_server_exceptions=False)
TOKEN='Bearer '+'a'*64; ATT='att_'+'b'*32
def check(name,fn):
    try:fn();cases.append({'name':name,'passed':True})
    except Exception as exc:cases.append({'name':name,'passed':False,'error':str(exc)})
def response(status=200,content=b'private bytes',headers=None):
    global next_response
    next_response=lambda request:httpx.Response(status,content=content,headers=headers or {},request=request)

def binary_integrity():
    response(content=bytes([0,1,127,128,255]),headers={'Content-Type':'application/zip','Content-Disposition':'attachment; filename="test.zip"'})
    r=client.get('/paid/support/attachments/'+ATT,headers={'Authorization':TOKEN})
    assert r.status_code==200 and r.content==bytes([0,1,127,128,255])
    assert requests[-1]['headers']['authorization']==TOKEN
    assert r.headers['cache-control']=='no-store' and r.headers['x-content-type-options']=='nosniff'
    assert requests[-1]['url']=='https://center.example/api/customer/support/attachments/'+ATT
check('Authorized binary attachment retains bytes and private headers',binary_integrity)
def upload():
    response(content=json.dumps({'id':ATT}).encode(),headers={'Content-Type':'application/json'})
    r=client.post('/paid/support/attachments',headers={'Authorization':TOKEN,'X-Command-ID':'immutable-command','X-File-Name':'private%20file.zip'},content=b'PK\x00\xffbytes')
    assert r.status_code==200 and r.json()['id']==ATT
    assert requests[-1]['method']=='POST' and requests[-1]['body']==b'PK\x00\xffbytes'
    assert requests[-1]['headers']['x-command-id']=='immutable-command'
    assert requests[-1]['headers']['x-file-name']=='private%20file.zip'
    assert requests[-1]['headers']['origin']=='https://center.example'
check('Upload preserves bytes command filename and managed Center origin',upload)
def unauthorized():
    response(401,json.dumps({'error':{'code':'AUTH_REQUIRED','message':'Sign in'}}).encode(),{'Content-Type':'application/json'})
    r=client.get('/paid/support/attachments/'+ATT)
    assert r.status_code==401 and r.json()['error']['code']=='AUTH_REQUIRED'
check('Missing identity cannot read attachment',unauthorized)
def invalid_id():
    count=len(requests);r=client.get('/paid/support/attachments/att_bad',headers={'Authorization':TOKEN})
    assert r.status_code==404 and len(requests)==count
check('Malformed attachment ID rejected before upstream',invalid_id)
def oversized_upload():
    count=len(requests);r=client.post('/paid/support/attachments',headers={'Authorization':TOKEN},content=b'x'*(20*1024*1024+1))
    assert r.status_code==413 and len(requests)==count+1 and requests[-1]['url'].endswith('/api/customer/support')
check('Oversized upload rejected without provider dispatch',oversized_upload)
def oversized_response():
    response(content=b'x'*(20*1024*1024+1));r=client.get('/paid/support/attachments/'+ATT,headers={'Authorization':TOKEN})
    assert r.status_code==503
check('Oversized download response fails boundedly',oversized_response)
def redirect():
    response(302,b'',{'Location':'https://evil.example/private'});count=len(requests)
    r=client.get('/paid/support/attachments/'+ATT,headers={'Authorization':TOKEN})
    assert r.status_code==503 and len(requests)==count+1
check('Upstream attachment redirect not followed with credentials',redirect)
def malformed_json():
    response(500,b'not json',{'Content-Type':'application/json'});r=client.get('/paid/support/attachments/'+ATT,headers={'Authorization':TOKEN})
    assert r.status_code==503
check('Non-JSON upstream error becomes availability refusal',malformed_json)
def array_json():
    response(500,b'[]',{'Content-Type':'application/json'});r=client.get('/paid/support/attachments/'+ATT,headers={'Authorization':TOKEN})
    assert r.status_code==503, f'Invalid upstream array produced {r.status_code}'
check('JSON array error cannot crash customer payload sanitizer',array_json)
def null_upload():
    response(200,b'null',{'Content-Type':'application/json'});r=client.post('/paid/support/attachments',headers={'Authorization':TOKEN},content=b'PKbytes')
    assert r.status_code==503,f'Invalid upstream null upload produced {r.status_code}'
check('JSON null upload acknowledgement refused safely',null_upload)
def route_query():
    response(content=b'{"items":[],"has_more":false}',headers={'Content-Type':'application/json'})
    r=client.get('/paid/support/messages?after=9&before=40',headers={'Authorization':TOKEN})
    assert r.status_code==200
    assert requests[-1]['url']=='https://center.example/api/customer/support/messages?after=9&before=40'
check('History query forwards only bounded supported paging values',route_query)
def forged_before_body():
    from starlette.requests import Request
    async def read_forbidden():raise AssertionError('Forged session caused upload body consumption')
    scope={'type':'http','method':'POST','path':'/paid/support/attachments','headers':[(b'authorization',('Bearer '+'z'*64).encode())]}
    request=Request(scope,receive=read_forbidden);count=len(requests)
    result=asyncio.run(paid.support_binary('/api/customer/support/attachments',request,upload=True))
    assert result.status_code==401 and len(requests)==count+1
    assert requests[-1]['url'].endswith('/api/customer/support')
check('Syntactically valid forged bearer rejected before receiving upload bytes',forged_before_body)
def binary_slots():
    count=len(requests)
    for _ in range(4):assert paid._support_binary_slots.acquire(blocking=False)
    try:
        r=client.get('/paid/support/attachments/'+ATT,headers={'Authorization':TOKEN})
        assert r.status_code==429 and r.json()['error']['code']=='SUPPORT_BUSY' and r.headers['retry-after']=='5'
        assert len(requests)==count
    finally:
        for _ in range(4):paid._support_binary_slots.release()
check('Attachment saturation returns429 immediately before more upstream work',binary_slots)
def bounded_message():
    count=len(requests);r=client.post('/paid/support/messages',headers={'Authorization':TOKEN,'Content-Type':'application/json'},content=b'{"text":"'+b'x'*32768+b'"}')
    assert r.status_code==413 and len(requests)==count
    r=client.post('/paid/support/messages',headers={'Authorization':TOKEN},content=b'[]')
    assert r.status_code==422 and len(requests)==count
check('Oversized or nonobject message rejected before Center work',bounded_message)

summary={'checks':len(cases),'passed':sum(x['passed'] for x in cases),'results':cases}
print(json.dumps(summary,indent=2));raise SystemExit(0 if summary['passed']==summary['checks'] else 1)
