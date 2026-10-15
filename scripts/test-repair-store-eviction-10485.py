""".10485 API repair store: terminal runs expire after 1 h idle, full store evicts terminal then idle runs
(oldest first), per-caller cap reclaims the caller's own old runs, active runs are never evicted."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.application.repair_pool import state as s
from backend.application.repair_pool import store as store_module
from backend.application.repair_pool.store import RepairStore


def tok(i):
    return f'{i:064x}'


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


class EvictionTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.db = RepairStore(now=self.clock)
        self.saved = (store_module.MAX_RUNS, store_module.MAX_CALLER_RUNS)
        store_module.MAX_RUNS, store_module.MAX_CALLER_RUNS = 4, 3

    def tearDown(self):
        store_module.MAX_RUNS, store_module.MAX_CALLER_RUNS = self.saved

    def reg(self, i, caller='c'):
        return self.db.register(f'r{i}', tok(i), ['p'], caller)

    def cancel(self, i):
        self.db.transact(f'r{i}', tok(i), s.cancel)

    def test_terminal_run_expires_after_one_hour_idle(self):
        self.reg(1)
        self.cancel(1)
        self.clock.t += store_module.TERMINAL_IDLE - 1
        self.assertTrue(self.db.is_cancelled('r1', tok(1)))  # still present, and this use refreshes it
        self.clock.t += store_module.TERMINAL_IDLE
        with self.assertRaisesRegex(s.PoolError, 'repair_run_not_found'):
            self.db.read('r1', tok(1))

    def test_active_runs_are_never_evicted(self):
        for i in range(4):
            self.reg(i, caller=f'c{i}')
        with self.assertRaises(s.PoolError) as ctx:
            self.reg(9, caller='new')
        self.assertEqual(str(ctx.exception), 'repair_store_capacity')
        self.assertEqual(ctx.exception.status, 503)
        for i in range(4):
            self.db.read(f'r{i}', tok(i))

    def test_full_store_evicts_terminal_then_oldest_idle(self):
        for i in range(4):
            self.reg(i, caller=f'c{i}')
            self.clock.t += 10
        self.cancel(2)
        self.reg(10, caller='x')  # takes the cancelled run's slot
        with self.assertRaisesRegex(s.PoolError, 'repair_run_not_found'):
            self.db.read('r2', tok(2))
        self.clock.t += store_module.IDLE_EVICT
        self.db.read('r3', tok(3))  # r3 used recently: active
        self.reg(11, caller='y')  # evicts the oldest idle run: r0
        with self.assertRaisesRegex(s.PoolError, 'repair_run_not_found'):
            self.db.read('r0', tok(0))
        self.db.read('r1', tok(1))
        self.db.read('r3', tok(3))

    def test_per_caller_cap_reclaims_own_old_runs_only(self):
        for i in range(3):
            self.reg(i, caller='same')
        self.reg(5, caller='other')
        self.cancel(5)
        with self.assertRaisesRegex(s.PoolError, 'repair_store_capacity'):
            self.reg(6, caller='same')  # own runs all active; another caller's run is not taken for the caller cap
        self.cancel(0)
        self.reg(6, caller='same')
        with self.assertRaisesRegex(s.PoolError, 'repair_run_not_found'):
            self.db.read('r0', tok(0))
        self.assertTrue(self.db.is_cancelled('r5', tok(5)))

    def test_hard_ttl_matches_extension_checkpoint_ttl(self):
        self.assertEqual(store_module.TTL, 6 * 60 * 60)
        self.reg(1)
        self.clock.t += store_module.TTL + 1
        self.assertEqual(self.db.active_workflows({'r1'}), set())


if __name__ == '__main__':
    unittest.main()
