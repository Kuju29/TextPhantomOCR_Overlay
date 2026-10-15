""".79 HF log 2026-10-13: "RuntimeError: No response returned." (Starlette, client closed
the request before the route answered) was logged as an internal 500 error. It is a
client disconnect: answer 499 and do not log a server error. A real RuntimeError still raises."""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.api import middleware


class FakeURL:
    path = '/v2/engine/runsextension/ai/translate'


class FakeRequest:
    def __init__(self, disconnected):
        self.url, self.method, self.headers, self._d = FakeURL(), 'POST', {}, disconnected

    async def is_disconnected(self):
        return self._d


async def gone(_request):
    raise RuntimeError('No response returned.')


class Disconnect(unittest.TestCase):
    def run_mw(self, request, call_next):
        return asyncio.run(middleware.access_log_middleware(request, call_next))

    def test_disconnect_is_499_without_error_event(self):
        events = []
        with patch.object(middleware, 'event', lambda *a, **k: events.append(a)), \
                patch.object(middleware, 'request_correlation', lambda r: {}):
            response = self.run_mw(FakeRequest(True), gone)
        self.assertEqual(response.status_code, 499)
        self.assertEqual(events, [])

    def test_runtime_error_with_connected_client_still_raises(self):
        with patch.object(middleware, 'event', lambda *a, **k: None), \
                patch.object(middleware, 'request_correlation', lambda r: {}):
            with self.assertRaises(RuntimeError):
                self.run_mw(FakeRequest(False), gone)

            async def other(_request):
                raise RuntimeError('boom')
            with self.assertRaises(RuntimeError):
                self.run_mw(FakeRequest(True), other)


if __name__ == '__main__':
    unittest.main(verbosity=1)
