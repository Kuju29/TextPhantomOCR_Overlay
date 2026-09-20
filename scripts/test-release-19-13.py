"""Independent release acceptance: real HTTP routes, synthetic provider boundary.

No external network, real keys, or production module modifications.
"""
import asyncio, copy, json, os, sys, tempfile, unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
import httpx
from fastapi import FastAPI
from backend.api.routes.ai_v1 import router as ai_router
from backend.api.routes import repair_runs
from backend.jobs.admission import AdmissionGate
from backend.ai.provider_registry import provider_registry
from backend.ai.clients.base import ChatResult
from backend.ai.providers.openai_provider_runtime import build_messages
from backend.application.repair_pool.store import RepairStore
from backend.application.repair_pool.state import source_hash

class ReleaseHttp(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  env=patch.dict(os.environ,{'TP_USAGE_RECEIPTS':'off','TP_AI_WIRE_TRACE':'0','TP_CONVERSATION_STATE_FILE':self.temp.name+'/history.sqlite','TP_PROMPT_CACHE_COORDINATION':'off'})
  env.start();self.addCleanup(env.stop)
  self.calls=[]
  def generate(request):
   self.calls.append({'messages':copy.deepcopy(build_messages(request)),'expected':list(request.expected_ids)})
   ids=list(request.expected_ids) or [f'P{i}' for i in range(request.unit_count)]
   answer='\n'.join((f'<<{uid}:คำแปล{i}>>' if uid.startswith('I') else f'<<TP_{uid}:คำแปล{i}>>') for i,uid in enumerate(ids))
   return ChatResult(text=answer,used_model=request.model,input_tokens=1000,output_tokens=20*len(ids),total_tokens=1000+20*len(ids),thinking_tokens=0,terminal_completed=True,terminal_evidence='provider_done',finish_reason='stop',cached_input_tokens=0)
  for p in [patch.object(provider_registry.require('huggingface').adapter,'generate',side_effect=generate),patch('backend.ai.provider_resolution.discovered_model_capabilities',return_value=(False,{})),patch.object(repair_runs,'store',RepairStore(Path(self.temp.name)/'repair.sqlite'))]:p.start();self.addCleanup(p.stop)
  self.pool=ThreadPoolExecutor(max_workers=4);self.addCleanup(self.pool.shutdown)
  self.app=FastAPI();self.app.include_router(ai_router);self.app.include_router(repair_runs.router)
  self.app.state.ai_admission_gate=AdmissionGate(4,max_waiters=16,max_wait_sec=3);self.app.state.ai_executor=self.pool
  self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url='http://test')
  self.headers={'X-TP-Run-Token':'a'*64,'X-TP-Tab-Session':'independent-release-test'}
  self.base='/v2/engine/runsextension/repair-runs'
 async def asyncTearDown(self):
  await asyncio.gather(*repair_runs._running,return_exceptions=True);await self.client.aclose()
 def payload(self,texts,origins,branch='initial'):
  return {'schema':'tp.ai.request/1','translationMode':'conversation','units':[{'id':uid,'text':text} for uid,text in texts],
   'context':{'tp_tab_session':'independent-release-test','page_url':self.temp.name},'sourceLang':'en','targetLang':'th','provider':{'id':'huggingface','model':'fixture','apiKey':'FAKE_TEST_KEY','baseUrl':'https://router.huggingface.co/v1','thinking':'off'},
   'memory':{'mode':'full','styleExamples':True},'repair':{'owner':'extension','enabled':False},
   'conversation':{'documentId':self.temp.name,'pageId':origins[0]['pageId'],'branch':branch,'origins':origins}}
 async def post(self,url,payload):
  return await self.client.post(url,json=payload,headers=self.headers)
 async def test_two_page_repair_waits_for_all_main_and_preserves_exact_chat(self):
  origins=[{'pageId':'page-a','pageIndex':0,'unitIds':['I1_P0'],'originalIds':['g0'],'sourceFingerprint':'a'*64}, {'pageId':'page-b','pageIndex':1,'unitIds':['I2_P0'],'originalIds':['g0'],'sourceFingerprint':'b'*64}]
  main=self.payload([('I1_P0','First original'),('I2_P0','Second original')],origins)
  response=await self.post('/v2/engine/runsextension/ai/translate',main)
  self.assertEqual(response.status_code,200,response.text);self.assertEqual(len(self.calls),1)
  self.assertEqual((await self.post(self.base,{'runId':'r','manifest':['page-a','page-b']})).status_code,200)
  for index,(page,text) in enumerate([('page-a','First original'),('page-b','Second original')]):
   page_result=await self.post(self.base+'/r/pages',{'pageId':page,'generationId':'generation','groupKey':'c'*64,'status':'finished','failed':[{'id':'g0','text':text,'sourceHash':source_hash(text),'reason':'missing'}]})
   self.assertEqual(page_result.status_code,200,page_result.text)
   if index==0:
    early=await self.post(self.base+'/r/seal',{});self.assertEqual(early.status_code,409,early.text)
    self.assertEqual(len(self.calls),1,'no repair provider call before all main pages finish')
  self.assertEqual((await self.post(self.base+'/r/seal',{})).status_code,200)
  claim=await self.post(self.base+'/r/claim',{'taskId':'task','executor':'worker','route':'server','ids':['R0','R1']});self.assertEqual(claim.status_code,200,claim.text)
  repaired_origins=copy.deepcopy(origins)
  for index,origin in enumerate(repaired_origins):origin['originalIds']=[f'R{index}']
  repair=self.payload([('I1_P0','First original'),('I2_P0','Second original')],repaired_origins,'repair')
  for corrupted in ('duplicate_wire_id','wrong_page'):
   invalid=copy.deepcopy(repair)
   if corrupted=='wrong_page':invalid['conversation']['origins'][1]['pageId']='page-other'
   else:
    invalid['conversation']['origins'][1]['unitIds']=['I1_P0'];invalid['units'][1]['id']='I1_P0'
   rejected=await self.post(self.base+'/r/tasks/task/translate',invalid)
   self.assertEqual(rejected.status_code,409,rejected.text)
   self.assertEqual(len(self.calls),1,'invalid origins must not dispatch or consume task')
  result=await self.post(self.base+'/r/tasks/task/translate',repair)
  self.assertEqual(result.status_code,200,result.text);self.assertEqual(len(self.calls),2,'both repair pages share one provider request')
  self.assertEqual([r['id'] for r in result.json()['translations']],['R0','R1'])
  self.assertEqual(self.calls[1]['messages'][:len(self.calls[0]['messages'])],self.calls[0]['messages'],'main request prefix unchanged')
  self.assertEqual(self.calls[1]['messages'][-2]['role'],'assistant')
  done=await self.post(self.base+'/r/tasks/task/complete',{'accepted':['R0','R1']});self.assertEqual(done.status_code,200,done.text)
  self.assertEqual(done.json()['phase'],'done');self.assertEqual(done.json()['repaired'],2)
  replay=await self.post(self.base+'/r/tasks/task/translate',repair);self.assertEqual(replay.status_code,200,replay.text);self.assertEqual(len(self.calls),2)
  later=self.payload([('I3_P0','Later original')],[{'pageId':'page-c','pageIndex':2,'unitIds':['I3_P0'],'originalIds':['g0'],'sourceFingerprint':'d'*64}])
  response=await self.post('/v2/engine/runsextension/ai/translate',later)
  self.assertEqual(response.status_code,200,response.text);self.assertEqual(len(self.calls),3)
  self.assertEqual(self.calls[2]['messages'][:len(self.calls[1]['messages'])],self.calls[1]['messages'],'repair request remains append-only history for next main')
  self.assertEqual(self.calls[2]['messages'][-2]['role'],'assistant')
  self.assertFalse(list(Path(self.temp.name).glob('*.sqlite')),'API work must not persist state files')
  self.assertNotIn('FAKE_TEST_KEY',json.dumps(self.calls),'credential must not enter prompt history')

if __name__=='__main__':unittest.main(verbosity=2)
