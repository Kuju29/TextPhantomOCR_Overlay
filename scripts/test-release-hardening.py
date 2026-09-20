"""19.19 release blockers: real routers/store, synthetic I/O, loopback only."""
from __future__ import annotations
import asyncio
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import anyio
import httpx
from fastapi import FastAPI
from backend.api.routes import ai as routes, meta as meta_routes
from backend.ai import resolve as resolution
from backend.config import settings
from backend.security import assert_ai_base_url_allowed, UnsafeBaseUrl
from backend.ai.translation_paths import store as memory
from backend.application.repair_pool import store as pools, state


def config(**values):
    # Settings is frozen; patch.object cannot restore attributes normally.
    from contextlib import contextmanager
    @contextmanager
    def scope():
        old = {k:getattr(settings,k) for k in values}
        try:
            for k,v in values.items(): object.__setattr__(settings,k,v)
            yield
        finally:
            for k,v in old.items(): object.__setattr__(settings,k,v)
    return scope()


class RouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_io_and_heartbeat(self):
        app=FastAPI();app.include_router(routes.router);app.include_router(meta_routes.router)
        for path,target,attr in [('/ai/resolve',routes.ai_resolve,'resolve'),('/ai/probe',routes.ai_probe,'probe'),('/warmup',meta_routes,'run_warmup')]:
            with self.subTest(path=path):
                ticks=[];running=True
                async def heartbeat():
                    while running: ticks.append(time.perf_counter());await asyncio.sleep(.01)
                def slow(*args):
                    time.sleep(.16)
                    return {'ok':True,'provider':'fixture','model':'fixture','models':[],'status':'valid'}
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as c:
                    ticker=asyncio.create_task(heartbeat());await asyncio.sleep(.02)
                    with patch.object(target,attr,side_effect=slow) as calls:
                        start=time.perf_counter()
                        fn=(lambda:c.get(path)) if path=='/warmup' else (lambda:c.post(path,json={}))
                        replies=await asyncio.gather(*(fn() for _ in range(3)))
                        elapsed=time.perf_counter()-start
                    await asyncio.sleep(.02);running=False;await ticker
                gap=max(b-a for a,b in zip(ticks,ticks[1:]))
                print(json.dumps({'endpoint':path,'requests':3,'syntheticIoMs':160,'elapsedMs':round(elapsed*1000,2),'maxHeartbeatGapMs':round(gap*1000,2)}))
                self.assertEqual(calls.call_count,3)
                self.assertTrue(all(r.status_code==200 for r in replies))
                self.assertLess(elapsed,.43)
                self.assertLess(gap,.12)

    async def test_bounded_worker_and_queued_cancellation(self):
        # Cancellation before admission must not execute any discovery/probe I/O.
        limiter=anyio.to_thread.current_default_thread_limiter();old=limiter.total_tokens
        limiter.total_tokens=1
        entered=threading.Event();release=threading.Event();calls=[];scope_ready=anyio.Event();finished=anyio.Event()
        def blocking(payload):
            calls.append(payload['id']);entered.set();release.wait(2)
            return {'ok':True,'models':[]}
        queued_scope=None
        async def queued():
            nonlocal queued_scope
            with anyio.CancelScope() as scope:
                queued_scope=scope;scope_ready.set()
                await routes.resolve({'id':'queued'})
            finished.set()
        try:
            with patch.object(routes.ai_resolve,'resolve',side_effect=blocking):
                async with anyio.create_task_group() as tg:
                    tg.start_soon(routes.resolve,{'id':'active'})
                    while not entered.is_set():await anyio.sleep(.005)
                    tg.start_soon(queued);await scope_ready.wait();await anyio.sleep(.02)
                    queued_scope.cancel();await finished.wait();self.assertEqual(calls,['active'])
                    release.set()
            self.assertEqual(limiter.borrowed_tokens,0)
        finally:release.set();limiter.total_tokens=old

    async def test_route_security_error_and_byok_does_not_authorize_network(self):
        app=FastAPI();app.include_router(routes.router)
        with config(ai_endpoint_policy='shared',ai_extra_hosts=''):
            with patch.object(resolution,'_enumerate_models_detailed') as enumeration:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as c:
                    for endpoint in ['/ai/resolve','/ai/probe']:
                        for key in ['', 'caller-key']:
                            response=await c.post(endpoint,json={'provider':'ollama','model':'fixture','base_url':'http://127.0.0.1:11434','api_key':key})
                            self.assertEqual(response.status_code,200)
                            self.assertEqual(response.json()['error'],'unsafe_base_url')
                enumeration.assert_not_called()


