"""Real ASGI grouping route stays responsive while its CPU task waits/runs."""
from __future__ import annotations
import asyncio, base64, io, json, os, sys, threading, time, unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from fastapi import FastAPI
import httpx
ROOT=Path(os.environ.get('TP_TEST_ROOT',Path(__file__).resolve().parents[1])).resolve()
sys.path.insert(0,str(ROOT/'api'))
from backend.api.routes import lens_groups
from backend.application import lens_grouping
from backend.jobs.admission import AdmissionGate

class GroupingEventLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_probe_completes_before_grouping_released(self):
        started=threading.Event();release=threading.Event();finished=threading.Event()
        original=lens_grouping.group_vertical_lens
        def work(*args,**kwargs):
            started.set()
            try:
                release.wait(1.5)
                return original(*args,**kwargs)
            finally:finished.set()
        app=FastAPI();app.include_router(lens_groups.router)
        app.state.grouping_admission_gate=AdmissionGate(15,max_waiters=8,max_wait_sec=1)
        app.state.grouping_executor=ThreadPoolExecutor(max_workers=15,thread_name_prefix='test-group')
        @app.get('/diagnostic-probe')
        async def probe():return {'groupingStillActive':started.is_set() and not finished.is_set()}
        image=Image.new('RGB',(400,400),'white');data=io.BytesIO();image.save(data,'PNG')
        box=[100,20,116,120]
        payload={'tree':{'paragraphs':[{'text':'本文','bounds_px':box,'items':[{'text':'本文','bounds_px':box,'box':{'rotation_deg':90,'height':.25}}]}]},
                 'imageDataUri':'data:image/png;base64,'+base64.b64encode(data.getvalue()).decode()}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            with patch.object(lens_grouping,'group_vertical_lens',side_effect=work):
                t=time.perf_counter();task=asyncio.create_task(client.post('/v2/engine/runsextension/groups',json=payload))
                try:
                    for _ in range(500):
                        if started.is_set() or task.done():break
                        await asyncio.sleep(.005)
                    self.assertTrue(started.is_set(), 'real grouping reached the CPU service')
                    response=await client.get('/diagnostic-probe')
                    probe_ms=round((time.perf_counter()-t)*1000,2)
                    self.assertTrue(response.json()['groupingStillActive'],'grouping must not occupy the ASGI event loop')
                finally:release.set()
                grouped=await task
                self.assertEqual(grouped.status_code,200,grouped.text)
                self.assertTrue(grouped.json()['coverage']['complete'])
                self.assertEqual(grouped.json()['tree']['paragraphs'][0]['text'],'本文')
                print(json.dumps({'probeMs':probe_ms,'groupingCompletedAfterProbe':True,'httpStatus':grouped.status_code}))

if __name__=='__main__':unittest.main()
