"""Real FastAPI routing, in-process mock provider. Network to providers is forbidden."""
import asyncio,sys,tempfile, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from fastapi import FastAPI
import httpx
from backend.api.routes import repair_runs as routes
from backend.application.repair_pool.store import RepairStore
from backend.application.repair_pool import state as s

class HttpTest(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.oldStore,self.oldExecute=routes.store,routes.execute
  routes.store=RepairStore(Path(self.tmp.name)/'http.sqlite')
  self.app=FastAPI();self.app.include_router(routes.router)
  self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url='http://test')
  self.root='/v2/engine/runsextension/repair-runs';self.headers={'X-TP-Run-Token':'a'*64}
  self.payloads=[];self.calls=0;self.started=asyncio.Event();self.finish=asyncio.Event()
  async def generate(req,payload,op):
   self.calls+=1; self.payloads.append(payload); self.started.set();await self.finish.wait()
   return dict(schema='tp.ai.result/1',translations=[dict(id='R0',text='สวัสดี')],missing=[],meta={'generationAttempts':1})
  routes.execute=generate
 async def asyncTearDown(self):
  self.finish.set()
  await asyncio.gather(*routes._running,return_exceptions=True)
  await self.client.aclose();routes.store,routes.execute=self.oldStore,self.oldExecute;self.tmp.cleanup()
 async def post(self,suffix,data):return await self.client.post(self.root+suffix,json=data,headers=self.headers)
 async def prepare(self,route='server',reason='missing'):
  r=await self.post('',dict(runId='r',manifest=['p']));self.assertEqual(r.status_code,200,r.text)
  r=await self.post('/r/seal',{});self.assertEqual(r.status_code,409)
  r=await self.post('/r/pages',dict(pageId='p',generationId='g',groupKey='1'*64,status='finished',failed=[dict(id='P0',text='Hello',sourceHash=s.source_hash('Hello'),reason=reason)]));self.assertEqual(r.status_code,200,r.text)
  await self.post('/r/seal',{})
  r=await self.post('/r/claim',dict(taskId='t',executor='w',route=route,ids=['R0']));self.assertEqual(r.status_code,200,r.text)
  return dict(units=[dict(id='R0',text='Hello')])
 async def test_concurrent_duplicate_dispatch_only_one_provider(self):
  payload=await self.prepare()
  first=asyncio.create_task(self.post('/r/tasks/t/translate',payload));await self.started.wait()
  second=await self.post('/r/tasks/t/translate',payload);self.assertEqual(second.status_code,409)
  self.finish.set();self.assertEqual((await first).status_code,200)
  replay=await self.post('/r/tasks/t/translate',payload)
  self.assertEqual(replay.status_code,200);self.assertTrue(replay.json()['replayed']);self.assertEqual(self.calls,1)
  self.assertEqual(replay.json()['meta']['generationAttempts'],0)
 async def test_disconnected_http_receipt_survives_without_second_generation(self):
  payload=await self.prepare();first=asyncio.create_task(self.post('/r/tasks/t/translate',payload));await self.started.wait()
  first.cancel()
  with self.assertRaises(asyncio.CancelledError):await first
  self.finish.set();await asyncio.gather(*routes._running,return_exceptions=True)
  got=await self.client.get(self.root+'/r',headers=self.headers)
  self.assertEqual(got.json()['tasks'][0]['state'],'answered');self.assertEqual(self.calls,1)
  r=await self.post('/r/tasks/t/complete',dict(accepted=['R0']));self.assertEqual(r.json()['phase'],'done')
 async def test_wrong_token_wrong_source_no_provider(self):
  payload=await self.prepare()
  r=await self.client.get(self.root+'/r',headers={'X-TP-Run-Token':'b'*64});self.assertEqual(r.status_code,404)
  payload['units'][0]['text']='CHANGED'
  r=await self.post('/r/tasks/t/translate',payload);self.assertEqual(r.status_code,409);self.assertEqual(self.calls,0)
 async def test_local_route_no_cloud_execution(self):
  payload=await self.prepare('direct-local')
  r=await self.post('/r/tasks/t/translate',payload);self.assertEqual(r.status_code,409)
  r=await self.post('/r/tasks/t/start',dict(executor='w'));self.assertTrue(r.json()['dispatch'])
  r=await self.post('/r/tasks/t/start',dict(executor='w'));self.assertFalse(r.json()['dispatch'])
  r=await self.post('/r/tasks/t/complete',dict(answer={'translations':[dict(id='R0',text='ไทย')]},accepted=['R0']))
  self.assertEqual(r.json()['repaired'],1);self.assertEqual(self.calls,0)
 async def test_cancel_while_provider_running_never_commits(self):
  payload=await self.prepare();first=asyncio.create_task(self.post('/r/tasks/t/translate',payload));await self.started.wait()
  await self.post('/r/cancel',{});self.finish.set();await first
  r=await self.client.get(self.root+'/r',headers=self.headers);self.assertEqual(r.json()['phase'],'cancelled');self.assertEqual(r.json()['results'],[])
 async def test_wrong_language_reason_is_selected_from_the_durable_task(self):
  payload=await self.prepare(reason='wrong_language');payload['repair']={'reason':'untrusted','enabled':True}
  self.finish.set();r=await self.post('/r/tasks/t/translate',payload)
  self.assertEqual(r.status_code,200);self.assertEqual(self.calls,1)
  self.assertEqual(self.payloads[0]['repair'],{'owner':'extension','enabled':False,'reason':'wrong_target_script'})
 async def test_missing_only_task_cannot_request_wrong_language_instruction(self):
  payload=await self.prepare();payload['repair']={'reason':'wrong_target_script','enabled':True}
  self.finish.set();r=await self.post('/r/tasks/t/translate',payload)
  self.assertEqual(r.status_code,200);self.assertEqual(self.calls,1)
  self.assertEqual(self.payloads[0]['repair'],{'owner':'extension','enabled':False,'reason':''})
 async def test_bad_input_400_and_bounded_body(self):
  r=await self.post('',[]);self.assertEqual(r.status_code,400)
  r=await self.post('',{'runId':'r','manifest':['p'],'extra':'x'*(2*1024*1024)})
  self.assertEqual(r.status_code,413)

if __name__=='__main__':unittest.main()
