"""Real repair HTTP/authorization/atomic state transitions; zero AI generation."""
from pathlib import Path
import sys, asyncio, unittest, copy
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
import httpx
from fastapi import FastAPI
from backend.api.routes import repair_runs as routes
from backend.application.repair_pool.store import RepairStore
from backend.application.repair_pool import state

class RepairBulk(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.old=routes.store; routes.store=RepairStore()
  self.app=FastAPI();self.app.include_router(routes.router)
  self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url='http://test')
  self.root='/v2/engine/runsextension/repair-runs';self.headers={'X-TP-Run-Token':'a'*64,'X-TP-Tab-Session':'tab-a'}
 async def asyncTearDown(self):
  routes.store=self.old;await self.client.aclose()
 async def post(self,path,body,headers=None):
  return await self.client.post(self.root+path,json=body,headers=headers or self.headers)
 async def register(self,run='run',n=28,headers=None):
  r=await self.post('',{'runId':run,'manifest':[f'p{i}' for i in range(n)]},headers);self.assertEqual(r.status_code,200,r.text)
 def page(self,i,failed=False):
  return {'pageId':f'p{i}','generationId':f'g{i}','groupKey':'1'*64,'status':'finished','initialAccepted':0 if failed else 1,
   'failed':[{'id':'P0','text':'Hello','sourceHash':state.source_hash('Hello'),'reason':'missing'}] if failed else []}
 async def get(self,run='run',headers=None):
  return await self.client.get(self.root+'/'+run,headers=headers or self.headers)
 async def test_28_pages_one_request_same_round_and_replay(self):
  await self.register();body={'pages':[self.page(i,failed=i%7==0) for i in range(28)]}
  r=await self.post('/run/pages',body);self.assertEqual(r.status_code,200,r.text);self.assertEqual(r.json()['pageCount'],28)
  replay=await self.post('/run/pages',body);self.assertEqual(replay.json()['replayedCount'],28)
  view=(await self.get()).json();self.assertEqual(view['initialPages'],28);self.assertEqual(len(view['pending']),4)
  sealed=(await self.post('/run/seal',{})).json();self.assertEqual(sealed['round'],1)
  self.assertEqual((await self.post('/run/seal',{})).json()['round'],1)
  # Transport repeat remains idempotent after seal; it cannot add another repair round.
  self.assertEqual((await self.post('/run/pages',body)).json()['replayedCount'],28)
  self.assertEqual((await self.get()).json()['pending'],sealed['pending'])
 async def test_invalid_last_page_rolls_back_all_then_recovers(self):
  await self.register(n=3);bad=[self.page(i,True) for i in range(3)];bad[-1]['failed'][0]['sourceHash']='f'*64
  r=await self.post('/run/pages',{'pages':bad});self.assertEqual(r.status_code,409,r.text)
  view=(await self.get()).json();self.assertEqual(view['initialPages'],0);self.assertEqual(view['pending'],[])
  r=await self.post('/run/pages',{'pages':[self.page(i,True) for i in range(3)]});self.assertEqual(r.status_code,200,r.text)
  self.assertEqual(len((await self.get()).json()['pending']),3)
 async def test_bounds_duplicates_and_legacy(self):
  await self.register(n=40)
  for body in [{'pages':[]},{'pages':[self.page(i) for i in range(33)]},{'pages':[self.page(0),self.page(0)]},
    {'pages':[None]},{'pages':[self.page(0)],'unexpected':True}]:
   r=await self.post('/run/pages',body);self.assertEqual(r.status_code,400,r.text)
  self.assertEqual((await self.get()).json()['initialPages'],0)
  r=await self.post('/run/pages',self.page(0));self.assertEqual(r.status_code,200)
  r=await self.post('/run/pages',{'pages':[self.page(0)]});self.assertEqual(r.json()['replayedCount'],1)
  huge=await self.post('/run/pages',{'pages':[{'raw':'x'*(2*1024*1024)}]});self.assertEqual(huge.status_code,413)
  self.assertEqual((await self.get()).json()['initialPages'],1)
 async def test_wrong_token_cannot_read_or_mutate(self):
  await self.register();other={'X-TP-Run-Token':'b'*64,'X-TP-Tab-Session':'tab-b'}
  self.assertIn((await self.get(headers=other)).status_code,[401,403,404])
  self.assertIn((await self.post('/run/pages',{'pages':[self.page(0)]},other)).status_code,[401,403,404])
  self.assertEqual((await self.get()).json()['initialPages'],0)
 async def test_concurrent_users_and_same_page_ids_stay_separate(self):
  async def user(i):
   headers={'X-TP-Run-Token':f'{i+1:064x}','X-TP-Tab-Session':f'tab-{i}'};run=f'r{i}'
   await self.register(run,28,headers)
   p=[self.page(j,j==i) for j in range(28)]
   r=await self.post('/'+run+'/pages',{'pages':p},headers);self.assertEqual(r.status_code,200,r.text)
   view=(await self.get(run,headers)).json();self.assertEqual(view['initialPages'],28)
   self.assertEqual([u['pageId'] for u in view['pending']],[f'p{i}'])
  await asyncio.gather(*(user(i) for i in range(24)))
 async def test_maximum_claim_stays_200_and_no_round_two(self):
  await self.register(n=28);pages=[self.page(i) for i in range(28)]
  # 236 genuine pending units, one existing repair round, two bounded claims.
  pages[0]['failed']=[{'id':f'P{i}','text':f'Hello {i}','sourceHash':state.source_hash(f'Hello {i}'),'reason':'missing'} for i in range(236)]
  self.assertEqual((await self.post('/run/pages',{'pages':pages})).status_code,200)
  self.assertEqual((await self.post('/run/seal',{})).json()['round'],1)
  ids=[f'R{i}' for i in range(236)]
  too_many=await self.post('/run/claim',{'taskId':'bad','executor':'w','route':'direct-local','ids':ids})
  self.assertEqual(too_many.status_code,400)
  for task,group in [('first',ids[:200]),('second',ids[200:])]:
   r=await self.post('/run/claim',{'taskId':task,'executor':'w','route':'direct-local','ids':group})
   self.assertEqual(r.status_code,200,r.text)
  view=(await self.get()).json();self.assertEqual(view['round'],1);self.assertEqual(len(view['tasks']),2)

if __name__=='__main__':unittest.main(verbosity=2)
