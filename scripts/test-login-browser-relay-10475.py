""".75 browser relay: owner isolation, one claim, deadlines, cancellation and the
same status decisions as the API's own HTTPS path. Offline; no accounts."""
import asyncio
import base64
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
from backend.ai.login import login_routes as routes, login_session_store as store
from backend.ai.login import login_provider_claude as claude
from backend.ai.login.endpoint import login_browser_relay as relay
from backend.ai.login.endpoint import login_endpoint_http as endpoint
from backend.ai.login.endpoint import login_endpoint_session as flows
from backend.ai.login.login_provider_contract import LoginError


def pump(scope, answer, stop, seen=None):
    """A fake extension: claims this owner's jobs and answers them."""
    while not stop.is_set():
        job = relay.take(scope)
        if job is None:
            time.sleep(.01)
            continue
        if seen is not None:
            seen.append(job)
        relay.complete(scope, job['id'], answer(job))


class Broker(unittest.TestCase):
    def setUp(self):
        relay.clear()

    def run_with_pump(self, answer, *, scope='owner-a', pump_scope=None, check=lambda: None, **kw):
        stop, seen = threading.Event(), []
        thread = threading.Thread(target=pump, args=(pump_scope or scope, answer, stop, seen), daemon=True)
        thread.start()
        try:
            with relay.owner(scope):
                return relay.submit({'provider': 'login_claude', 'method': 'GET', 'path': '/api/bootstrap'}, check, **kw), seen
        finally:
            stop.set(); thread.join(1)

    def test_job_is_answered_by_the_same_owner(self):
        (result, waited), seen = self.run_with_pump(lambda job: {'status': 200, 'body': '{}'})
        self.assertEqual(result['status'], 200)
        self.assertEqual(len(seen), 1)
        self.assertRegex(seen[0]['id'], r'^lrj_[a-f0-9]{48}$')
        self.assertGreaterEqual(waited, 0)
        self.assertEqual(relay._jobs, {}, 'finished jobs are removed')

    def test_other_owner_never_sees_the_job(self):
        with self.assertRaises(relay.RelayUnavailable):
            self.run_with_pump(lambda job: {'status': 200, 'body': '{}'}, pump_scope='owner-b', claim_timeout=.3)

    def test_without_owner_scope_nothing_is_queued(self):
        with self.assertRaises(relay.RelayUnavailable):
            relay.submit({'path': '/'}, lambda: None, claim_timeout=.1)
        self.assertEqual(relay._jobs, {})

    def test_claimed_once_and_late_or_foreign_results_are_dropped(self):
        ids = []
        def answer(job):
            ids.append(job['id'])
            self.assertFalse(relay.complete('owner-b', job['id'], {'status': 500}), 'foreign owner cannot answer')
            self.assertIsNone(relay.take('owner-a'), 'a claimed job is not handed out twice')
            return {'status': 200, 'body': 'ok'}
        (result, _), _ = self.run_with_pump(answer)
        self.assertEqual(result['body'], 'ok')
        self.assertFalse(relay.complete('owner-a', ids[0], {'status': 200}), 'late result after finish is dropped')

    def test_claimed_but_unanswered_job_times_out(self):
        stop = threading.Event()
        def claim_only():
            while not stop.is_set():
                if relay.take('owner-a'):
                    return
                time.sleep(.01)
        thread = threading.Thread(target=claim_only, daemon=True); thread.start()
        try:
            with relay.owner('owner-a'), self.assertRaises(relay.RelayTimeout):
                relay.submit({'path': '/'}, lambda: None, claim_timeout=1, job_timeout=.4)
        finally:
            stop.set(); thread.join(1)

    def test_claimed_job_tells_the_extension_how_long_the_api_waits(self):
        # .82: the extension stops its own work in time to report the reason.
        seen, stop = [], threading.Event()
        worker = threading.Thread(target=pump, args=('owner-a', lambda job: {'status': 200, 'body': '{}'}, stop, seen))
        worker.start()
        try:
            with relay.owner('owner-a'):
                relay.submit({'path': '/'}, lambda: None, claim_timeout=2, job_timeout=30)
        finally:
            stop.set(); worker.join()
        left = seen[0]['expires_in_ms']
        self.assertTrue(25000 < left <= 30000, left)

    def test_cancellation_while_waiting_removes_the_job(self):
        calls = []
        def check():
            calls.append(1)
            if len(calls) > 3:
                raise LoginError('login_cancelled', 'cancelled', 409)
        with relay.owner('owner-a'), self.assertRaises(LoginError):
            relay.submit({'path': '/'}, check, claim_timeout=5)
        self.assertEqual(relay._jobs, {})
        self.assertIsNone(relay.take('owner-a'))


