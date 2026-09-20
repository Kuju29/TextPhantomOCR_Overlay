"""Offline process-lifetime state, isolation and concurrency regression checks."""
import asyncio
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.translation_paths import store as conversations
from backend.application.repair_pool import store as repair
from backend.application.repair_pool import state
from backend.ai import accounting, rategate

class TemporaryStateTests(unittest.TestCase):
    def test_no_state_file_io_even_with_legacy_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            legacy = Path(folder) / 'old.sqlite'
            legacy.write_bytes(b'old user bytes')
            with patch.dict(os.environ, {'TP_CONVERSATION_STATE_FILE':str(legacy),
                    'TP_REPAIR_STATE_FILE':str(legacy), 'TP_USAGE_STATE_FILE':str(legacy),
                    'TP_RATE_STATE_FILE':str(legacy), 'TP_USAGE_RECEIPTS':'on'}), \
                 patch('sqlite3.connect', side_effect=AssertionError('unexpected SQLite')), \
                 patch.object(Path, 'mkdir', side_effect=AssertionError('unexpected mkdir')), \
                 patch.object(Path, 'read_text', side_effect=AssertionError('unexpected read')), \
                 patch.object(Path, 'write_text', side_effect=AssertionError('unexpected write')):
                db=conversations.Store(legacy);lease=db.try_acquire(db.key('owner'))
                lease.history=[{'user':'hello','assistant':'สวัสดี'}];db.release(lease,commit=True)
                pool=repair.RepairStore(legacy);pool.register('run','a'*64,['p'],'caller')
                self.assertEqual(pool.read('run','a'*64)['id'],'run')
                accounting._store({'receiptId':'no-disk','usage':{'totalTokens':17}})
                gate=rategate.RateGate();self.assertEqual(gate._load_state(),{})
                gate._state_dirty=True;gate._save_state(force=True)
                self.assertEqual(gate.persistence()['storage'],'process_memory')
            self.assertEqual(legacy.read_bytes(),b'old user bytes')
            self.assertEqual(list(Path(folder).iterdir()),[legacy])

    def test_restart_does_not_restore_any_store(self):
        program='''import json,sys
from backend.ai.translation_paths.store import Store
from backend.application.repair_pool.store import RepairStore
from backend.application.repair_pool.state import PoolError
from backend.ai import accounting,rategate
s=Store(sys.argv[1]);lease=s.try_acquire("fixed-key")
p=RepairStore(sys.argv[1]);missing=False
try:p.read("run","a"*64)
except PoolError:missing=True
print(json.dumps([len(lease.history),missing,len(accounting._receipt_cache),rategate.RateGate()._load_state()]))
lease.history=[{"user":"private","assistant":"answer"}];s.release(lease,commit=True)
p.register("run","a"*64,["p"],"caller")
accounting._store({"receiptId":"one","usage":{"totalTokens":9}})
'''
        with tempfile.TemporaryDirectory() as folder:
            for _ in range(2):
                done=subprocess.run([sys.executable,'-c',program,str(Path(folder)/'state.db')],
                    capture_output=True,text=True,env={**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]/'api')})
                self.assertEqual(done.returncode,0,done.stderr)
                self.assertEqual(json.loads(done.stdout),[0,True,0,{}])
            self.assertEqual(list(Path(folder).iterdir()),[])

    def test_live_conversation_capacity_never_evicts_active_scope(self):
        with patch.object(conversations,'MAX_SESSIONS',2):
            db=conversations.Store();a=db.try_acquire('a');b=db.try_acquire('b')
            with self.assertRaises(conversations.ConversationError):db.try_acquire('c')
            self.assertEqual(len(db._rows),2)
            db.release(a);c=db.try_acquire('c')
            self.assertIsNone(db.try_acquire('b'))
            self.assertEqual(set(db._rows),{'b','c'})
            db.release(b);db.release(c)

    def test_conversation_aggregate_bound_and_stale_fence(self):
        db=conversations.Store();a=db.try_acquire('a')
        a.history=[{'user':'x'*50,'assistant':'y'}]
        with patch.object(conversations,'MAX_TOTAL_HISTORY_CHARS',10):
            db.release(a,commit=True)
        self.assertEqual(a.commit_status,'history_storage_limit')
        with self.assertRaises(conversations.ConversationError) as blocked:
            db.try_acquire('a')
        self.assertEqual(blocked.exception.code, 'ai_conversation_history_capacity')
        # A failed history commit is fenced; exercise stale-lease recovery on a
        # separate healthy scope rather than resuming with missing history.
        db=conversations.Store()
        old=db.try_acquire('a');db._rows['a']['until']=0
        new=db.try_acquire('a');old.history=[{'user':'stale','assistant':'stale'}]
        self.assertFalse(db.release(old,commit=True))
        new.history=[{'user':'fresh','assistant':'fresh'}];db.release(new,commit=True)
        self.assertEqual(db.try_acquire('a').history[0]['user'],'fresh')

    def test_notification_and_independent_scope(self):
        db=conversations.Store();first=db.try_acquire('same')
        begun=threading.Event();done=threading.Event()
        def waiter():
            begun.set();db.wait_available('same',10);done.set()
        with concurrent.futures.ThreadPoolExecutor(1) as workers:
            future=workers.submit(waiter);self.assertTrue(begun.wait(1))
            other=db.try_acquire('unrelated');self.assertIsNotNone(other)
            self.assertFalse(done.is_set());db.release(first)
            self.assertTrue(done.wait(1));future.result();db.release(other)

    def test_async_notification_no_executor_waiters(self):
        async def run():
            db=conversations.Store();lease=db.try_acquire('same')
            with patch('asyncio.to_thread',side_effect=AssertionError('wait must not occupy thread')):
                pending=asyncio.create_task(db.async_wait_available('same',10))
                await asyncio.sleep(0)
                db.release(lease)
                await asyncio.wait_for(pending,1)
                self.assertEqual(len(db._async_waiters),0)
        asyncio.run(run())

    def test_repair_capacity_ownership_and_rollback(self):
        db=repair.RepairStore()
        with patch.object(repair,'MAX_RUNS',2),patch.object(repair,'MAX_CALLER_RUNS',1):
            db.register('a','a'*64,['p'],'callerA')
            with self.assertRaisesRegex(state.PoolError,'capacity'):db.register('b','b'*64,['p'],'callerA')
            db.register('b','b'*64,['p'],'callerB')
            with self.assertRaisesRegex(state.PoolError,'capacity'):db.register('c','c'*64,['p'],'callerC')
            with self.assertRaisesRegex(state.PoolError,'not_found'):db.read('a','b'*64)
            before=db.read('a','a'*64)
            def invalid(run):
                run['phase']='bad'
                raise ValueError('rollback')
            with self.assertRaises(ValueError):db.transact('a','a'*64,invalid)
            self.assertEqual(db.read('a','a'*64),before)
            db.delete('a','a'*64);db.register('c','c'*64,['p'],'callerC')
            self.assertEqual(len(db._runs),2)

    def test_receipt_cache_bound_and_optional_failure(self):
        with accounting._schema_lock:
            accounting._receipt_cache.clear();accounting._receipt_bytes=0
        with patch.dict(os.environ,{'TP_USAGE_RECEIPTS':'on','TP_USAGE_REQUIRED':'0'}), \
             patch.object(accounting,'MAX_RECEIPTS',3),patch.object(accounting,'MAX_RECEIPT_CACHE_BYTES',80):
            for i in range(10):accounting._store({'receiptId':str(i),'usage':{'totalTokens':i}})
            self.assertLessEqual(len(accounting._receipt_cache),3)
            self.assertLessEqual(accounting._receipt_bytes,80)
            self.assertFalse(accounting._store({'receiptId':'invalid','usage':{'x':float('nan')}}))
        with patch.dict(os.environ,{'TP_USAGE_REQUIRED':'1'}):
            self.assertFalse(accounting._store({'receiptId':'billed','dispatched':True,'usage':{'x':float('nan')}}))

if __name__=='__main__':unittest.main(verbosity=2)
