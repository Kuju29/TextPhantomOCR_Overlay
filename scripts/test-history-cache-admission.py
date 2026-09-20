"""LRU admission of FINISHED workflows under aggregate-history pressure."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.translation_paths import store as memory


def history(text):
    return [{'user': text, 'assistant': 'answer'}]


def chars(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')))


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.db = memory.Store()
        self.value = history('same-size')
        self.size = chars(self.value)
        self.limit = patch.object(memory, 'MAX_TOTAL_HISTORY_CHARS', self.size * 3)
        self.limit.start()
        self.addCleanup(self.limit.stop)

    def commit(self, key, value=None):
        lease = self.db.try_acquire(key)
        self.assertIsNotNone(lease)
        lease.history = copy.deepcopy(self.value if value is None else value)
        self.assertTrue(self.db.release(lease, commit=True))
        # These LRU tests model completed, lifecycle-managed workflows. Unmanaged
        # or live workflows are covered by test-release-hardening.py and protected.
        self.db._rows[key]["managed"] = True
        return lease

    def bound(self):
        self.assertLessEqual(sum(row['chars'] for row in self.db._rows.values()), memory.MAX_TOTAL_HISTORY_CHARS)

    def test_new_scope_admitted_after_old_idle_below_scope_limit(self):
        for key in ('old', 'middle', 'recent'):
            self.assertEqual(self.commit(key).commit_status, 'committed')
        self.assertLess(len(self.db._rows), memory.MAX_SESSIONS)
        self.db._rows['old']['updated'] = 1
        self.db._rows['middle']['updated'] = 2
        self.db._rows['recent']['updated'] = 3
        self.assertEqual(self.commit('new').commit_status, 'committed')
        self.assertEqual(set(self.db._rows), {'middle', 'recent', 'new'})
        self.bound()
        # Cache admission keeps progressing across successive fresh scopes.
        self.assertEqual(self.commit('newer').commit_status, 'committed')
        self.assertNotIn('middle', self.db._rows)
        self.bound()

    def test_evicts_only_enough_idle_lru_histories(self):
        for i, key in enumerate(('old', 'middle', 'recent'), 1):
            self.commit(key)
            self.db._rows[key]['updated'] = i
        incoming = history('x' * (self.size + 5))
        self.assertGreater(chars(incoming), self.size)
        self.assertLessEqual(chars(incoming), self.size * 2)
        self.assertEqual(self.commit('new', incoming).commit_status, 'committed')
        self.assertEqual(set(self.db._rows), {'recent', 'new'})
        self.bound()

    def test_active_other_scope_is_not_evicted(self):
        for key in ('active', 'idle', 'recent'):
            self.commit(key)
        active = self.db.try_acquire('active')
        self.db._rows['active']['updated'] = 0
        self.db._rows['idle']['updated'] = 1
        self.db._rows['recent']['updated'] = 2
        before = copy.deepcopy(self.db._rows['active'])
        self.assertEqual(self.commit('new').commit_status, 'committed')
        self.assertEqual(self.db._rows['active'], before)
        self.assertNotIn('idle', self.db._rows)
        self.assertIsNone(self.db.try_acquire('active'))
        self.db.release(active)
        self.bound()

    def test_active_pressure_rejects_without_pointless_idle_eviction(self):
        for key in ('active1', 'active2', 'idle'):
            self.commit(key)
        self.db.try_acquire('active1')
        self.db.try_acquire('active2')
        before = copy.deepcopy(self.db._rows)
        oversized_for_remaining = history('x' * self.size)
        self.assertGreater(chars(oversized_for_remaining), self.size)
        rejected = self.commit('new', oversized_for_remaining)
        self.assertEqual(rejected.commit_status, 'history_storage_limit')
        for key in before:
            self.assertEqual(self.db._rows[key], before[key])
        self.assertEqual(self.db._rows['new']['history'], [])
        self.assertIsNone(self.db._rows['new']['active'])
        self.bound()

    def test_current_history_preserved_when_growth_cannot_fit(self):
        for key in ('current', 'active', 'idle'):
            self.commit(key)
        self.db.try_acquire('active')
        current = self.db.try_acquire('current')
        original = copy.deepcopy(self.db._rows['current'])
        other = copy.deepcopy(self.db._rows['idle'])
        current.history = history('x' * (self.size * 2))
        self.assertTrue(self.db.release(current, commit=True))
        self.assertEqual(current.commit_status, 'history_storage_limit')
        self.assertEqual(self.db._rows['current']['history'], original['history'])
        self.assertEqual(self.db._rows['current']['revision'], original['revision'])
        self.assertEqual(self.db._rows['idle'], other)
        self.bound()

    def test_per_history_limit_rejects_without_evicting_others(self):
        self.commit('old')
        old = copy.deepcopy(self.db._rows['old'])
        with patch.object(memory, 'MAX_HISTORY_CHARS', self.size - 1):
            result = self.commit('new')
        self.assertEqual(result.commit_status, 'history_storage_limit')
        self.assertEqual(self.db._rows['old'], old)
        self.bound()

    def test_payload_larger_than_aggregate_does_not_evict_idle(self):
        self.commit('old')
        old = copy.deepcopy(self.db._rows['old'])
        result = self.commit('new', history('x' * memory.MAX_TOTAL_HISTORY_CHARS))
        self.assertEqual(result.commit_status, 'history_storage_limit')
        self.assertEqual(self.db._rows['old'], old)
        self.bound()

    def test_expired_victim_old_completion_is_fenced(self):
        for key in ('expired', 'middle', 'recent'):
            self.commit(key)
        stale = self.db.try_acquire('expired')
        self.db._rows['expired'].update(until=0, updated=0)
        self.assertEqual(self.commit('new').commit_status, 'committed')
        self.assertNotIn('expired', self.db._rows)
        before = copy.deepcopy(self.db._rows)
        self.assertFalse(self.db.release(stale, commit=True))
        self.assertEqual(stale.commit_status, 'stale_lease_not_committed')
        self.assertEqual(self.db._rows, before)
        self.bound()

    def test_stale_commit_never_evicts_idle(self):
        for key in ('current', 'idle', 'recent'):
            self.commit(key)
        stale = self.db.try_acquire('current')
        self.db._rows['current']['until'] = 0
        replacement = self.db.try_acquire('current')
        before = copy.deepcopy(self.db._rows)
        stale.history = history('x' * self.size)
        self.assertFalse(self.db.release(stale, commit=True))
        self.assertEqual(self.db._rows, before)
        self.db.release(replacement)


if __name__ == '__main__':
    unittest.main(verbosity=2)
