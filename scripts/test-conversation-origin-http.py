"""Real OCR g IDs -> JS ready planner/transport -> HTTP API -> HF adapter -> SSE.

The model endpoint is loopback fixture output. No cloud service is called. Unlike
14.10 tests this enters the public request validator, not provider_execution alone.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
import httpx
import uvicorn
from fastapi import FastAPI
from backend.api.routes.ai_v1 import router
from backend.jobs.admission import AdmissionGate
from backend import trace

calls = []
release = threading.Event()
lock = threading.Lock()
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        last = payload['messages'][-1]['content']
        ids = [a or b for a,b in re.findall(r'<<(?:TP_(P[0-9]+)|(I[1-9][0-9]{0,6}_P[0-9]{1,6})):', last)]
        assert ids, ids
        with lock:
            index = len(calls)
            calls.append({'payload':payload,'ids':ids})
        if 'SLOW_SOURCE' in last:
            assert release.wait(15), 'fixture release timeout'
        answer = '\r\n'.join((f'<<{uid}:คำแปล{i}>>' if uid.startswith('I') else f'<<TP_{uid}:คำแปล{i}>>') for i,uid in enumerate(ids)) + '\n'
        usage = {'prompt_tokens':1000,'completion_tokens':len(ids)*10,'total_tokens':1000+len(ids)*10,
                 'prompt_tokens_details':{'cached_tokens':0},'completion_tokens_details':{'reasoning_tokens':0}}
        rows = [{'id':f'origin-http-{index}','model':payload['model'],
                 'choices':[{'index':0,'delta':{'content':answer},'finish_reason':None}]},
                {'id':f'origin-http-{index}','model':payload['model'],
                 'choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':usage}]
        body = (''.join('data: '+json.dumps(r,ensure_ascii=False)+'\n\n' for r in rows)+'data: [DONE]\n\n').encode()
        self.send_response(200);self.send_header('Content-Type','text/event-stream')
        self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

provider = ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=provider.serve_forever,daemon=True).start()
RealClient = httpx.Client
class LoopbackClient:
    _textphantom_streaming = True
    def __init__(self,*a,**kw): self.client = RealClient(timeout=20,trust_env=False)
    def __enter__(self): return self
    def __exit__(self,*a): self.client.close()
    def stream(self,method,url,**kw):
        assert str(url).startswith('https://router.huggingface.co/'), url
        return self.client.stream(method,f'http://127.0.0.1:{provider.server_port}/chat',**kw)

try:
    with tempfile.TemporaryDirectory() as temp, ThreadPoolExecutor(max_workers=4) as executor, patch.dict(os.environ, {
        'TP_CONVERSATION_STATE_FILE':temp+'/state.sqlite', 'TP_AI_WIRE_TRACE':'1',
        'TP_AI_WIRE_TRACE_DIR':temp+'/wire', 'TP_USAGE_RECEIPTS':'off',
        'TP_TRACE':'compact','TP_TRACE_DIR':temp+'/trace','TP_TRACE_CONTENT':'0',
        'TP_PROMPT_CACHE_COORDINATION':'off',
    }), patch.object(httpx,'Client',LoopbackClient), patch('backend.ai.provider_resolution.discovered_model_capabilities',return_value=(False,{})):
        trace.start_session()
        app = FastAPI();app.include_router(router)
        app.state.ai_admission_gate=AdmissionGate(4,max_waiters=16,max_wait_sec=3)
        app.state.ai_executor=executor
        @app.get('/fixture/state')
        async def state():
            with lock: return {'calls':len(calls),'units':[len(c['ids']) for c in calls],
                               'messages':[len(c['payload']['messages']) for c in calls]}
        @app.post('/fixture/release')
        async def unblock(): release.set();return {'ok':True}
        sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen(128)
        base=f'http://127.0.0.1:{sock.getsockname()[1]}'
        server=uvicorn.Server(uvicorn.Config(app,log_level='error',access_log=False))
        thread=threading.Thread(target=lambda:server.run(sockets=[sock]),daemon=True);thread.start()
        try:
            until=time.monotonic()+8
            while not server.started and time.monotonic()<until: time.sleep(.01)
            assert server.started
            child=subprocess.run(['node','scripts/test-conversation-origin-contract.mjs','--http',base],cwd=ROOT,
                                 capture_output=True,text=True,timeout=55)
            assert child.returncode==0, child.stdout+'\n'+child.stderr
            print(child.stdout.strip())
            # Independent retains original IDs and does not access history.
            async def extra_checks():
                payload={'schema':'tp.ai.request/1','translationMode':'independent','units':[{'id':'g9','text':'Independent source'}],
                         'sourceLang':'en','targetLang':'th','provider':{'id':'huggingface','model':'fixture','apiKey':'PRIVATE_TEST_KEY',
                         'baseUrl':'https://router.huggingface.co/v1','thinking':'off'},
                         'memory':{'mode':'off','styleExamples':True},'repair':{'owner':'extension','enabled':False}}
                async with httpx.AsyncClient(base_url=base,trust_env=False) as client:
                    r=await client.post('/v2/engine/runsextension/ai/translate',json=payload)
                    assert r.status_code==200,r.text
                    assert r.json()['translations'][0]['id']=='g9',r.text
                    assert len(calls[-1]['payload']['messages'])==2
                    before=len(calls)
                    # Origin coverage/order must be checked before admission/provider.
                    for mapping in ([{'pageId':'p','unitIds':['P1'],'originalIds':['g0']}],
                                    [{'pageId':'p','unitIds':['P0','P1'],'originalIds':['g0','g1']}],
                                    [{'pageId':'p','unitIds':['P0'],'originalIds':['g0']},{'pageId':'q','unitIds':['P0'],'originalIds':['g1']}]):
                        bad={**payload,'translationMode':'conversation','units':[{'id':'P0','text':'must not dispatch'}],
                             'conversation':{'documentId':'bad','origins':mapping}}
                        response=await client.post('/v2/engine/runsextension/ai/translate',json=bad)
                        assert response.status_code==400,response.text
                        d=response.json()['detail'];assert d['code']=='ai_conversation_origin_invalid' and d['stage']=='conversation_mapping',d
                        assert d['providerAttempts']==d['generationAttempts']==0 and d['requestDispatched'] is False
                        assert d['providerHttpStatuses']==[] and 'upstreamStatus' not in d
                    assert len(calls)==before
            asyncio.run(extra_checks())
            requests=[];rejections=[]
            for folder in Path(temp,'wire').iterdir():
                if not folder.is_dir(): continue
                terminal=json.loads((folder/'11_terminal.json').read_text())
                if terminal.get('state')=='failed':
                    assert terminal['code']=='ai_conversation_origin_invalid',terminal
                    assert terminal['requestDispatched'] is False and terminal['providerAttempts']==0
                    d=json.loads((folder/'01_conversation_origin_validation.json').read_text())
                    assert d['status']=='rejected' and d['validation']['field'].startswith('conversation.origins')
                    assert 'PRIVATE_REJECTED_VALUE' not in '\n'.join(f.read_text() for f in folder.iterdir() if f.is_file())
                    rejections.append(d)
                elif (folder/'03_conversation_messages.json').exists():
                    origins=json.loads((folder/'03_conversation_messages.json').read_text())['currentOrigins']
                    for origin in origins:
                        assert origin['originalIds']==['g0','g1'],origin
                    prepared=json.loads((folder/'01_conversation_origin_validation.json').read_text());assert prepared['status']=='accepted'
                    requests.append(json.loads((folder/'04_provider_request.json').read_text())['body'])
            assert len(requests)==3 and len(rejections)==4,(len(requests),len(rejections))
            for entry in calls:
                assert 'PRIVATE_TEST_KEY' not in json.dumps(entry['payload'])
            print('PASS public HTTP origin validation, 3 append-only cross-page requests, 4 invalid maps before dispatch, Independent g9, typed wire failure and zero phantom provider calls')
        finally:
            release.set();server.should_exit=True;thread.join(8);sock.close()
finally:
    release.set();provider.shutdown();provider.server_close()
