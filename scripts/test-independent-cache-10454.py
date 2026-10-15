"""Independent accepted-example/result-cache races at the actual job boundary.

Run: python scripts/test-independent-cache-10454.py
No provider, image decoder, filesystem image, account, or live network is used.
Only image processing is fictional; config parsing, private store, cache keys,
LRU copy semantics, cache admission, cancellation and process_payload are real.

--legacy-content-digest deliberately restores the former content-only cache
identity for a red regression proof; it does not load an immutable release.
"""
import copy
import hashlib
import json
import os
from contextlib import ExitStack, contextmanager
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

os.environ.setdefault('TP_USAGE_RECEIPTS', 'off')
os.environ.setdefault('TP_AI_WIRE_TRACE', '0')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))

from backend.ai.translation_paths import independent_examples as examples
from backend.jobs import cache, pipeline
from backend.jobs.stages.config import build_ai_config, layout_options

LEGACY = '--legacy-content-digest' in sys.argv
if LEGACY:
    sys.argv.remove('--legacy-content-digest')

A = [{'src': 'Hero', 'tgt': 'ฮีโร่'}]
B = [{'src': 'Hero', 'tgt': 'วีรบุรุษ'}]
IMAGE = b'fictional-image-no-decoder'


@contextmanager
def fictional_image_file(*_args):
    yield '/fictional-image-not-opened.png'


