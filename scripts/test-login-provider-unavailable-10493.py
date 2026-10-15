""".92 owner report (10493): a Login website's own server failure must read as
"<site>'s server is temporarily unavailable", owned by the provider and
retryable, never as an unknown cause or a TextPhantom configuration fault.

Evidence of the report: DeepSeek /api/v0/chat/completion answered HTTP 200 in
~0.3 s and was rejected as an unreadable reply; the opt-in wire capture keeps
no provider body, so its exact content is unknown. The sibling pages of the
same run then failed in 1 s without sending, labelled stage "entitlement",
origin api / category configuration (owner textphantom, severity error).

Offline: fictional HTTP routes and endpoint modules; no account, network or
secrets. No provider text is asserted from the report because none was kept.
"""
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
from fastapi import HTTPException  # noqa: E402
from backend.ai.login.endpoint import login_endpoint_http as endpoint  # noqa: E402
from backend.ai.login.endpoint import login_endpoint_runs as runs  # noqa: E402
from backend.ai.login import login_provider_deepseek as deepseek  # noqa: E402
from backend.ai.login import login_provider_claude as claude  # noqa: E402
from backend.ai.login import login_provider_chatgpt as chatgpt  # noqa: E402
from backend.ai.login import login_observability as diagnostic  # noqa: E402
from backend.ai.login.login_provider_contract import LoginError  # noqa: E402
from backend.api.errors import classify_failure  # noqa: E402
from backend.application.ai_translation.provider_errors import raise_execution_error  # noqa: E402

real_client = httpx.Client
SECRET = 'private-fixture-token'
BODY_SECRET = 'private-body-text'
TEMPORARY = 'login_provider_temporarily_unavailable'


def deepseek_turn(completion):
    """Run DeepSeek's real generate path; only the completion reply varies."""
    calls = []

    def handle(request):
        calls.append(request.url.path)
        if request.url.path == '/api/v0/chat_session/create':
            return httpx.Response(200, json={'code': 0, 'data': {'biz_code': 0, 'biz_data': {'id': 'fixture_session'}}})
        if request.url.path == '/api/v0/chat/create_pow_challenge':
            return httpx.Response(200, json={'code': 0, 'data': {'biz_code': 0, 'biz_data': {'challenge': {}}}})
        return completion(request)
    with patch.object(endpoint.httpx, 'Client', side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw)), \
            patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage'), \
            patch.object(deepseek.diagnostic, 'stage'), patch.object(deepseek, 'proof', return_value='fixture-proof'):
        try:
            deepseek.endpoint_generate({'token': SECRET}, 'fixture prompt', {}, 'web-default', lambda: None, lambda: calls.append('dispatched'))
        except LoginError as error:
            return error, calls
    raise AssertionError('expected a typed Login failure')


def translate_error(error):
    ctx = SimpleNamespace(unit_count=1, trace_id='fixture-trace', correlation={}, requested_route='fixture', route_identity={})
    with patch('backend.application.ai_translation.provider_errors.trace_failure'), \
            patch('backend.application.ai_translation.provider_errors.failure_event'):
        try:
            raise_execution_error(ctx, error, rate_wait_ms=0, admission_wait_ms=0, provider_ms=0)
        except HTTPException as value:
            return value.detail
    raise AssertionError('expected a public translation failure')


