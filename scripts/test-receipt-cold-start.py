"""Concurrent first-use SQLite initialization, no provider calls or charges."""
from __future__ import annotations
import concurrent.futures, json, multiprocessing, os, sqlite3, sys, tempfile, threading, unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
ROOT=Path(os.environ.get('TP_TEST_ROOT',Path(__file__).resolve().parents[1])).resolve()
sys.path.insert(0,str(ROOT/'api'))
from backend.ai import accounting

def write_receipt(i):
    ctx={'receiptId':f'cold-{i}', 'createdMs':1,'provider':'fixture','model':'fixture',
         'endpoint':'http://fixture','phase':'initial','state':'dispatch_intent_usage_pending',
         'usage':{'usageStatus':'unavailable','receiptId':f'cold-{i}'}}
    assert accounting._store(ctx)
    return i

def write_process(args):
    path,first=args
    os.environ['TP_USAGE_STATE_FILE']=path;os.environ['TP_USAGE_REQUIRED']='1';os.environ['TP_USAGE_RECEIPTS']='on'
    return [write_receipt(first+i) for i in range(8)]

class ColdStartTests(unittest.TestCase):
    def verify(self,path,expected):
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute('select count(*) from provider_usage').fetchone()[0],expected)
            self.assertEqual(db.execute('pragma journal_mode').fetchone()[0],'wal')
            self.assertEqual(db.execute('pragma integrity_check').fetchone()[0],'ok')
    def test_three_cold_databases_with_sixteen_threads(self):
        with tempfile.TemporaryDirectory() as temp:
            for run in range(3):
                path=Path(temp)/f'{run}.sqlite';barrier=threading.Barrier(16)
                def work(i):barrier.wait();return write_receipt(i)
                with patch.dict(os.environ,{'TP_USAGE_STATE_FILE':str(path),'TP_USAGE_REQUIRED':'1','TP_USAGE_RECEIPTS':'on'}),concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
                    self.assertEqual(len(set(pool.map(work,range(16)))),16)
                self.verify(path,16)
    def test_four_api_processes_share_first_use_database(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'processes.sqlite'
            with concurrent.futures.ProcessPoolExecutor(max_workers=4,mp_context=multiprocessing.get_context('spawn')) as pool:
                list(pool.map(write_process,[(str(path),i*8) for i in range(4)]))
            self.verify(path,32)

if __name__=='__main__':unittest.main()
