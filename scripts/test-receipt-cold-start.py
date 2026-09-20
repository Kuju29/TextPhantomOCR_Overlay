"""Concurrent process-lifetime receipt accounting; no providers or disk state."""
from __future__ import annotations
import concurrent.futures, json, os, subprocess, sys, tempfile, threading, unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(os.environ.get('TP_TEST_ROOT',Path(__file__).resolve().parents[1])).resolve()
sys.path.insert(0,str(ROOT/'api'))
from backend.ai import accounting

def write_receipt(i):
 ctx={'receiptId':f'cold-{i}','usage':{'usageStatus':'unavailable','receiptId':f'cold-{i}'}}
 assert accounting._store(ctx) is False, 'process memory must never claim disk durability'
 return i

class ColdStartTests(unittest.TestCase):
 def setUp(self):
  with accounting._schema_lock:
   accounting._receipt_cache.clear();accounting._receipt_bytes=0
 def test_concurrent_receipts_exactly_once_and_no_state_files(self):
  with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{'TP_USAGE_STATE_FILE':temp+'/state.sqlite','TP_USAGE_REQUIRED':'1','TP_USAGE_RECEIPTS':'on'}):
   barrier=threading.Barrier(16)
   def work(i):barrier.wait();return write_receipt(i)
   with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
    self.assertEqual(set(pool.map(work,range(16))),set(range(16)))
   for i in range(16):write_receipt(i)
   with accounting._schema_lock:
    self.assertEqual(set(accounting._receipt_cache),{f'cold-{i}' for i in range(16)})
    self.assertEqual(accounting._receipt_bytes,sum(len(x.encode()) for x in accounting._receipt_cache.values()))
   self.assertEqual(list(Path(temp).iterdir()),[])
 def test_fresh_process_does_not_restore_receipts(self):
  with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{'TP_USAGE_STATE_FILE':temp+'/state.sqlite','TP_USAGE_RECEIPTS':'on'}):
   write_receipt(1)
   env={**os.environ,'PYTHONPATH':str(ROOT/'api')}
   child=subprocess.run([sys.executable,'-c','from backend.ai import accounting; assert len(accounting._receipt_cache)==0; print("restart-empty")'],env=env,capture_output=True,text=True,timeout=10)
   self.assertEqual(child.returncode,0,child.stderr);self.assertEqual(child.stdout.strip(),'restart-empty')
   self.assertIn('cold-1',accounting._receipt_cache)
   self.assertEqual(list(Path(temp).iterdir()),[])
 def test_receipt_cache_eviction_stays_bounded(self):
  with patch.dict(os.environ,{'TP_USAGE_RECEIPTS':'on'}),patch.object(accounting,'MAX_RECEIPTS',3):
   for i in range(8):write_receipt(i)
  self.assertEqual(list(accounting._receipt_cache),['cold-5','cold-6','cold-7'])

if __name__=='__main__':unittest.main(verbosity=2)