class ProviderServerFailure(unittest.TestCase):
    def test_deepseek_server_errors_are_provider_temporary_not_unknown(self):
        for status in (500, 502, 503, 504):
            with self.subTest(status=status):
                error, calls = deepseek_turn(lambda request: httpx.Response(
                    status, content=BODY_SECRET.encode(), headers={'content-type': 'text/plain', 'retry-after': '9'}))
                self.assertEqual(error.code, TEMPORARY)
                self.assertEqual(str(error), "DeepSeek's server is temporarily unavailable. Try again later.")
                self.assertEqual(error.status, 503)
                self.assertIs(error.retryable, True)
                self.assertEqual(error.retry_after_ms, 9000)
                self.assertEqual(error.upstream_status, status)
                self.assertEqual(error.endpoint_step, 'deepseek_completion')
                self.assertEqual(error.provider_reason, 'provider_server_error')
                self.assertEqual(calls.count('/api/v0/chat/completion'), 1, 'never replayed automatically')
                self.assertNotIn(BODY_SECRET, str(error))
                self.assertNotIn(SECRET, str(error))

    def test_server_error_before_sending_is_also_the_providers(self):
        def handle(request):
            return httpx.Response(503, content=b'', headers={'content-type': 'text/plain'})
        with patch.object(endpoint.httpx, 'Client', side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw)), \
                patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage'):
            with self.assertRaises(LoginError) as caught:
                with endpoint.EndpointHTTP('login_deepseek', {}) as http:
                    http.request('/api/v0/chat_session/create', method='POST', body={})
        self.assertEqual(caught.exception.code, TEMPORARY)
        self.assertEqual(caught.exception.endpoint_step, 'deepseek_session_create')
        detail = translate_error(caught.exception)
        self.assertEqual(detail['origin'], 'upstream_ai')
        self.assertEqual(detail['category'], 'upstream')
        self.assertIs(detail['retryable'], True)
        self.assertFalse(detail['requestDispatched'])
        activity = classify_failure(detail)
        self.assertEqual((activity['owner'], activity['severity']), ('provider', 'warning'))

    def test_browser_challenge_503_and_other_statuses_keep_their_meaning(self):
        error, _ = deepseek_turn(lambda request: httpx.Response(
            503, content=b'<html><title>Just a moment...</title></html>', headers={'content-type': 'text/html'}))
        self.assertEqual(error.code, 'login_endpoint_challenge_required')
        error, _ = deepseek_turn(lambda request: httpx.Response(429, content=b'{}', headers={'content-type': 'application/json'}))
        self.assertEqual(error.code, 'login_quota_exceeded')
        error, _ = deepseek_turn(lambda request: httpx.Response(418, content=b'{}', headers={'content-type': 'application/json'}))
        self.assertEqual(error.code, 'login_endpoint_rejected')

    def test_unreadable_http200_stays_invalid_but_records_its_structure_only(self):
        # The report's case: HTTP 200 that is not the answer stream. Its body was
        # not kept, so it is not guessed to be "busy"; its shape is now recorded.
        envelope = json.dumps({'code': 0, 'msg': BODY_SECRET, 'data': {'biz_code': 7, 'biz_msg': BODY_SECRET}}).encode()
        error, _ = deepseek_turn(lambda request: httpx.Response(200, content=envelope, headers={'content-type': 'application/json'}))
        self.assertEqual(error.code, 'login_endpoint_response_invalid')
        self.assertEqual(error.upstream_status, 200)
        shape = error.response_shape
        self.assertEqual(shape['kind'], 'json')
        self.assertEqual(shape['keys'], ['code', 'data', 'msg'])
        self.assertEqual((shape['code'], shape['bizCode']), (0, 7))
        self.assertEqual(shape['endpointStep'], 'deepseek_completion')
        self.assertNotIn(BODY_SECRET, json.dumps(shape))
        sse = b'event: ready\ndata: {"response_message_id": 2}\n\nevent: ' + BODY_SECRET.encode() + b'\ndata: {}\n\n'
        error, _ = deepseek_turn(lambda request: httpx.Response(200, content=sse, headers={'content-type': 'text/event-stream'}))
        self.assertEqual(error.code, 'login_endpoint_response_invalid')
        self.assertEqual(error.response_shape['events'], ['ready', BODY_SECRET])  # names only, bounded charset
        for content in (b'', b'not json at all'):
            error, _ = deepseek_turn(lambda request, content=content: httpx.Response(200, content=content, headers={'content-type': 'text/plain'}))
            self.assertEqual(error.response_shape['kind'], 'empty' if not content else 'other')
            self.assertNotIn('not json', json.dumps(error.response_shape))


