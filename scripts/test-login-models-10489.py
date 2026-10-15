""".89 owner report (2026-10-14): Login models the account's plan cannot use.

claude.ai's own picker marks some models "Upgrade" (Pro/Max), but the catalogue
response TextPhantom reads (app_start claude_ai_available_models.models[]) is
captured with model_id only, so plan access is unknown at connect. The website's
403 for a chat turn with one model is the evidence we have:
- the error says the account/plan cannot use the model and to choose another;
- that model is remembered for the connected session, listed with
  availability.usable=false, and refused before anything is sent again;
- a 403 outside the chat turn (session level) marks nothing;
- Reconnect builds a new catalogue and forgets the mark.
Also the Extra effort level ordering (Python half; JS: test-login-models-10489.mjs).
.92: the claude.ai chat picker (model_selector_config) now marks plan-disabled
models up front (test-login-claude-web-thinking-10492.py); the remembered 403
below stays the backstop for rows the picker does not describe.
Offline: no accounts, network, cookies or tokens."""
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
sys.path.insert(0, str(ROOT / 'scripts'))
from backend.ai.login import login_routes as routes, login_translation as translation  # noqa: E402
from backend.ai.login import login_session_store as store, login_native as native, login_profiles  # noqa: E402
from backend.ai.login import login_provider_claude as claude  # noqa: E402
from backend.ai.login.endpoint import login_endpoint_http as endpoint, login_endpoint_runs as runs  # noqa: E402
from backend.ai.login.login_provider_contract import LoginError  # noqa: E402
from backend.ai.reasoning_preference import concrete_reasoning_preferences, normalize_reasoning_preference  # noqa: E402
from backend.ai.thinking_state import classify_thinking_state, thinking_control_options  # noqa: E402
from login_relay_fixture import relay_via  # noqa: E402

CLIENT = httpx.Client
DENIED, ALLOWED = 'claude-opus-fixture', 'claude-sonnet-fixture'


def claude_wire(text, mid):
    events = [{'type': 'message_start', 'message': {'uuid': mid, 'role': 'assistant'}},
              {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
              {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}},
              {'type': 'content_block_stop', 'index': 0},
              {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}}, {'type': 'message_stop'}]
    return ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()


