""".78 Login relay evidence (owner log 2026-10-13 08:04-08:07: ChatGPT/Claude sign-in
looped with "relay unavailable" / "sign-in expired" and no reason in the logs).

- A not-ready chatgpt.com tab returns its reason (e.g. chat box missing) and the API
  shows a message that says what to fix, instead of losing it to a timeout.
- A website request that timed out in the tab is reported as a timeout.
- Every relay result is logged with provider, error and reason; a late answer is visible.
Offline; no accounts."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
sys.path.insert(0, str(ROOT / 'scripts'))
from backend.ai.login import login_provider_chatgpt as chatgpt
from backend.ai.login import login_routes as routes
from backend.ai.login import login_observability as observability
from backend.ai.login.endpoint import login_browser_relay as relay
from backend.ai.login.endpoint import login_endpoint_http as endpoint
from backend.ai.login.login_provider_contract import LoginError

import importlib.util
spec = importlib.util.spec_from_file_location('chatgpt10477', ROOT / 'scripts' / 'test-login-chatgpt-browser-10477.py')
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
Pump, WEBSITE = base.Pump, base.WEBSITE


class NotReady(unittest.TestCase):
    def test_reason_reaches_the_person(self):
        for detail, words in (('login_composer_missing', 'chat box was not found'),
                              ('login_inject_failed', 'could not run in the chatgpt.com tab'),
                              ('unknown_code', 'was not ready')):
            with self.subTest(detail=detail), Pump(lambda job, d=detail: {'error': 'not_ready', 'detail': d}):
                with self.assertRaises(LoginError) as raised:
                    chatgpt.endpoint_validate(WEBSITE, lambda: None)
            self.assertEqual(raised.exception.code, 'login_provider_not_ready')
            self.assertIn(words, str(raised.exception))

    def test_timeout_is_reported_as_timeout(self):
        with Pump(lambda job: {'error': 'timeout', 'detail': 'login_page_fetch_timeout'}):
            with self.assertRaises(LoginError) as raised:
                chatgpt.endpoint_validate(WEBSITE, lambda: None)
        self.assertEqual(raised.exception.code, 'login_endpoint_timeout')

    def test_detail_is_a_code_never_website_text(self):
        self.assertEqual(endpoint.relay_detail({'detail': 'login_composer_missing'}), 'login_composer_missing')
        for bad in ('<b>x</b>', 'Sign in now', 'a' * 60, None, 5):
            self.assertEqual(endpoint.relay_detail({'detail': bad}), '')


class ResultRoute(unittest.TestCase):
    def test_input_accepts_new_codes_and_rejects_text(self):
        routes.RelayResultInput(id='lrj_' + 'b' * 48, error='not_ready', detail='login_composer_missing')
        routes.RelayResultInput(id='lrj_' + 'b' * 48, error='timeout', detail='login_page_fetch_timeout')
        with self.assertRaises(Exception):
            routes.RelayResultInput(id='lrj_' + 'b' * 48, error='not_ready', detail='Please sign in')

    def test_trace_keeps_relay_evidence(self):
        written = []
        with patch.object(observability.trace, 'write', lambda *a, **k: written.append(a[4])):
            with observability.context('login_chatgpt', 'endpoint_import', 'trace'):
                observability.emit('relay_result', relayAccepted=False, relayProvider='login_chatgpt_web',
                                   relayError='not_ready', relayDetail='login_composer_missing', relayWaitMs=20000.4,
                                   transport='browser_relay')
        row = written[-1]
        self.assertEqual((row['relayAccepted'], row['relayProvider'], row['relayError'], row['relayDetail'], row['relayWaitMs']),
                         (False, 'login_chatgpt_web', 'not_ready', 'login_composer_missing', 20000))

    def test_job_provider_only_for_the_owner(self):
        relay.clear()
        with relay.owner('owner-a'):
            import threading
            seen = {}
            def claim():
                import time
                for _ in range(200):
                    job = relay.take('owner-a')
                    if job:
                        seen['mine'] = relay.job_provider('owner-a', job['id'])
                        seen['foreign'] = relay.job_provider('owner-b', job['id'])
                        relay.complete('owner-a', job['id'], {'status': 200, 'body': json.dumps({'ready': True, 'account': 'a' * 64})})
                        return
                    time.sleep(.005)
            thread = threading.Thread(target=claim); thread.start()
            relay.submit({'provider': 'login_chatgpt_web', 'method': 'WEBCHAT', 'path': '/', 'webchat': {}}, lambda: None)
            thread.join(2)
        self.assertEqual(seen, {'mine': 'login_chatgpt_web', 'foreign': ''})
        self.assertEqual(relay.job_provider('owner-a', 'lrj_' + 'c' * 48), '')


if __name__ == '__main__':
    unittest.main(verbosity=1)