class UrlPolicyTests(unittest.TestCase):
    def test_shared_registry_allowlist_personal_and_validation(self):
        with config(ai_endpoint_policy='shared',ai_extra_hosts=''):
            assert_ai_base_url_allowed('openrouter','https://openrouter.ai/api/v1',user_key=True)
            assert_ai_base_url_allowed('gemini','',user_key=True)  # native fixed endpoint
            with self.assertRaises(UnsafeBaseUrl):
                assert_ai_base_url_allowed('unknown','',user_key=True)
            for url in ['http://127.0.0.1:11434','http://10.0.0.8:11434','http://169.254.169.254',
                        'https://unapproved.invalid/v1','https://openrouter.ai.attacker.invalid/v1',
                        'http://openrouter.ai/api/v1','https://openrouter.ai:7777/api/v1',
                        'file:///etc/passwd','https://user:secret@openrouter.ai/api/v1',
                        'https://openrouter.ai/api/v1?next=internal','https://openrouter.ai/api/v1#x',
                        'https://openrouter.ai:99999/api/v1','https://openrouter.ai\\@127.0.0.1',
                        'https://openrouter.ai/\ninternal']:
                for key in [False,True]:
                    with self.subTest(url=url,key=key),self.assertRaises(UnsafeBaseUrl):
                        assert_ai_base_url_allowed('ollama',url,user_key=key,key_present=key)
        with config(ai_endpoint_policy='personal',ai_extra_hosts=''):
            for url in ['http://127.0.0.1:11434','http://localhost:1234/v1','http://[::1]:11434']:
                assert_ai_base_url_allowed('ollama',url,user_key=False,key_present=False)
            with self.assertRaises(UnsafeBaseUrl):
                assert_ai_base_url_allowed('ollama','http://10.0.0.8:11434',user_key=True)
        with config(ai_endpoint_policy='shared',ai_extra_hosts='10.0.0.8, my-runtime.example'):
            assert_ai_base_url_allowed('ollama','http://10.0.0.8:11434',user_key=False,key_present=False)
            assert_ai_base_url_allowed('openai','https://my-runtime.example/v1',user_key=True)
        with config(ai_endpoint_policy='typo',ai_extra_hosts='127.0.0.1'):
            with self.assertRaises(UnsafeBaseUrl):
                assert_ai_base_url_allowed('ollama','http://127.0.0.1',user_key=True)

    def test_actual_outbound_boundary_and_redirects(self):
        hits=[];redirect=[False]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                hits.append(self.path)
                if redirect[0] and self.path=='/api/tags':
                    self.send_response(302);self.send_header('Location','/private-target');self.end_headers();return
                body=b'{"models":[]}'
                self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        srv=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=srv.serve_forever,daemon=True);thread.start()
        url=f'http://127.0.0.1:{srv.server_port}'
        try:
            with config(ai_endpoint_policy='shared',ai_extra_hosts=''):
                with self.assertRaises(UnsafeBaseUrl):resolution.resolve({'provider':'ollama','base_url':url})
                self.assertEqual(hits,[])
            with config(ai_endpoint_policy='personal',ai_extra_hosts=''):
                resolution.resolve({'provider':'ollama','base_url':url})
                self.assertIn('/api/tags',hits)
            # Use native catalogue function to bypass catalogue cache only, not policy.
            redirect[0]=True;hits.clear()
            with config(ai_endpoint_policy='shared',ai_extra_hosts='127.0.0.1'):
                assert_ai_base_url_allowed('ollama',url,user_key=False,key_present=False)
                resolution._enumerate_models_detailed('ollama','',url)
                self.assertNotIn('/private-target',hits)
        finally:srv.shutdown();srv.server_close();thread.join()


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.pool=pools.RepairStore();self.patch=patch.object(pools,'store',self.pool);self.patch.start()
        self.db=memory.Store();self.token='1'*64
    def tearDown(self):self.patch.stop()
    def run_scope(self, name, text='history'):
        self.pool.register(name,self.token,[name+'-page'],'caller-'+name)
        lease=self.db.try_acquire(name,[name+'-page']);lease.history=[{'user':text,'assistant':'answer','anchor':True}];lease.prefix='prefix-'+name;lease.dirty=True;lease.close(True)
        return lease
    def finish(self,name):
        self.pool.transact(name,self.token,lambda r:state.record_page(r,{'pageId':name+'-page','generationId':'gen','status':'no_source'}))
        self.pool.transact(name,self.token,state.seal)
    def test_busy_workflow_survives_gap_and_finished_one_is_evictable(self):
        with patch.object(memory,'MAX_SESSIONS',2):
            self.run_scope('a');self.run_scope('b')
            with self.assertRaises(memory.ConversationError) as ctx:self.db.try_acquire('c')
            self.assertEqual(ctx.exception.code,'ai_conversation_capacity')
            a=self.db.try_acquire('a',['a-page']);self.assertEqual(a.history[0]['user'],'history');self.assertEqual(a.prefix,'prefix-a');a.close(False)
            self.finish('a')
            c=self.db.try_acquire('c');c.close(False)
            self.assertNotIn('a',self.db._rows)
            b=self.db.try_acquire('b',['b-page']);self.assertEqual(b.revision,1);b.close(False)
    def test_original_256_scope_repro_no_longer_loses_history(self):
        first=self.db.try_acquire('first');first.history=[{'user':'source','assistant':'translation'}];first.dirty=True;first.close(True)
        for i in range(memory.MAX_SESSIONS):
            l=self.db.try_acquire(f'other-{i}');l.close(False)
        again=self.db.try_acquire('first');self.assertEqual(again.revision,1);self.assertEqual(again.history[0]['user'],'source');again.close(False)
    def test_total_capacity_preserves_active_history_and_fences_failed_commit(self):
        self.run_scope('a');self.run_scope('b')
        before={k:(r['history'],r['prefix']) for k,r in self.db._rows.items()}
        with patch.object(memory,'MAX_TOTAL_HISTORY_CHARS',sum(r['chars'] for r in self.db._rows.values())):
            a=self.db.try_acquire('a',['a-page']);a.history.append({'user':'more','assistant':'more'});a.dirty=True;a.close(True)
        self.assertEqual(a.commit_status,'history_storage_limit')
        self.assertEqual(before,{k:(r['history'],r['prefix']) for k,r in self.db._rows.items()})
        with self.assertRaises(memory.ConversationError) as ctx:self.db.try_acquire('a',['a-page'])
        self.assertEqual(ctx.exception.code,'ai_conversation_history_capacity')
        self.assertFalse(ctx.exception.requestDispatched)
    def test_manifest_index_authority_cleanup_and_expiry(self):
        self.run_scope('a');self.assertEqual(self.pool.active_for_pages(['a-page']),{'a'})
        with self.assertRaises(state.PoolError):self.pool.transact('a','2'*64,state.cancel)
        self.assertEqual(self.pool.active_for_pages(['a-page']),{'a'})
        self.pool.transact('a',self.token,state.cancel);self.assertEqual(self.pool.active_for_pages(['a-page']),set())
        self.pool.delete('a',self.token);self.assertNotIn('a-page',self.pool._page_runs)
        self.run_scope('b');self.pool._runs['b']['expires']=0
        self.assertEqual(self.pool.active_for_pages(['b-page']),set());self.pool._prune();self.assertNotIn('b-page',self.pool._page_runs)
    def test_concurrent_private_scopes_no_cross_user_history(self):
        from concurrent.futures import ThreadPoolExecutor
        def work(n):
            key=f'owner-{n}';self.run_scope(key,key)
            for _ in range(3):
                l=self.db.try_acquire(key,[key+'-page']);self.assertEqual(l.history[0]['user'],key);l.close(False)
        with ThreadPoolExecutor(max_workers=16) as ex:list(ex.map(work,range(64)))
        self.assertEqual(len(self.db._rows),64)

if __name__=='__main__':unittest.main(verbosity=2)
