import os, sys, unittest
sys.path.insert(0, 'api')
from backend.config import Settings, lens_concurrency_limit

class LensConcurrencyPolicyTests(unittest.TestCase):
    def test_default_remote_ceiling_prevents_cold_burst_overfanout(self):
        old={k:os.environ.get(k) for k in ('SERVER_MAX_WORKERS','TP_SYNC_MAX_CONCURRENCY','TP_LENS_UPSTREAM_MAX_CONCURRENCY')}
        try:
            os.environ['SERVER_MAX_WORKERS']='15';os.environ.pop('TP_SYNC_MAX_CONCURRENCY',None);os.environ.pop('TP_LENS_UPSTREAM_MAX_CONCURRENCY',None)
            cfg=Settings();self.assertEqual(cfg.lens_upstream_max_concurrency,8);self.assertEqual(lens_concurrency_limit(cfg),8)
            os.environ['TP_LENS_UPSTREAM_MAX_CONCURRENCY']='4';self.assertEqual(lens_concurrency_limit(Settings()),4)
            os.environ['TP_SYNC_MAX_CONCURRENCY']='3';self.assertEqual(lens_concurrency_limit(Settings()),3)
        finally:
            for key,value in old.items():
                if value is None:os.environ.pop(key,None)
                else:os.environ[key]=value

if __name__=='__main__':unittest.main()