class OtherWebsites(unittest.TestCase):
    def claude_stream(self, error_type):
        return ('event: error\ndata: ' + json.dumps({'type': 'error', 'error': {'type': error_type, 'message': BODY_SECRET}}) + '\n\n').encode()

    def test_claude_documented_overload_and_internal_error_frames(self):
        for kind, reason in (('overloaded_error', 'provider_overloaded'), ('api_error', 'provider_server_error')):
            with self.subTest(kind=kind):
                with self.assertRaises(LoginError) as caught:
                    claude.parse_reply(self.claude_stream(kind))
                self.assertEqual(caught.exception.code, TEMPORARY)
                self.assertEqual(str(caught.exception), "Claude's server is temporarily unavailable. Try again later.")
                self.assertEqual(caught.exception.provider_reason, reason)
                self.assertNotIn(BODY_SECRET, str(caught.exception))
        for kind in ('invalid_request_error', 'permission_error', None):
            with self.subTest(kind=kind):
                with self.assertRaises(LoginError) as caught:
                    claude.parse_reply(self.claude_stream(kind))
                self.assertEqual(caught.exception.code, 'login_endpoint_rejected')

    def test_chatgpt_responses_server_error_code(self):
        def stream(code):
            return ('data: ' + json.dumps({'type': 'response.failed', 'response': {'error': {'code': code, 'message': BODY_SECRET}}}) + '\n\n').encode()
        with self.assertRaises(LoginError) as caught:
            chatgpt.parse_responses(stream('server_error'))
        self.assertEqual(caught.exception.code, TEMPORARY)
        self.assertEqual(str(caught.exception), "ChatGPT's server is temporarily unavailable. Try again later.")
        with self.assertRaises(LoginError) as caught:
            chatgpt.parse_responses(stream('rate_limit_exceeded'))
        self.assertEqual(caught.exception.code, 'login_quota_exceeded')
        with self.assertRaises(LoginError) as caught:
            chatgpt.parse_responses(stream('invalid_prompt'))
        self.assertEqual(caught.exception.code, 'login_endpoint_rejected')

    def test_relay_websites_share_the_same_status_decision(self):
        http = endpoint.EndpointHTTP.__new__(endpoint.EndpointHTTP)
        http.provider, http.endpoint_step, http._cancel_error, http.check = 'login_claude', 'claude_completion', None, lambda: None
        with self.assertRaises(LoginError) as caught:
            http._outcome(502, 'text/html', {}, b'<html>' + BODY_SECRET.encode(), 'sse', lambda: None)
        self.assertEqual(caught.exception.code, TEMPORARY)
        self.assertEqual(caught.exception.stage, 'endpoint_submit')
        self.assertEqual(http.response_shape, {'schema': 'tp.login_endpoint_response_shape/1', 'kind': 'html',
                                               'bytes': len(BODY_SECRET) + 6})


def request(operation, run='run'):
    return SimpleNamespace(cache_context={'webchatRunId': run, 'operationId': operation,
        'conversationSource': '<<I1_P0:Hello>>'}, image_b64='', user_parts=['<<I1_P0:Hello>>'],
        system_text='Translate to Thai using the same IDs.', model='session/web-default',
        history_messages=[], cancel_check=None, thinking=None)