class RelayHTTP(unittest.TestCase):
    """EndpointHTTP keeps one status/body decision for both transports."""
    def setUp(self):
        relay.clear()
        self.emit = patch.object(endpoint.diagnostic, 'emit'); self.emit.start()
        self.stage = patch.object(endpoint.diagnostic, 'stage'); self.stage.start()

    def tearDown(self):
        self.emit.stop(); self.stage.stop()

    def call(self, result, **kw):
        jobs = []
        def submit(job, check, **_):
            jobs.append(job)
            return result, 1.0
        with patch.object(relay, 'submit', side_effect=submit), endpoint.EndpointHTTP('login_claude', {}) as http:
            return http.request(kw.pop('path', '/api/bootstrap'), **kw), jobs

    def error(self, result, **kw):
        with self.assertRaises(LoginError) as caught:
            self.call(result, **kw)
        return caught.exception

    def test_json_and_sse_bodies(self):
        data, jobs = self.call({'status': 200, 'content_type': 'application/json', 'body': '{"a": 1}'})
        self.assertEqual(data, {'a': 1})
        self.assertEqual(jobs[0], {'provider': 'login_claude', 'method': 'GET', 'path': '/api/bootstrap',
                                   'accept': 'application/json', 'expected': 'json'})
        raw, _ = self.call({'status': 200, 'content_type': 'text/event-stream', 'body': 'data: {}\n\n'}, expected='sse')
        self.assertEqual(raw, b'data: {}\n\n')

    def test_query_and_multipart_are_plain_json(self):
        _, jobs = self.call({'status': 200, 'content_type': 'application/json', 'body': '{}'},
                            path='/edge-api/bootstrap/org-1/app_start', params={'a': 'b c', 'x': '1'})
        self.assertEqual(jobs[0]['path'], '/edge-api/bootstrap/org-1/app_start?a=b+c&x=1')
        _, jobs = self.call({'status': 200, 'content_type': 'application/json', 'body': '{}'}, path='/api/org-1/upload',
                            method='POST', form={'orgUuid': 'org-1'}, files={'file': ('page.png', b'\x89PNG', 'image/png')})
        part = jobs[0]['multipart']
        self.assertEqual(part['fields'], {'orgUuid': 'org-1'})
        self.assertEqual(base64.b64decode(part['file']['base64']), b'\x89PNG')
        json.dumps(jobs[0])

    def test_query_in_path_is_refused(self):
        self.assertEqual(self.error({}, path='/api/bootstrap?x=1').code, 'login_provider_contract')

    def test_same_decisions_as_https(self):
        cases = [
            ({'status': 403, 'content_type': 'text/html', 'headers': {'cf-mitigated': 'challenge'}, 'body': '<html>'}, 'login_endpoint_challenge_required'),
            ({'status': 403, 'content_type': 'application/json', 'body': '{"type":"error"}'}, 'login_provider_access_denied'),
            ({'status': 401, 'content_type': 'application/json', 'body': '{}'}, 'login_session_expired'),
            ({'status': 429, 'content_type': 'application/json', 'headers': {'retry-after': '7'}, 'body': '{}'}, 'login_quota_exceeded'),
            # 10493: a website server error (5xx) is the provider's temporary failure.
            ({'status': 500, 'content_type': 'application/json', 'body': '{}'}, 'login_provider_temporarily_unavailable'),
            ({'status': 418, 'content_type': 'application/json', 'body': '{}'}, 'login_endpoint_rejected'),
            ({'status': 200, 'content_type': 'text/html', 'body': '<html>'}, 'login_endpoint_response_invalid'),
        ]
        for result, code in cases:
            with self.subTest(code=code):
                error = self.error(result)
                self.assertEqual(error.code, code)
                self.assertEqual(error.upstream_status, result['status'])
                self.assertEqual(error.endpoint_step, 'claude_identity')
        self.assertEqual(self.error(cases[3][0]).retry_after_ms, 7000)

    def test_tab_errors_have_explicit_codes(self):
        for name, code in (('tab_unavailable', 'login_browser_relay_unavailable'), ('signed_out', 'login_session_expired'),
                           ('network', 'login_endpoint_transport_failed'), ('not_allowed', 'login_provider_contract'),
                           ('anything-else', 'login_endpoint_transport_failed')):
            with self.subTest(name=name):
                self.assertEqual(self.error({'error': name}).code, code)

    def test_timeout_reason_names_the_part_that_did_not_finish(self):
        # .82: the extension now answers before the API deadline with what stalled.
        script = self.error({'error': 'timeout', 'detail': 'login_tab_script_timeout'})
        self.assertEqual(script.code, 'login_endpoint_timeout')
        self.assertIn('claude.ai tab did not run the request', str(script))
        page = self.error({'error': 'timeout', 'detail': 'login_page_fetch_timeout'})
        self.assertIn('claude.ai did not finish this answer in time', str(page))
        plain = self.error({'error': 'timeout'})
        self.assertIn('did not answer in time', str(plain))

    def test_no_extension_and_timeout(self):
        def unavailable(*a, **k):
            raise relay.RelayUnavailable()
        def late(*a, **k):
            raise relay.RelayTimeout()
        for side, code in ((unavailable, 'login_browser_relay_unavailable'), (late, 'login_endpoint_timeout')):
            with patch.object(relay, 'submit', side_effect=side), endpoint.EndpointHTTP('login_claude', {}) as http, \
                    self.assertRaises(LoginError) as caught:
                http.request('/api/bootstrap')
            self.assertEqual(caught.exception.code, code)

    def test_dispatch_is_marked_before_the_relay_is_asked(self):
        order = []
        def submit(job, check, **_):
            order.append('relay')
            return {'error': 'network'}, 1.0
        with patch.object(relay, 'submit', side_effect=submit), endpoint.EndpointHTTP('login_claude', {}) as http, \
                self.assertRaises(LoginError) as caught:
            http.request('/api/organizations/o/chat_conversations/c/completion', method='POST', body={},
                         expected='sse', dispatch=lambda: order.append('dispatch'))
        self.assertEqual(order, ['dispatch', 'relay'])
        self.assertEqual(caught.exception.stage, 'endpoint_submit')

    def test_oversized_and_malformed_results(self):
        self.assertEqual(self.error({'status': 'x', 'body': ''}).code, 'login_endpoint_response_invalid')
        self.assertEqual(self.error({'status': 200, 'body': 1}).code, 'login_endpoint_response_invalid')
        with patch.object(endpoint, 'MAX_BYTES', 4):
            self.assertEqual(self.error({'status': 200, 'content_type': 'application/json', 'body': '{"aaaa":1}'}).code,
                             'login_endpoint_response_invalid')

    def test_other_providers_keep_https(self):
        with patch.object(relay, 'submit') as submit, patch.object(endpoint.httpx, 'Client') as client:
            stream = client.return_value.stream.return_value.__enter__.return_value
            stream.status_code, stream.headers = 200, {'content-type': 'application/json'}
            stream.iter_bytes.return_value = [b'{}']
            with endpoint.EndpointHTTP('login_deepseek', {}) as http:
                self.assertEqual(http.request('/api/v0/users/current'), {})
            submit.assert_not_called()


