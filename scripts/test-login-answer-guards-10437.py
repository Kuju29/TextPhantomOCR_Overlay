"""Exercise actual Login run dispatch, policy failures and account admission."""
import os
import json
import sys
import time
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, Lock
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.login.endpoint import login_endpoint_runs as runs
from backend.ai.login.login_provider_contract import LoginError


def request(run='run', operation='op', source='<<I1_P0:Hello>>'):
    return SimpleNamespace(cache_context={'webchatRunId': run, 'operationId': operation,
        'conversationSource': source}, image_b64='', user_parts=[source],
        system_text='Translate to Thai using the same IDs.', model='session/web-default',
        history_messages=[], cancel_check=None)


class AnswerGuards(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        runs.clear()
        self.session = {'id': 'session', 'provider': 'login_gemini', 'credential': 'credential'}
        self.credential = patch.object(runs.store, 'credential_for_session',
            return_value={'tokens': {'credentials': {}}})
        self.active = patch.object(runs.store, 'active_session_ids', return_value={'session'})
        self.env = patch.dict(os.environ, {'TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS': '25'})
        self.credential.start(); self.active.start(); self.env.start()

    def tearDown(self):
        self.credential.stop(); self.active.stop(); self.env.stop(); runs.clear()

    def module(self, text, calls):
        def generate(credentials, prompt, remote, model, check, dispatch):
            dispatch(); calls.append(prompt); remote['thread'] = 'thread'
            return {'text': text, 'completed': True, 'statuses': [200], 'terminal': 'test'}
        return SimpleNamespace(endpoint_generate=generate)

    def test_policy_refusal_is_terminal_and_never_resent(self):
        calls = []
        module = self.module("I can help with many kinds of requests, but it appears this one would go against my guidelines. Is there something else I can try for you?", calls)
        with self.assertRaises(LoginError) as caught:
            runs.generate(self.session, request(), module)
        self.assertEqual(caught.exception.code, 'login_content_refused')
        self.assertTrue(caught.exception.requestDispatched)
        with self.assertRaises(LoginError):
            runs.generate(self.session, request(operation='repair'), module)
        self.assertEqual(len(calls), 1)


    async def test_real_translation_route_refusal_has_no_content_repair(self):
        import httpx
        from fastapi import FastAPI
        from backend.api.routes.ai_v1 import router
        from backend.ai.login import login_translation as adapter
        from backend.ai.provider_registry import provider_registry
        if provider_registry.get('login') is None:
            provider_registry.register(adapter.SPEC)
        session = {'id': 'http-session', 'provider': 'login_gemini', 'credential': 'http-credential'}
        selected = {'id': 'web-default', 'model_capabilities': {
            'vision': {'supported': False}, 'reasoning': {'supported': False},
            'limits': {'contextTokens': 32768, 'maxOutputTokens': 8192}}}
        calls = []
        def generate(credentials, prompt, remote, model, check, dispatch):
            dispatch(); calls.append(prompt); remote['thread'] = 'http-thread'
            return {'text': "I'm sorry, it appears I can't help with this particular request, as it may go against my guidelines.",
                'completed': True, 'statuses': [200], 'terminal': 'test'}
        module = SimpleNamespace(endpoint_generate=generate)
        from backend.jobs.admission import AdmissionGate
        app = FastAPI(); app.include_router(router)
        app.state.ai_admission_gate = AdmissionGate(4, max_waiters=16, max_wait_sec=3)
        app.state.ai_executor = None
        runs.clear()
        with patch.object(adapter, 'authorize_model', return_value=('owner', session, 'web-default')), \
                patch.object(adapter, 'selected_model', return_value=selected), \
                patch.object(adapter.login_profiles, 'model_list', return_value=[selected]), \
                patch.object(adapter.native, 'module', return_value=module), \
                patch.object(runs.store, 'active_session_ids', return_value={'http-session'}), \
                patch.object(runs.store, 'credential_for_session', return_value={'tokens': {
                    'transport': 'web_endpoint', 'credentials': {}}}), \
                patch.dict(os.environ, {'TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS': '0', 'TP_AI_WIRE_TRACE': '0'}):
            payload = {'schema': 'tp.ai.request/1', 'operationId': 'http-policy-op',
                'translationMode': 'independent', 'conversation': {'webchatRunId': 'http-run'},
                'units': [{'id': 'P0', 'text': 'Hello'}], 'targetLang': 'th',
                'provider': {'id': 'login', 'model': 'http-session/web-default', 'apiKey': 'fixture', 'thinking': 'default'},
                'memory': {'mode': 'off'}, 'repair': {'owner': 'extension', 'enabled': False}}
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                result = await client.post('/v2/engine/runsextension/login/translate', json=payload)
                self.assertEqual(result.status_code, 422, result.text)
                detail = result.json()['detail']
                self.assertEqual(detail['code'], 'login_content_refused')
                self.assertEqual(detail['category'], 'policy')
                self.assertTrue(detail['requestDispatched'])
                self.assertFalse(detail['retryable'])
                self.assertFalse(detail['automaticContentRetry'])
                self.assertEqual(detail['generationAttempts'], 1)
                payload.update(operationId='http-repair-op', repair={'owner': 'extension', 'branch': 'repair', 'enabled': False})
                repeated = await client.post('/v2/engine/runsextension/login/translate', json=payload)
                # .83: the stopped run reports the refusal that stopped it (was a bare 409 cancelled).
                self.assertEqual(repeated.status_code, 422, repeated.text)
                self.assertEqual(repeated.json()['detail']['code'], 'login_content_refused')
                self.assertFalse(repeated.json()['detail']['requestDispatched'])
                self.assertEqual(len(calls), 1)
        runs.clear()

    def test_literal_refusal_in_translation_record_is_not_policy_failure(self):
        calls = []
        text = '<<I1_P0:I cannot help with that request because it violates my guidelines.>>'
        result = runs.generate(self.session, request(), self.module(text, calls))
        self.assertEqual(result['text'], text)

    def test_quoted_markers_outside_records_do_not_hide_refusal(self):
        for marker in ('<<I23_P0:', '<<I23_P0:source>>'):
            with self.subTest(marker=marker):
                calls = []
                run = 'quoted-' + str(len(marker))
                text = 'I cannot help because this violates safety guidelines. The request begins with ' + marker
                with self.assertRaises(LoginError) as caught:
                    runs.generate(self.session, request(run=run), self.module(text, calls))
                self.assertEqual(caught.exception.code, 'login_content_refused')
                with self.assertRaises(LoginError):
                    runs.generate(self.session, request(run=run, operation='repair'), self.module(text, calls))
                self.assertEqual(len(calls), 1)

    def test_normal_answer_is_idempotent_and_continuation_has_no_bootstrap(self):
        calls = []
        module = self.module('<<I1_P0:สวัสดี>>', calls)
        first = runs.generate(self.session, request(), module)
        self.assertEqual(runs.generate(self.session, request(), module), first)
        runs.generate(self.session, request(operation='next', source='<<I1_P1:Goodbye>>'), module)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[-1], '<<I1_P1:Goodbye>>')

    def test_separate_runs_of_same_account_are_serialized_and_spaced(self):
        barrier = Barrier(2); lock = Lock(); events = []; active = 0; peak = 0
        def generate(credentials, prompt, remote, model, check, dispatch):
            nonlocal active, peak
            dispatch()
            with lock:
                active += 1; peak = max(peak, active); events.append(time.monotonic())
            time.sleep(.015)
            with lock: active -= 1
            remote['thread'] = prompt
            return {'text': '<<I1_P0:สวัสดี>>', 'completed': True, 'statuses': [200], 'terminal': 'test'}
        module = SimpleNamespace(endpoint_generate=generate)
        def worker(run):
            barrier.wait()
            return runs.generate(self.session, request(run=run), module)
        with ThreadPoolExecutor(max_workers=2) as executor:
            list(executor.map(worker, ['a', 'b']))
        self.assertEqual(peak, 1, 'Same provider account must not have overlapping chat turns')
        self.assertGreaterEqual(events[1] - events[0], .025)

    def test_opt_in_wire_trace_retains_answer_without_credentials(self):
        from backend.ai import wire_trace
        scratch = Path(__file__).resolve().parents[3] / 'test-tmp'
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch, ignore_cleanup_errors=True) as temp, patch.dict(os.environ, {
                'TP_AI_WIRE_TRACE': '1', 'TP_AI_WIRE_TRACE_DIR': temp}):
            identity = {'traceId': 'answer-trace', 'operationId': 'op'}
            token = wire_trace.begin(identity)
            try:
                runs.generate(self.session, request(), self.module('<<I1_P0:สวัสดี>>', []))
            finally:
                wire_trace.end(token)
            artifacts = list(Path(temp).rglob('05_provider_response.assembled.txt'))
            self.assertEqual(len(artifacts), 1)
            self.assertEqual(artifacts[0].read_text(encoding='utf-8'), '<<I1_P0:สวัสดี>>')
            metadata = json.loads(artifacts[0].with_name('05_provider_response.meta.json').read_text())
            self.assertEqual(metadata['status'], 200)
            self.assertTrue(metadata['streamed'])
            self.assertTrue(metadata['complete'])
            evidence = json.loads(artifacts[0].with_name('05_login_endpoint_evidence.json').read_text())
            self.assertEqual(evidence['httpStatuses'], [200])
            self.assertTrue(evidence['terminalCompleted'])
            self.assertEqual(evidence['terminal'], 'test')

    def test_429_retry_after_spaces_next_operation_without_replaying(self):
        events = []
        def generate(credentials, prompt, remote, model, check, dispatch):
            dispatch(); events.append(time.monotonic())
            if len(events) == 1:
                error = LoginError('login_quota_exceeded', 'Wait', 429)
                error.retry_after_ms = 60
                raise error
            return {'text': '<<I1_P0:สวัสดี>>', 'completed': True, 'statuses': [200], 'terminal': 'test'}
        module = SimpleNamespace(endpoint_generate=generate)
        with self.assertRaises(LoginError):
            runs.generate(self.session, request(run='first'), module)
        runs.generate(self.session, request(run='next'), module)
        self.assertGreaterEqual(events[1] - events[0], .06)
        self.assertEqual(len(events), 2)

    def test_cancellation_during_spacing_never_dispatches(self):
        calls = []
        module = self.module('<<I1_P0:สวัสดี>>', calls)
        runs.generate(self.session, request(run='first'), module)
        next_request = request(run='next')
        began = time.monotonic()
        next_request.cancel_check = lambda: time.monotonic() - began >= .01
        with self.assertRaises(LoginError) as caught:
            runs.generate(self.session, next_request, module)
        self.assertEqual(caught.exception.code, 'login_cancelled')
        self.assertFalse(caught.exception.requestDispatched)
        self.assertEqual(len(calls), 1)

    def test_pages_after_a_failed_sent_turn_show_that_failure_not_cancelled(self):
        # .83 owner: after the first real failure every remaining image showed
        # LOGIN_CANCELLED; they now carry the failure that stopped the run.
        calls = []
        def generate(credentials, prompt, remote, model, check, dispatch):
            dispatch(); calls.append(1)
            raise LoginError('login_endpoint_timeout', 'The claude.ai tab did not run the request.', 504)
        module = SimpleNamespace(endpoint_generate=generate)
        with self.assertRaises(LoginError) as first:
            runs.generate(self.session, request(run='same', operation='a'), module)
        self.assertEqual(first.exception.code, 'login_endpoint_timeout')
        with self.assertRaises(LoginError) as later:
            runs.generate(self.session, request(run='same', operation='b'), module)
        self.assertEqual(later.exception.code, 'login_endpoint_timeout')
        self.assertEqual(later.exception.status, 504)
        self.assertIn('An earlier page of this run failed', str(later.exception))
        self.assertFalse(later.exception.requestDispatched)
        self.assertEqual(len(calls), 1, 'nothing more is sent to the website')

    def test_user_cancel_is_still_cancelled(self):
        calls = []
        module = self.module('<<I1_P0:สวัสดี>>', calls)
        stopped = request(run='user-stop', operation='a')
        stopped.cancel_check = lambda: True
        with self.assertRaises(LoginError) as caught:
            runs.generate(self.session, stopped, module)
        self.assertEqual(caught.exception.code, 'login_cancelled')


if __name__ == '__main__':
    unittest.main()
