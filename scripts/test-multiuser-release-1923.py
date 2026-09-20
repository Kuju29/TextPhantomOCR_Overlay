"""Offline real ASGI/Conversation/native-adapter isolation and capacity tests.

No paid/network provider calls: all native HTTP is an in-memory MockTransport.
The hold/release events intentionally simulate stalled native I/O, not users.
"""
from __future__ import annotations
import asyncio, copy, json, os, re, sys, tempfile, threading, time, unittest, uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import httpx
from fastapi import FastAPI
from starlette.requests import Request
from backend.api.routes import ai_v1
from backend.api.local_client import wants_unlimited
from backend.jobs.admission import AdmissionGate
from backend.application import idempotency
from backend.ai.providers import compose_providers
compose_providers()

class MultiuserTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.temp = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.stack.enter_context(patch.dict(os.environ, {
            'TP_CONVERSATION_STATE_FILE': self.temp+'/state', 'TP_USAGE_RECEIPTS':'off',
            'TP_AI_WIRE_TRACE':'0', 'TP_PROMPT_CACHE':'auto', 'TP_ALLOW_LOCAL_UNLIMITED':'0',
            'TP_AI_ENDPOINT_POLICY':'shared'}))
        self.stack.enter_context(patch('backend.ai.provider_resolution.discovered_model_capabilities', return_value=(False,{})))
        self.prefix = uuid.uuid4().hex
        self.calls=[]; self.call_lock=threading.Lock(); self.holds={}; self.entered={}
        self.active=0; self.max_active=0
        real_client=httpx.Client
        def isolated_client(*args, **kwargs):
            kwargs['transport']=httpx.MockTransport(self.native)
            return real_client(*args, **kwargs)
        self.stack.enter_context(patch.object(httpx, 'Client', side_effect=isolated_client))
        idempotency.clear()
        self.addCleanup(idempotency.clear)

    def native(self, request):
        assert request.method=='POST' and request.url.host=='openrouter.ai', 'unexpected external request'
        body=json.loads(request.content)
        last=body['messages'][-1]['content']
        m=re.search(r'SOURCE_USER_(\d+)_TURN_(\d+)', last)
        assert m, 'missing fixture identity'
        user,turn=map(int,m.groups())
        assert request.headers.get('authorization')==f'Bearer fixture-private-key-{user}'
        # Strong canaries: both source transcript and assistant transcript stay private.
        for message in body['messages']:
            for owner in re.findall(r'SOURCE_USER_(\d+)_TURN_', message['content']):
                assert int(owner)==user, 'other user source leaked into history'
            for owner in re.findall(r'คำแปลผู้ใช้ (\d+) รอบ', message['content']):
                assert int(owner)==user, 'other user translation leaked into history'
        with self.call_lock:
            self.calls.append({'user':user,'turn':turn,'body':copy.deepcopy(body)})
            self.active+=1; self.max_active=max(self.max_active,self.active)
        try:
            if (user,turn) in self.holds:
                self.entered[(user,turn)].set()
                assert self.holds[(user,turn)].wait(8), 'test failed to release synthetic stall'
            time.sleep(.008)  # synthetic I/O opportunity for competing requests
            text=f'<<TP_P0:คำแปลผู้ใช้ {user} รอบ {turn}>>'
            frames=[{'id':f'fixture-{user}-{turn}','choices':[{'delta':{'content':text},'finish_reason':None}]},
                {'choices':[{'delta':{},'finish_reason':'stop'}],
                 'usage':{'prompt_tokens':100,'completion_tokens':10,'total_tokens':110,
                    'prompt_tokens_details':{'cached_tokens':40 if turn else 0}}}]
            s=''.join('data: '+json.dumps(f,ensure_ascii=False)+'\n\n' for f in frames)+'data: [DONE]\n\n'
            return httpx.Response(200,headers={'content-type':'text/event-stream'},text=s,request=request)
        finally:
            with self.call_lock:self.active-=1

    def payload(self,user,turn,*,document='same-doc',owner=None):
        return {'operationId':f'{self.prefix}-shared-operation-{turn}', 'targetLang':'th','sourceLang':'en',
            'units':[{'id':'P0','text':f'SOURCE_USER_{user}_TURN_{turn}'}],
            'provider':{'id':'openrouter','model':'fixture-shared-model',
                'apiKey':f'fixture-private-key-{user}','baseUrl':'https://openrouter.ai/api/v1',
                'thinking':'off','modelCapabilities':{'limits':{'contextTokens':65536}}},
            'translationMode':'conversation','conversation':{'documentId':self.prefix+'-'+document},
            'context':{'tp_tab_session':owner or f'{self.prefix[:8]}-user-{user}'},
            'memory':{'mode':'off','styleExamples':False},'repair':{'owner':'extension'}}

    def app(self,slots=4,wait=3):
        app=FastAPI();app.include_router(ai_v1.router)
        pool=ThreadPoolExecutor(max_workers=slots)
        app.state.ai_executor=pool
        app.state.ai_admission_gate=AdmissionGate(slots,max_waiters=64,max_wait_sec=wait)
        return app,pool

    async def send(self,client,user,turn,**kw):
        data=self.payload(user,turn,**kw)
        return await client.post('/v2/engine/runsextension/ai/translate',json=data,
            headers={'Idempotency-Key':f'{self.prefix}-same-op-{turn}','Accept':'application/x-ndjson'})

    def body(self,response):
        self.assertEqual(response.status_code,200,response.text[:2000])
        rows=[json.loads(x) for x in response.text.splitlines() if x]
        self.assertEqual(rows[-1]['type'],'result',rows[-1])
        self.assertTrue(any(x['type']=='delta' for x in rows))
        return rows[-1]['body']

    def hold(self,user,turn):
        self.holds[(user,turn)]=threading.Event();self.entered[(user,turn)]=threading.Event()

    def test_24_keys_two_turns_same_document_and_operation_ids(self):
        async def run():
            app,pool=self.app()
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as c:
                    for turn in (0,1):
                        rs=await asyncio.gather(*(self.send(c,u,turn) for u in range(24)))
                        for u,r in enumerate(rs):
                            b=self.body(r); self.assertEqual(b['translations'][0]['text'],f'คำแปลผู้ใช้ {u} รอบ {turn}')
                            self.assertEqual(b['meta']['usage']['inputTokens'],100)
                    self.assertEqual(len(self.calls),48)
                    sessions={u:{x['body']['session_id'] for x in self.calls if x['user']==u} for u in range(24)}
                    self.assertTrue(all(len(v)==1 for v in sessions.values()))
                    self.assertEqual(len(set.union(*sessions.values())),24)
                    for u in range(24):
                        p=[x['body'] for x in self.calls if x['user']==u]
                        self.assertEqual([len(x['messages']) for x in p],[2,4])
                        self.assertEqual(p[1]['messages'][:2],p[0]['messages'])
                    self.assertLessEqual(self.max_active,4);self.assertGreater(self.max_active,1)
                    self.assertEqual(app.state.ai_admission_gate.stats().running,0)
                    print(json.dumps({'scenario':'24_accounts_2_turns','nativeRequests':48,'isolatedSessions':24,
                        'maxNativeConcurrent':self.max_active,'gateSlots':4,'crossAccountMismatch':0}))
            finally:pool.shutdown(wait=True)
        asyncio.run(run())

    def test_stalled_user_and_own_queued_turn_do_not_hold_other_user(self):
        self.hold(100,0)
        async def run():
            app,pool=self.app(slots=2)
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as c:
                    a=asyncio.create_task(self.send(c,100,0));self.assertTrue(await asyncio.to_thread(self.entered[(100,0)].wait,3))
                    next_a=asyncio.create_task(self.send(c,100,1))
                    b=await asyncio.wait_for(self.send(c,101,0),2)
                    self.body(b);self.assertFalse(a.done());self.assertFalse(next_a.done())
                    self.assertEqual(app.state.ai_admission_gate.stats().running,1)
                    self.holds[(100,0)].set()
                    for r in await asyncio.wait_for(asyncio.gather(a,next_a),3):self.body(r)
                    self.assertEqual(len(self.calls),3)
                    self.assertEqual(app.state.ai_admission_gate.stats().running,0)
                    print(json.dumps({'scenario':'held_A_queued_A2_B','B_finished_before_A_released':True,
                        'nativeRequests':3,'slots':2,'waitingSameHistoryConsumesSlot':False}))
            finally:
                self.holds[(100,0)].set();pool.shutdown(wait=True)
        asyncio.run(run())

    def test_same_owner_different_keys_cannot_replay_each_others_result(self):
        async def run():
            app,pool=self.app()
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as c:
                    r1,r2=await asyncio.gather(self.send(c,200,0,owner='same-owner'),self.send(c,201,0,owner='same-owner'))
                    self.assertEqual(self.body(r1)['translations'][0]['text'],'คำแปลผู้ใช้ 200 รอบ 0')
                    self.assertEqual(self.body(r2)['translations'][0]['text'],'คำแปลผู้ใช้ 201 รอบ 0')
                    r3=await self.send(c,200,0,owner='same-owner')
                    # Replay has no provisional delta, still terminal result with same private result.
                    last=json.loads(r3.text.splitlines()[-1]) if r3.headers.get('content-type','').startswith('application/x-ndjson') else {'body':r3.json()}
                    self.assertEqual(last['body']['translations'][0]['text'],'คำแปลผู้ใช้ 200 รอบ 0')
                    self.assertTrue(last['body']['replayed']);self.assertEqual(len(self.calls),2)
                    self.assertEqual(last['body']['meta']['providerAttempts'],0)
            finally:pool.shutdown(wait=True)
        asyncio.run(run())

    def test_saturated_shared_slots_reject_bounded_not_pretend_no_impact(self):
        self.hold(300,0);self.hold(300,1)
        async def run():
            app,pool=self.app(slots=2,wait=.12)
            tasks=[]
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as c:
                    # The first account borrows all free slots using independent documents.
                    for t in (0,1):
                        tasks.append(asyncio.create_task(self.send(c,300,t,document=f'doc-{t}')))
                        self.assertTrue(await asyncio.to_thread(self.entered[(300,t)].wait,3))
                    start=time.monotonic();b=await self.send(c,301,0);elapsed=time.monotonic()-start
                    self.assertEqual(b.status_code,503,b.text)
                    self.assertLess(elapsed,1.5);self.assertFalse(any(x['user']==301 for x in self.calls))
                    self.assertEqual(app.state.ai_admission_gate.stats().running,2)
                    for t in (0,1):self.holds[(300,t)].set()
                    for r in await asyncio.gather(*tasks):self.body(r)
                    self.assertEqual(app.state.ai_admission_gate.stats().running,0)
                    print(json.dumps({'scenario':'all_shared_slots_held','otherUserHttpStatus':b.status_code,
                        'waitMs':round(elapsed*1000,1),'configuredFixtureWaitMs':120,
                        'otherUserNativeRequests':0,'existingOwnersPreserved':True}))
            finally:
                for x in self.holds.values():x.set()
                await asyncio.gather(*tasks,return_exceptions=True);pool.shutdown(wait=True)
        asyncio.run(run())

    def test_gateway_shared_deployment_must_disable_local_unlimited(self):
        # A reverse proxy is a local peer; the header must be stripped or feature disabled.
        req=Request({'type':'http','path':'/v2/engine/runsextension/ai/translate',
            'headers':[(b'x-tp-local-unlimited',b'1')],'query_string':b'','client':('127.0.0.1',4567)})
        with patch.dict(os.environ,{'TP_ALLOW_LOCAL_UNLIMITED':'1'}):self.assertTrue(wants_unlimited(req))
        with patch.dict(os.environ,{'TP_ALLOW_LOCAL_UNLIMITED':'0'}):self.assertFalse(wants_unlimited(req))

if __name__=='__main__':unittest.main(verbosity=2)