class SiblingPages(unittest.TestCase):
    def setUp(self):
        runs.clear()
        self.session = {'id': 'session', 'provider': 'login_deepseek', 'credential': 'fixture'}
        self.patches = [
            patch.object(runs.store, 'credential_for_session', return_value={'tokens': {'credentials': {}}}),
            patch.object(runs.store, 'active_session_ids', return_value={'session'}),
            patch.object(diagnostic.trace, 'write'), patch.object(diagnostic, 'log_event'),
            patch('backend.diagnostics.writer.emit'),
            patch.dict(os.environ, {'TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS': '0', 'TP_AI_WIRE_TRACE': '0'}),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        runs.clear()

    def test_one_provider_failure_stops_the_run_with_the_same_provider_message(self):
        calls = []

        def generate(credentials, prompt, remote, model, check, dispatch):
            dispatch()
            calls.append(prompt)
            error = endpoint.provider_unavailable('login_deepseek')
            error.upstream_status, error.endpoint_step = 503, 'deepseek_completion'
            raise error
        module = SimpleNamespace(endpoint_generate=generate)
        with self.assertRaises(LoginError) as first:
            runs.generate(self.session, request('page-1'), module)
        self.assertEqual(first.exception.code, TEMPORARY)
        self.assertTrue(first.exception.requestDispatched)
        sent = translate_error(first.exception)
        self.assertEqual((sent['origin'], sent['category'], sent['stage']), ('upstream_ai', 'upstream', 'login_provider'))
        self.assertIs(sent['retryable'], True)

        for page in ('page-2', 'page-3'):
            with self.subTest(page=page):
                with self.assertRaises(LoginError) as caught:
                    runs.generate(self.session, request(page), module)
                error = caught.exception
                self.assertEqual(error.code, TEMPORARY)
                self.assertIn("DeepSeek's server is temporarily unavailable", str(error))
                self.assertFalse(error.requestDispatched, 'this page sent nothing')
                self.assertTrue(error.earlier_page_failed)
                self.assertIs(error.retryable, True)
                self.assertEqual(error.stage, 'endpoint_run_stopped')
                detail = translate_error(error)
                # Before: origin api / login_authorization / configuration -> owner textphantom, severity error.
                self.assertEqual((detail['origin'], detail['category'], detail['stage']),
                                 ('upstream_ai', 'upstream', 'login_run_stopped'))
                self.assertIs(detail['earlierPageFailed'], True)
                self.assertFalse(detail['requestDispatched'])
                self.assertEqual(detail['providerAttempts'], 0)
                activity = classify_failure(detail)
                self.assertEqual((activity['owner'], activity['severity'], activity['retryable']), ('provider', 'warning', True))
                # The failure line no longer reads as an entitlement-stage fault.
                with diagnostic.context('login_deepseek', 'inference', 'fixture-trace'):
                    diagnostic.stage('entitlement')
                    line = diagnostic.emit('failed', error)
                self.assertEqual(line['stage'], 'endpoint_run_stopped')
                self.assertIs(line['earlierPageFailed'], True)
        self.assertEqual(len(calls), 1, 'one provider request; siblings are not sent after an uncertain turn')

    def test_unreadable_reply_siblings_are_provider_side_but_not_retryable(self):
        def generate(credentials, prompt, remote, model, check, dispatch):
            dispatch()
            raise endpoint.invalid()
        module = SimpleNamespace(endpoint_generate=generate)
        with self.assertRaises(LoginError):
            runs.generate(self.session, request('page-1'), module)
        with self.assertRaises(LoginError) as caught:
            runs.generate(self.session, request('page-2'), module)
        detail = translate_error(caught.exception)
        self.assertEqual(detail['code'], 'login_endpoint_response_invalid')
        self.assertEqual((detail['origin'], detail['category']), ('upstream_ai', 'upstream'))
        self.assertIs(detail['retryable'], False)

    def test_ordinary_pre_send_failures_keep_their_configuration_label(self):
        error = LoginError('login_model_unavailable', 'This Login model is unavailable.', 409)
        detail = translate_error(error)
        self.assertEqual((detail['origin'], detail['stage'], detail['category']), ('api', 'login_authorization', 'configuration'))
        self.assertIs(detail['retryable'], False)


if __name__ == '__main__':
    unittest.main()
