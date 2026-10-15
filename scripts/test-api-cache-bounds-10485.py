""".10485 API in-memory caches are bounded: model capability scopes, font coverage cache, cancellation marks."""
import sys
import time
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai import provider_resolution as resolution
from backend.render import fonts
from backend import cancellation


class Bounds(unittest.TestCase):
    def test_capability_scopes_lru_by_freshness(self):
        resolution._MODEL_CAPABILITIES.clear()
        saved = resolution.MAX_CAPABILITY_SCOPES
        resolution.MAX_CAPABILITY_SCOPES = 5
        try:
            for i in range(8):
                resolution.remember_model_capabilities('openai', 'https://api.test', f'key-{i}', {'m': {}}, models=['m'])
                time.sleep(0.001)
            self.assertEqual(len(resolution._MODEL_CAPABILITIES), 5)
            kept = {resolution._capability_scope('openai', 'https://api.test', f'key-{i}') for i in range(3, 8)}
            self.assertEqual(set(resolution._MODEL_CAPABILITIES), kept, 'least recently refreshed scopes evicted')
        finally:
            resolution.MAX_CAPABILITY_SCOPES = saved
            resolution._MODEL_CAPABILITIES.clear()

    def test_font_coverage_cache_is_lru_bounded(self):
        fonts._coverage_cache.clear()
        saved = fonts._COVERAGE_CACHE_MAX
        fonts._COVERAGE_CACHE_MAX = 3
        try:
            for i in range(5):
                fonts._coverage_put(('f', f'text:{i}'), True)
            self.assertEqual(list(fonts._coverage_cache), [('f', 'text:2'), ('f', 'text:3'), ('f', 'text:4')])
            self.assertTrue(fonts._coverage_get(('f', 'text:2')))
            fonts._coverage_put(('f', 'text:5'), False)
            self.assertNotIn(('f', 'text:3'), fonts._coverage_cache, 'touched entry survives, oldest goes')
            self.assertIs(fonts._coverage_get(('f', 'text:5')), False, 'a cached False is a hit, not a miss')
            self.assertFalse(fonts._font_supports_text('/nonexistent/font.ttf', 'abc'))
        finally:
            fonts._COVERAGE_CACHE_MAX = saved
            fonts._coverage_cache.clear()

    def test_cancellation_marks_capped(self):
        cancellation._batches.clear()
        saved = cancellation._MAX_BATCHES
        cancellation._MAX_BATCHES = 3
        try:
            for i in range(5):
                cancellation.mark_batch(f'b{i}', 's')
            self.assertEqual(len(cancellation._batches), 3)
            self.assertFalse(cancellation.is_cancelled({'batch_id': 'b0', 'tp_tab_session': 's'}))
            self.assertTrue(cancellation.is_cancelled({'batch_id': 'b4', 'tp_tab_session': 's'}))
        finally:
            cancellation._MAX_BATCHES = saved
            cancellation._batches.clear()


if __name__ == '__main__':
    unittest.main()
