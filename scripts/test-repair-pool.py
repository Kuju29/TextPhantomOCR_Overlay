"""Durable server repair transitions; no provider/network calls."""
import concurrent.futures
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.application.repair_pool import state as s
from backend.application.repair_pool.store import RepairStore
TOKEN='a'*64
GROUP='1'*64

def page(i,n=1):
    return dict(pageId=f'p{i}', generationId=f'gen{i}', groupKey=GROUP, status='finished',
        initialAccepted=3 if i<16 else 2, unverified=0, failed=[dict(id=f'g{k}',text=f'原文 {i} {k}',
        sourceHash=s.source_hash(f'原文 {i} {k}'),reason='wrong_language') for k in range(n)])

class PoolTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'state.db';self.db=RepairStore(self.path)
 def tearDown(self): self.tmp.cleanup()
 def make(self,pages=2,failures=2):
  self.db.register('run',TOKEN,[f'p{i}' for i in range(pages)],'caller')
  for i in range(pages): self.db.transact('run',TOKEN,lambda r,i=i:s.record_page(r,page(i,failures)))
  return self.db.transact('run',TOKEN,s.seal)
 def test_32_page_barrier_only_20_failed(self):
  self.db.register('run',TOKEN,[f'p{i}' for i in range(32)],'caller')
  for i in range(31): self.db.transact('run',TOKEN,lambda r,i=i:s.record_page(r,page(i,1 if i<20 else 0)))
  with self.assertRaisesRegex(s.PoolError,'initial_pass_not_complete'): self.db.transact('run',TOKEN,s.seal)
  self.db.transact('run',TOKEN,lambda r:s.record_page(r,page(31,0)))
  snapshot=self.db.transact('run',TOKEN,s.seal);self.assertEqual(len(snapshot['pending']),20)
  self.assertEqual(snapshot['initialAccepted'],80)
  self.assertEqual(snapshot['round'],1)
  self.assertEqual(self.db.transact('run',TOKEN,s.seal)['round'],1)
  for index, aliases in enumerate([list(range(6)),list(range(6,14)),list(range(14,20))]):
   task=f't{index}';ids=[f'R{i}' for i in aliases]
   self.db.transact('run',TOKEN,lambda r:s.claim(r,dict(taskId=task,executor='w',route='server',ids=ids)))
   self.assertTrue(self.db.transact('run',TOKEN,lambda r:s.begin(r,task,'w'))['dispatch'])
   self.assertFalse(self.db.transact('run',TOKEN,lambda r:s.begin(r,task,'w'))['dispatch'])
   self.db.transact('run',TOKEN,lambda r:s.answer_task(r,task,dict(translations=[dict(id=i,text='คำแปล') for i in ids])))
   snapshot=self.db.transact('run',TOKEN,lambda r:s.complete(r,task,dict(accepted=ids)))
   self.db.transact('run',TOKEN,lambda r:s.complete(r,task,dict(accepted=list(reversed(ids)))))
  self.assertEqual(snapshot['phase'],'done');self.assertEqual(snapshot['repaired'],20)
  self.assertEqual(len({(r['pageId'],r['unitId']) for r in snapshot['results']}),20)
  with self.assertRaisesRegex(s.PoolError,'repair_not_ready'):
   self.db.transact('run',TOKEN,lambda r:s.claim(r,dict(taskId='again',executor='w',route='server',ids=['R0'])))
 def test_atomic_claims(self):
  self.make(1,1)
  def claim(i):
   try:
    RepairStore(self.path).transact('run',TOKEN,lambda r:s.claim(r,dict(taskId=f't{i}',executor=f'w{i}',route='server',ids=['R0'])))
    return True
   except s.PoolError:return False
  with concurrent.futures.ThreadPoolExecutor(8) as pool: results=list(pool.map(claim,range(16)))
  self.assertEqual(sum(results),1)
 def test_recovered_answer_same_source(self):
  self.make(1,2)
  task=dict(taskId='t',executor='w',route='server',ids=['R0','R1'])
  self.db.transact('run',TOKEN,lambda r:s.claim(r,task))
  self.db.transact('run',TOKEN,lambda r:s.begin(r,'t','w'))
  self.db.transact('run',TOKEN,lambda r:s.answer_task(r,'t',dict(translations=[dict(id='R0',text='ไทย')],apiKey='secret')))
  self.db=RepairStore(self.path)
  snapshot=self.db.read('run',TOKEN);self.assertEqual(snapshot['tasks'][0]['state'],'answered')
  self.assertNotIn('secret',json.dumps(snapshot))
  with self.assertRaisesRegex(s.PoolError,'invalid_repair_acceptance'):
   self.db.transact('run',TOKEN,lambda r:s.complete(r,'t',dict(accepted=['R1'])))
  snapshot=self.db.transact('run',TOKEN,lambda r:s.complete(r,'t',dict(accepted=['R0'])))
  self.assertEqual(snapshot['repaired'],1);self.assertEqual(snapshot['unresolved'],1)
 def test_local_response_ack_replay(self):
  self.make(1,1)
  self.db.transact('run',TOKEN,lambda r:s.claim(r,dict(taskId='t',executor='w',route='direct-local',ids=['R0'])))
  self.db.transact('run',TOKEN,lambda r:s.begin(r,'t','w'))
  answer=dict(translations=[dict(id='R0',text='ไทย')])
  for _ in range(2): snapshot=self.db.transact('run',TOKEN,lambda r:s.complete(r,'t',dict(answer=answer,accepted=['R0'])))
  self.assertEqual(snapshot['repaired'],1)
 def test_cancel_erases_and_late_answer_does_not_commit(self):
  self.make(1,1)
  self.db.transact('run',TOKEN,lambda r:s.claim(r,dict(taskId='t',executor='w',route='server',ids=['R0'])))
  self.db.transact('run',TOKEN,lambda r:s.begin(r,'t','w'))
  self.db.transact('run',TOKEN,s.cancel)
  ret=self.db.transact('run',TOKEN,lambda r:s.answer_task(r,'t',dict(translations=[dict(id='R0',text='ไทย')])))
  self.assertTrue(ret['cancelled']);self.assertNotIn('原文',json.dumps(self.db.read('run',TOKEN),ensure_ascii=False))
  with self.assertRaisesRegex(s.PoolError,'cancelled'): self.db.transact('run',TOKEN,lambda r:s.fail(r,'t','late'))
 def test_ownership_immutable_page_and_hash(self):
  self.make(1,1)
  with self.assertRaisesRegex(s.PoolError,'not_found'): self.db.read('run','b'*64)
  body=page(0);body['failed'][0]['sourceHash']='bad'
  with self.assertRaisesRegex(s.PoolError,'hash_mismatch'): self.db.transact('run',TOKEN,lambda r:s.record_page(r,body))
  body=page(0);body['initialAccepted']=4
  with self.assertRaisesRegex(s.PoolError,'already_finalized'): self.db.transact('run',TOKEN,lambda r:s.record_page(r,body))
 def test_malformed_and_limits(self):
  self.make(1,1)
  for ids in [[{}],['R0','R0'],[],None]:
   with self.assertRaises(s.PoolError):self.db.transact('run',TOKEN,lambda r:s.claim(r,dict(taskId='x',executor='w',route='server',ids=ids)))
  with self.assertRaises(s.PoolError):s.new_run('x',['p']*513,0)
  with self.assertRaises(s.PoolError):s.count('bad')
 def test_expiry_and_interrupted_no_requeue(self):
  self.make(1,1)
  self.db.transact('run',TOKEN,lambda r:s.claim(r,dict(taskId='t',executor='w',route='server',ids=['R0'])))
  self.db.transact('run',TOKEN,lambda r:s.begin(r,'t','w'))
  out=self.db.transact('run',TOKEN,lambda r:s.fail(r,'t','unknown',True))
  self.assertEqual(out['phase'],'done');self.assertEqual(out['pending'],[]);self.assertEqual(out['unresolved'],1)
  self.db.now=lambda:10**15
  with self.assertRaisesRegex(s.PoolError,'not_found'):self.db.read('run',TOKEN)

if __name__=='__main__':unittest.main()
