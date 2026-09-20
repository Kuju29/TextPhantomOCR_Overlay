"""No external provider: real ASGI streaming ownership and protocol boundaries."""
import asyncio
import json
import sys
import unittest
from pathlib import Path
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from fastapi import HTTPException, FastAPI
import httpx
from starlette.requests import Request
from backend.ai import content_stream
from backend.ai.clients.base import ProviderGenerationCancelled
from backend.application.ai_translation.streaming import respond
from backend.application.ai_translation.provider_execution import _admission_slot


def request():
    messages = asyncio.Queue()
    scope = {'type':'http', 'method':'POST', 'path':'/translate', 'headers':[], 'asgi':{'spec_version':'2.3'}}
    return Request(scope, messages.get), messages

class StreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_delta_precedes_final_and_preserves_usage(self):
        req, _ = request()
        release = asyncio.Event()
        calls = []
        async def invoke(**kwargs):
            calls.append(1)
            await asyncio.to_thread(content_stream.emit, '<<I1_P0:แปลแล้ว>>')
            await release.wait()
            return {'schema':'tp.ai.result/1','translations':[{'id':'P0','text':'แปลแล้ว'}], 'meta':{'usage':{'inputTokens':19,'outputTokens':7,'cachedInputTokens':12}}}
        response = await asyncio.wait_for(respond(req, invoke), 1)
        iterator = response.body_iterator
        first = json.loads(await anext(iterator))
        self.assertEqual(first['type'], 'delta')
        self.assertEqual(first['sequence'], 1)
        self.assertFalse(release.is_set())
        release.set()
        terminal = json.loads(await anext(iterator))
        self.assertEqual(terminal['body']['meta']['usage']['cachedInputTokens'], 12)
        self.assertEqual(terminal['sequence'], 2)
        with self.assertRaises(StopAsyncIteration): await anext(iterator)
        self.assertEqual(calls, [1])

    async def test_precontent_errors_keep_http_status(self):
        req, _ = request()
        async def invoke(**kwargs): raise HTTPException(409, detail={'code':'test_conflict'})
        with self.assertRaises(HTTPException) as raised: await respond(req, invoke)
        self.assertEqual(raised.exception.status_code,409)

    async def test_terminal_error_is_typed(self):
        req, _ = request()
        async def invoke(**kwargs):
            await asyncio.to_thread(content_stream.emit,'<<I1_P0:valid>>')
            raise HTTPException(502,detail={'code':'upstream_failure','generationAttempts':1,'usage':{'outputTokens':4}})
        response = await respond(req, invoke)
        events = [json.loads(line) async for line in response.body_iterator]
        self.assertEqual([row['type'] for row in events], ['delta','error'])
        self.assertEqual(events[-1]['status'],502)
        self.assertEqual(events[-1]['body']['detail']['usage']['outputTokens'],4)

    async def test_no_deltas_still_yields_result(self):
        req, _ = request()
        async def invoke(**kwargs): return {'schema':'tp.ai.result/1','replayed':True,'translations':[]}
        response = await respond(req, invoke)
        rows = [json.loads(line) async for line in response.body_iterator]
        self.assertEqual(len(rows),1)
        self.assertTrue(rows[0]['body']['replayed'])

    async def test_disconnect_unblocks_bounded_producer(self):
        req, messages = request()
        finished = asyncio.Event()
        delivered = asyncio.Event()
        async def invoke(**kwargs):
            try:
                def generate():
                    for _ in range(10000): content_stream.emit('x')
                await asyncio.to_thread(generate)
                return {}
            finally: finished.set()
        response = await respond(req, invoke)
        async def send(message):
            if message['type']=='http.response.body':
                delivered.set()
                await messages.put({'type':'http.disconnect'})
                await asyncio.sleep(0.02)
        await asyncio.wait_for(response(req.scope, req.receive, send), 1)
        await asyncio.wait_for(finished.wait(), 1)
        self.assertTrue(delivered.is_set())

    async def test_disconnect_before_first_content(self):
        req, messages = request()
        finished = asyncio.Event()
        async def invoke(*,cancel_check):
            while not cancel_check(): await asyncio.sleep(0.001)
            finished.set()
            return {}
        task=asyncio.create_task(respond(req,invoke))
        await messages.put({'type':'http.disconnect'})
        with self.assertRaises(asyncio.CancelledError): await task
        await asyncio.wait_for(finished.wait(),1)

    async def test_admission_cancel_removes_waiter_without_entering(self):
        cancel=asyncio.Event(); entered=asyncio.Event(); exited=[]
        class Gate:
            @asynccontextmanager
            async def slot(self, owner):
                entered.set()
                try: await asyncio.Future()
                finally: exited.append(owner)
                yield
        async def acquire():
            with content_stream.scope(lambda text:None,cancel):
                async with _admission_slot(Gate(),'owner'): self.fail('cancelled request admitted')
        task=asyncio.create_task(acquire())
        await entered.wait(); cancel.set()
        with self.assertRaises(ProviderGenerationCancelled): await task
        self.assertEqual(exited,['owner'])

    async def test_admitted_owner_stays_until_work_finishes_after_disconnect(self):
        cancel=asyncio.Event(); work=asyncio.Event(); admitted=asyncio.Event(); exited=[]
        class Gate:
            @asynccontextmanager
            async def slot(self, owner):
                try: yield
                finally: exited.append(owner)
        async def execute():
            with content_stream.scope(lambda text:None,cancel):
                async with _admission_slot(Gate(),'owner'):
                    admitted.set()
                    await work.wait()
        task=asyncio.create_task(execute())
        await admitted.wait();cancel.set();await asyncio.sleep(0)
        self.assertEqual(exited,[])
        work.set();await task;self.assertEqual(exited,['owner'])

    async def test_rate_gate_receives_disconnect_check(self):
        from backend.application.ai_translation import rate_admission
        observed=[]
        async def acquire(*args,**kwargs): observed.append(kwargs['cancel_check']())
        with patch.object(rate_admission.rate_gate,'snapshot',return_value={}), patch.object(rate_admission.rate_gate,'acquire',side_effect=acquire):
            await rate_admission.acquire(rate={'enabled':True,'rpm':10,'burst':1},unlimited=False,provider='test',config=SimpleNamespace(model='test',api_key=''),context={},payload={},idempotency_key=None,cancel_check=lambda:True)
        self.assertEqual(observed,[True])


    async def test_public_route_negotiates_conversation_only_and_retains_json(self):
        from backend.api.routes import ai_v1
        app=FastAPI();app.include_router(ai_v1.router)
        async def execute(request,payload,idempotency_key,**kwargs):
            if content_stream.active():
                await asyncio.to_thread(content_stream.emit,'<<I1_P0:translated>>')
            return {'schema':'tp.ai.result/1','translations':[],'meta':{'usage':{'outputTokens':2}}}
        with patch.object(ai_v1,'execute',side_effect=execute):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
                for mode,accept,streamed in [('conversation','application/x-ndjson',True),('independent','application/x-ndjson',False),('conversation','application/json',False)]:
                    result=await client.post('/v2/engine/runsextension/ai/translate',json={'translationMode':mode},headers={'Accept':accept})
                    self.assertEqual(result.status_code,200)
                    self.assertEqual('application/x-ndjson' in result.headers['content-type'],streamed)
                    if streamed:
                        rows=[json.loads(line) for line in result.text.splitlines()]
                        self.assertEqual([row['type'] for row in rows],['delta','result'])
                    else:self.assertEqual(result.json()['schema'],'tp.ai.result/1')


if __name__=='__main__': unittest.main()
