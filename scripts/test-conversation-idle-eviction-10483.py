""".83 multi-user API: one full conversation store must not block everyone.

Before .83, 256 retained Conversation scopes (or 16M chars of history) made every
new conversation on the API fail with ai_conversation_capacity / history_storage_limit
until a restart, because unmanaged scopes with history were never released.
Now a scope nobody used for IDLE_EVICT_SECONDS may give way under pressure only;
live leases, active repair workflows and recently used scopes are still protected,
and the evicted scope's next request is labelled history_evicted.
"""
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.translation_paths import store as memory
from backend import diagnostic_schema


def run(db, key, text='history'):
    lease = db.try_acquire(key)
    lease.history = [{'user': text, 'assistant': 'answer'}]
    lease.dirty = True
    lease.close(True)
    return lease


class IdleEviction(unittest.TestCase):
    def setUp(self):
        self.db = memory.Store()

    def age(self, key, seconds):
        self.db._rows[key]['updated'] = time.monotonic() - seconds

    def test_full_store_admits_new_scope_by_evicting_oldest_idle(self):
        with patch.object(memory, 'MAX_SESSIONS', 3):
            for key in ('a', 'b', 'c'):
                run(self.db, key)
            with self.assertRaises(memory.ConversationError) as ctx:
                self.db.try_acquire('d')
            self.assertEqual(ctx.exception.code, 'ai_conversation_capacity', 'recent history stays protected')
            self.age('a', memory.IDLE_EVICT_SECONDS + 5)
            self.age('b', memory.IDLE_EVICT_SECONDS + 50)
            d = self.db.try_acquire('d')
            self.assertEqual(d.reason, 'ready')
            d.close(False)
            self.assertEqual(set(self.db._rows), {'a', 'c', 'd'}, 'only the longest-idle scope gave way')
            self.age('a', memory.IDLE_EVICT_SECONDS + 5)
            again = self.db.try_acquire('b')
            self.assertEqual(again.reason, 'history_evicted')
            self.assertEqual((again.revision, again.history), (0, []))
            again.close(False)

    def test_live_lease_is_never_evicted_even_when_old(self):
        with patch.object(memory, 'MAX_SESSIONS', 2):
            run(self.db, 'a')
            live = self.db.try_acquire('b')
            self.age('b', memory.IDLE_EVICT_SECONDS * 10)
            self.age('a', memory.IDLE_EVICT_SECONDS + 1)
            c = self.db.try_acquire('c')
            c.close(False)
            self.assertIn('b', self.db._rows)
            self.assertNotIn('a', self.db._rows)
            live.close(False)

    def test_total_history_limit_uses_idle_scopes(self):
        run(self.db, 'old', 'x' * 400)
        run(self.db, 'recent', 'x' * 400)
        self.age('old', memory.IDLE_EVICT_SECONDS + 1)
        total = sum(r['chars'] for r in self.db._rows.values())
        with patch.object(memory, 'MAX_TOTAL_HISTORY_CHARS', total + 50):
            new = run(self.db, 'new', 'x' * 400)
        self.assertEqual(new.commit_status, 'committed')
        self.assertEqual(set(self.db._rows), {'recent', 'new'})

    def test_idle_blocked_scope_can_start_over(self):
        lease = self.db.try_acquire('a')
        lease.history = [{'user': 'x' * 50, 'assistant': 'y'}]
        with patch.object(memory, 'MAX_TOTAL_HISTORY_CHARS', 10):
            self.db.release(lease, commit=True)
        self.assertTrue(self.db._rows['a'].get('blocked'))
        with patch.object(memory, 'MAX_SESSIONS', 1):
            self.age('a', memory.IDLE_EVICT_SECONDS + 1)
            other = self.db.try_acquire('b')
            other.close(False)
        self.assertNotIn('a', self.db._rows)

    def test_expired_notes_are_bounded(self):
        with patch.object(memory, 'MAX_EXPIRED_NOTES', 4):
            for i in range(10):
                self.db._rows[f'k{i}'] = {'history': [], 'prefix': '', 'revision': 0, 'active': None,
                                          'until': 0, 'updated': 0, 'chars': 0}
                self.db._drop(f'k{i}')
            self.assertEqual(list(self.db._expired), ['k6', 'k7', 'k8', 'k9'])

    def test_diagnostic_schema_accepts_history_evicted(self):
        out = diagnostic_schema.sanitize_conversation({'schema': 'tp.conversation/1', 'scopeStatus': 'history_evicted'})
        self.assertEqual(out['scopeStatus'], 'history_evicted')
        js = (Path(__file__).resolve().parents[1] / 'src/shared/diagnostic-schema.js').read_text(encoding='utf-8')
        self.assertIn('"expired_lane_recovered","history_evicted"', js)


if __name__ == '__main__':
    unittest.main()
