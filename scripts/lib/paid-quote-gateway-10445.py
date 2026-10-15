"""QA subprocess: real Gateway routes/adapter, isolated from Center's namespace.

All bearer/quote values travel only over the parent's anonymous pipes. The
parent binds a read-only synthetic HTTP fixture on 127.0.0.1, never a live app.
No provider key or external service is accessed by this process.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import json
import os
import sys

initial=json.loads(sys.stdin.readline())
os.environ['TP_CENTER_URL']=initial['base']
os.environ['TP_AI_WIRE_TRACE']='0'
os.environ['TP_LOG_LEVEL']='ERROR'
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'api'))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.ai.provider_bootstrap import ensure_provider_registry
ensure_provider_registry()
from backend.api.routes import ai_v1, paid, repair_runs
from backend.application import idempotency
from backend.ai.translation_paths import store as conversations
from backend.ai import accounting

app=FastAPI()
for router in (paid.router,ai_v1.router,repair_runs.router):app.include_router(router)
class Gate:
    @asynccontextmanager
    async def slot(self,_):yield
app.state.ai_admission_gate=Gate()
executor=ThreadPoolExecutor(max_workers=2)
app.state.ai_executor=executor

def emit(value):
    print('QA45:'+json.dumps(value,ensure_ascii=True),flush=True)

with TestClient(app,raise_server_exceptions=False,headers={
    'Authorization':initial['authorization'],'X-TP-Run-Token':'c'*64,
    'X-TP-Tab-Session':'owned-paid-click-10445'}) as client:
    emit({'ready':True})
    for line in sys.stdin:
        data=json.loads(line)
        if data.get('cmd')=='stop':break
        if data.get('cmd')=='reset':
            idempotency.clear();conversations._stores.clear()
            emit({'reset':True});continue
        if data.get('cmd')=='receipt_count':
            with accounting._schema_lock:
                emit({'receipt_count':len(accounting._receipt_cache)})
            continue
        response=client.request(data.get('method','POST'),data['path'],json=data.get('json'),
            headers=data.get('headers') or {})
        try:body=response.json()
        except ValueError:body={'error':{'code':'non_json_response'}}
        emit({'http':response.status_code,'body':body})
executor.shutdown(wait=True)
