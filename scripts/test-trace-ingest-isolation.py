"""An actual ASGI request must not block other work on diagnostic file I/O."""
import asyncio, os, sys, threading, time, unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import FastAPI
import httpx
ROOT=Path(os.environ.get('TP_TEST_ROOT', Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(ROOT/'api'))
from backend.api.routes import logs

class TraceIsolation(unittest.IsolatedAsyncioTestCase):
    async def test_other_requests_progress_while_trace_writer_is_held(self):
        started, released, done = threading.Event(), threading.Event(), threading.Event()
        def writer(records):
            started.set()
            try:
                released.wait(1.0)
                return len(records)
            finally: done.set()
        app=FastAPI();app.include_router(logs.router)
        @app.get('/fixture-progress')
        async def progress(): return {'writerStillActive':started.is_set() and not done.is_set()}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as client:
            with patch.object(logs.trace,'enabled',return_value=True), patch.object(logs.trace,'session_id',return_value='fixture'), patch.object(logs.trace,'client',side_effect=writer):
                start=time.monotonic()
                pending=asyncio.create_task(client.post('/v1/trace',json={'traceSession':'fixture','records':[{'n':1,'fn':'fixture'}]}))
                try:
                    for _ in range(250):
                        if started.is_set() or pending.done(): break
                        await asyncio.sleep(.005)
                    self.assertTrue(started.is_set())
                    response=await client.get('/fixture-progress')
                    self.assertTrue(response.json()['writerStillActive'], 'diagnostic ingest holds the API event loop')
                    print({'probe_ms':round((time.monotonic()-start)*1000,2),'writerCompletedAfterProbe':True})
                finally:
                    released.set()
                    result=await pending
                self.assertEqual(result.status_code,200)
                self.assertEqual(result.json()['written'],1)

if __name__=='__main__':unittest.main(verbosity=2)