class ClaudeImportUsesOwnerScope(unittest.TestCase):
    def setUp(self):
        relay.clear(); flows.clear(); store.clear()
        self.patches = [patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage')]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        flows.clear(); store.clear()

    def test_import_jobs_go_to_the_importing_owner_only(self):
        import hashlib
        owner = 'fixture-owner'
        scope = store.owner_scope(owner)
        answers = {
            '/api/bootstrap': {'account': {'uuid': 'acct-1', 'lastActiveOrgId': 'org-1'}},
            '/api/organizations': [{'uuid': 'org-1'}],
        }
        def answer(job):
            path = job['path'].split('?')[0]
            body = answers.get(path, {'claude_ai_available_models': {'models': [{'model_id': 'claude-x'}]}})
            return {'status': 200, 'content_type': 'application/json', 'body': json.dumps(body)}
        stop, seen = threading.Event(), []
        thread = threading.Thread(target=pump, args=(scope, answer, stop, seen), daemon=True); thread.start()
        try:
            flow = flows.start(owner, 'login_claude')
            result = flows.complete(owner, 'login_claude', flow['flow_id'], flow['state'], 'b' * 48,
                                    hashlib.sha256(b'acct-1\0org-1').hexdigest(), {'organization': 'org-1'}, lambda: owner)
        finally:
            stop.set(); thread.join(1)
        self.assertEqual(result['status'], 'connected')
        self.assertEqual([job['path'].split('?')[0] for job in seen],
                         ['/api/bootstrap', '/api/organizations', '/edge-api/bootstrap/org-1/app_start'])
        stored = store.credential_for_session(store.get(result['session']['id'], owner))['tokens']['credentials']
        self.assertEqual(stored, {'organization': 'org-1'}, 'no website session is stored by the API')

    def test_old_extension_payload_is_refused_before_any_request(self):
        flow = flows.start('fixture-owner', 'login_claude')
        with patch.object(relay, 'submit') as submit, self.assertRaises(LoginError) as caught:
            flows.complete('fixture-owner', 'login_claude', flow['flow_id'], flow['state'], 'b' * 48, '0' * 64,
                           {'session_key': 'old', 'organization': 'org-1'}, lambda: 'fixture-owner')
        self.assertEqual(caught.exception.code, 'login_reconnect_required')
        submit.assert_not_called()


class Routes(unittest.TestCase):
    def setUp(self):
        relay.clear(); routes._relay_owner_cache.clear()
        self.auth = patch.object(routes.login_entitlement, 'authorize', return_value='route-owner'); self.auth.start()

    def tearDown(self):
        self.auth.stop(); relay.clear(); routes._relay_owner_cache.clear()

    def request(self):
        async def disconnected():
            return False
        return SimpleNamespace(headers={'authorization': 'Bearer ' + 'x' * 48}, is_disconnected=disconnected,
                               state=SimpleNamespace())

    def test_poll_hands_out_the_owner_job_and_result_completes_it(self):
        scope = store.owner_scope('route-owner')
        out = {}
        def waiter():
            with relay.owner(scope):
                out['result'] = relay.submit({'provider': 'login_claude', 'method': 'GET', 'path': '/api/bootstrap'},
                                             lambda: None, claim_timeout=3)
        thread = threading.Thread(target=waiter, daemon=True); thread.start()
        response = asyncio.run(routes.relay_poll(routes.RelayPollInput(wait_ms=3000), self.request()))
        job = json.loads(response.body)['job']
        self.assertEqual(job['path'], '/api/bootstrap')
        result = routes.RelayResultInput(id=job['id'], status=200, content_type='application/json', body='{}',
                                         headers={'cf-mitigated': 'x'})
        accepted = json.loads(asyncio.run(routes.relay_result(result, self.request())).body)
        thread.join(2)
        self.assertTrue(accepted['accepted'])
        self.assertEqual(out['result'][0]['status'], 200)
        # The Center check is cached for the pump's next long poll.
        self.assertEqual(routes.login_entitlement.authorize.call_count, 1)

    def test_empty_poll_returns_no_job(self):
        response = asyncio.run(routes.relay_poll(routes.RelayPollInput(wait_ms=100), self.request()))
        self.assertEqual(json.loads(response.body), {'ok': True, 'job': None})

    def test_unknown_or_foreign_result_is_not_accepted(self):
        result = routes.RelayResultInput(id='lrj_' + '0' * 48, status=200)
        self.assertFalse(json.loads(asyncio.run(routes.relay_result(result, self.request())).body)['accepted'])

    def test_result_validation(self):
        with self.assertRaises(Exception):
            routes.RelayResultInput(id='bad', status=200)
        with self.assertRaises(Exception):
            routes.RelayResultInput(id='lrj_' + '0' * 48, error='made_up')


if __name__ == '__main__':
    unittest.main()