def legacy_snapshot(ai, target):
    if not examples.enabled(ai):
        return {'signature': '', 'busy': False}
    key = examples.store.key(ai, target)
    # Restore the content-only identity that cannot distinguish A -> B -> A.
    with examples.store.condition:
        row = examples.store.rows.get(key)
        return {'signature': hashlib.sha256(json.dumps(
            [key, examples.store.pairs(key) if key else []],
            sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
            'busy': bool(row and row['queue'])}


class IndependentCacheTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(examples, 'store', examples.Store()))
        self.lru = cache.LruCache(16)
        self.stack.enter_context(patch.object(cache, 'ai_result_cache', self.lru))
        self.stack.enter_context(patch.object(pipeline, 'temporary_image_file', fictional_image_file))
        self.stack.enter_context(patch.object(pipeline, 'event'))
        self.payload = {
            'mode': 'lens_text', 'source': 'ai', 'lang': 'th',
            'context': {'tp_tab_session': 'fictional-tab',
                        'page_url': 'https://fictional.invalid/chapter#story'},
            'metadata': {'batch_id': 'fictional-batch'},
            'ai': {'provider': 'lmstudio', 'model': 'fictional-model',
                   'base_url': 'http://127.0.0.1:1234', 'api_key': '',
                   'prompt': 'Fictional translation style',
                   'translation_mode': 'independent', 'style_examples': True},
        }
        self.cfg = build_ai_config(self.payload, 'lens_text', 'ai')
        self.scope_key = examples.store.key(self.cfg, 'th')
        self.assertTrue(self.scope_key)
        self.image_hook = None
        self.render_hook = None
        self.render_calls = 0
        self.cancelled = False
        self.stack.enter_context(patch.object(pipeline.cancellation, 'is_cancelled',
                                             side_effect=lambda _payload: self.cancelled))
        self.stack.enter_context(patch.object(pipeline, 'extract_image_bytes', side_effect=self.image))
        self.stack.enter_context(patch.object(pipeline, 'process_image', side_effect=self.render))
        if LEGACY:
            self.stack.enter_context(patch.object(examples, 'cache_snapshot', legacy_snapshot))

    def image(self, _payload):
        if self.image_hook:
            self.image_hook()
        return IMAGE, 'image/png'

    def render(self, _path, target, _mode, cfg, **_kwargs):
        self.render_calls += 1
        if self.render_hook:
            self.render_hook(cfg)
        chosen = examples.selection(cfg, target, 'Hero')
        text = json.dumps(chosen['pairs'], ensure_ascii=False)
        return {'Ai': {'aihtml': '<div>fictional overlay</div>', 'meta': {}},
                'selected_examples': text}

    def update(self, pairs):
        ticket = examples.store.register(self.scope_key)
        examples.store.release(self.scope_key, ticket, pairs, True)

    def key(self, payload=None):
        payload = payload or self.payload
        cfg = build_ai_config(payload, 'lens_text', 'ai')
        return cache.build_cache_key(pipeline.sha256_hex(IMAGE), 'th', 'lens_text', 'ai', cfg,
            layout=layout_options(payload), owner_scope='fictional-admission')

    def run_job(self, payload=None):
        return pipeline.process_payload(payload or self.payload,
                                        admission_identity='fictional-admission')

    def test_stable_context_hits_and_returns_an_independent_copy(self):
        self.update(A)
        first = self.run_job()
        first['Ai']['aihtml'] = 'caller modification'
        second = self.run_job()
        self.assertEqual(second['perf']['cache'], 'hit')
        self.assertEqual(self.render_calls, 1)
        self.assertEqual(second['Ai']['aihtml'], '<div>fictional overlay</div>')
        self.assertEqual(json.loads(second['selected_examples']), A)

    def test_image_io_change_uses_the_lookup_snapshot_for_both_key_and_admission(self):
        self.update(A)
        self.image_hook = lambda: self.update(B)
        result = self.run_job()
        self.assertEqual(json.loads(result['selected_examples']), B)
        self.assertEqual(self.lru.get(self.key())['selected_examples'], result['selected_examples'])

    def test_pool_change_after_lookup_cannot_write_under_the_previous_context(self):
        self.update(A)
        old_key = self.key()
        self.render_hook = lambda _cfg: self.update(B)
        result = self.run_job()
        self.assertEqual(json.loads(result['selected_examples']), B)
        self.assertIsNone(self.lru.get(old_key))
        self.assertEqual(len(self.lru._store), 0)

    def test_content_aba_cannot_reuse_a_previous_cache_identity(self):
        self.update(A)
        before = self.key()
        def cycle(_cfg):
            self.update(B)
            self.update(A)
        self.render_hook = cycle
        self.run_job()
        self.assertEqual(examples.store.pairs(self.scope_key), A)
        self.assertIsNone(self.lru.get(before), 'A -> B -> A must invalidate the earlier cache context')
        self.assertNotEqual(before, self.key())

    def test_busy_predecessor_does_not_get_bypassed_by_a_cached_overlay(self):
        self.update(A)
        old = self.run_job()
        old_key = self.key()
        predecessor = examples.store.register(self.scope_key)
        def preceding_commit(cfg):
            examples.store.release(self.scope_key, predecessor, B, True)
            # Use the same private lane as the real AI stage after concurrent OCR.
            with examples.execution_scope(cfg, 'th'):
                self.assertEqual(examples.selection(cfg, 'th', 'Hero')['pairs'], B)
        self.render_hook = preceding_commit
        current = self.run_job()
        self.assertEqual(self.render_calls, 2, 'pending predecessor must suppress the cache hit')
        self.assertEqual(json.loads(current['selected_examples']), B)
        self.assertEqual(self.lru.get(old_key)['selected_examples'], old['selected_examples'])
        self.assertEqual(len(self.lru._store), 1, 'new output cannot be stored under the old context')

    def test_recreated_scope_cannot_replay_its_previous_cached_overlay(self):
        self.update(A)
        self.run_job()
        before = self.key()
        examples.store.clear()
        self.update(A)
        self.assertNotEqual(before, self.key(), 'same pair bytes in a new scope lifetime must miss')
        self.run_job()
        self.assertEqual(self.render_calls, 2)

    def test_failed_and_cancelled_processing_publish_no_overlay(self):
        self.update(A)
        def failed(_cfg):
            raise RuntimeError('fictional render failure')
        self.render_hook = failed
        with self.assertRaisesRegex(RuntimeError, 'fictional render failure'):
            self.run_job()
        self.assertEqual(len(self.lru._store), 0)
        self.render_hook = lambda _cfg: setattr(self, 'cancelled', True)
        with self.assertRaisesRegex(RuntimeError, 'cancelled'):
            self.run_job()
        self.assertEqual(len(self.lru._store), 0)

    def test_disabled_examples_do_not_consume_or_wait_for_private_pool(self):
        self.payload['ai']['style_examples'] = False
        with patch.object(examples.store, 'key', side_effect=AssertionError('disabled private-pool lookup')):
            first = self.run_job()
            second = self.run_job()
        self.assertEqual(json.loads(first['selected_examples']), [])
        self.assertEqual(second['perf']['cache'], 'hit')
        self.assertEqual(self.render_calls, 1)

    def test_batch_and_target_example_keys_remain_private(self):
        self.update(A)
        first_key = self.key()
        changed = copy.deepcopy(self.payload)
        changed['metadata']['batch_id'] = 'different-fictional-batch'
        self.assertNotEqual(first_key, self.key(changed))
        signature = examples.cache_signature(self.cfg, 'th')
        self.assertNotEqual(signature, examples.cache_signature(self.cfg, 'ja'))
        for private in ('fictional-tab', 'fictional-batch', 'fictional.invalid', 'Hero', 'ฮีโร่'):
            self.assertNotIn(private, signature)
            self.assertNotIn(private, first_key)


if __name__ == '__main__':
    unittest.main(verbosity=2)