class LoginModelAccess(unittest.TestCase):
    def setUp(self):
        store.clear(); runs.clear()
        self.env = patch.dict(os.environ, {'TP_CENTER_URL': 'http://127.0.0.1:9999', 'TP_AI_WIRE_TRACE': '0',
            'TP_LOGIN_ENABLED_PROVIDERS': 'login_chatgpt,login_claude,login_gemini,login_deepseek',
            'TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS': '0'})
        self.env.start()
        self.auth = patch.object(routes.login_entitlement, 'authorize', return_value='fiction-owner')
        self.auth.start()
        self.sent = []

    def tearDown(self):
        self.auth.stop(); self.env.stop(); store.clear(); runs.clear()

    def bind(self):
        rows = [claude.website_model(DENIED), claude.website_model(ALLOWED)]
        return store.bind_native('fiction-owner', 'login_claude', 'fiction-claude',
            {'transport': 'web_endpoint', 'credentials': {'organization': 'org-1'}, 'models': rows, 'no_refresh': True})

    def request(self, session, model_id, run):
        return SimpleNamespace(api_key='x' * 48, model=session['id'] + '/' + model_id, image_b64='',
            system_text='Translate into Thai.', user_parts=['<<I1_P0:Hello>>'], history_messages=[],
            cache_context={'webchatRunId': run, 'operationId': 'op-1', 'conversationSource': '<<I1_P0:Hello>>'},
            cancel_check=None, thinking='default')

    def handle(self, request):
        body = json.loads(request.content)
        self.sent.append(body['model'])
        if body['model'] == DENIED:  # what claude.ai answers for a model the plan cannot use
            return httpx.Response(403, json={'type': 'error'})
        return httpx.Response(200, content=claude_wire('<<I1_P0:สวัสดี>>', 'answer-1'),
                              headers={'content-type': 'text/event-stream'})

    def generate(self, session, model_id, run):
        with patch.object(endpoint.httpx, 'Client', side_effect=lambda **kw: CLIENT(transport=httpx.MockTransport(self.handle), **kw)), \
                patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage'), \
                patch.object(translation.diagnostic, 'emit'), \
                patch('backend.ai.accounting.mark_dispatched'), relay_via(self.handle), \
                patch.object(native, 'module', return_value=claude):
            return translation.ADAPTER.generate(self.request(session, model_id, run))

    def public_rows(self, session):
        with patch.object(native, 'module', return_value=claude):
            return {row['id']: row for row in login_profiles.public_models(login_profiles.model_list(session))}

    def test_denied_turn_is_explained_remembered_and_never_resent(self):
        session = self.bind()
        self.assertNotIn('availability', self.public_rows(session)[DENIED], 'unknown before the website answers')
        with self.assertRaises(LoginError) as caught:
            self.generate(session, DENIED, 'run-1')
        error = caught.exception
        self.assertEqual(error.code, 'login_provider_access_denied')
        self.assertTrue(error.requestDispatched)
        self.assertIn('cannot use the selected model', str(error))
        self.assertIn('upgraded plan', str(error))
        self.assertIn('Choose another model', str(error))
        self.assertEqual(self.sent, [DENIED])

        rows = self.public_rows(session)
        self.assertEqual(rows[DENIED]['availability'],
                         {'usable': False, 'reason': 'website_denied', 'evidence': 'http_403_claude_completion'})
        self.assertNotIn('availability', rows[ALLOWED])

        # The saved selection is refused before dispatch, with a clear message.
        with self.assertRaises(LoginError) as again:
            self.generate(session, DENIED, 'run-2')
        self.assertEqual(again.exception.code, 'login_model_access_denied')
        self.assertIs(again.exception.requestDispatched, False)
        self.assertIn('Nothing was sent', str(again.exception))
        self.assertEqual(self.sent, [DENIED], 'nothing was sent the second time')

        # Another model of the same account still translates.
        result = self.generate(session, ALLOWED, 'run-3')
        self.assertEqual(result.text, '<<I1_P0:สวัสดี>>')
        self.assertEqual(self.sent, [DENIED, ALLOWED])

        # Reconnect (new catalogue) forgets the mark: the plan may have been upgraded.
        fresh = self.bind()
        self.assertNotIn('availability', self.public_rows(fresh)[DENIED])

    def test_session_level_403_marks_nothing(self):
        session = self.bind()
        self.assertFalse(native.remember_model_denied(session, DENIED, 'claude_identity'))
        self.assertFalse(native.remember_model_denied(session, DENIED, 'claude_catalogue'))
        self.assertFalse(native.remember_model_denied(session, 'not-listed', 'claude_completion'))
        self.assertNotIn('availability', self.public_rows(session)[DENIED])

    def test_403_message_depends_on_step(self):
        http = endpoint.EndpointHTTP('login_claude', {})
        for dispatch, text in ((lambda: None, 'upgraded plan'), (None, 'denied this endpoint session')):
            with self.assertRaises(LoginError) as caught:
                http._outcome(403, 'application/json', {}, b'{}', 'sse', dispatch)
            self.assertEqual(caught.exception.code, 'login_provider_access_denied')
            self.assertIn(text, str(caught.exception))
        http.client.close()

    def test_extra_effort_ordering(self):
        record = {'supported': True, 'mandatory': True, 'control': 'levels',
                  'supported_efforts': ['max', 'extra', 'high', 'medium', 'low']}
        self.assertEqual(thinking_control_options(record), ('low', 'medium', 'high', 'extra', 'max'))
        self.assertEqual(classify_thinking_state(record, fresh=True), 'controllable')
        self.assertEqual(tuple(concrete_reasoning_preferences(record)), ('low', 'medium', 'high', 'extra', 'max'))
        self.assertEqual(normalize_reasoning_preference('Extra'), 'extra')
        # The claude.ai website rows carry no effort data: website-managed (disabled control).
        website = claude.website_model(ALLOWED)['model_capabilities']['reasoning']
        self.assertEqual(classify_thinking_state(website, fresh=True), 'default')


if __name__ == '__main__':
    unittest.main()
