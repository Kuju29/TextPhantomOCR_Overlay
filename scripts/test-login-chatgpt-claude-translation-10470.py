""".70 owner request: ChatGPT and Claude Login translation run end to end
(Login adapter -> endpoint run -> real site module -> fictional HTTP), keeping
both listed for translation. Two Claude turns share one website conversation.
(.77: ChatGPT turns are covered by test-login-chatgpt-browser-10477.py.)
Offline: no accounts, network, cookies or tokens."""
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.login import login_routes as routes, login_translation as translation
from backend.ai.login import login_session_store as store, login_native as native
from backend.ai.login import login_provider_chatgpt as chatgpt, login_provider_claude as claude
from backend.ai.login.endpoint import login_endpoint_http as endpoint, login_endpoint_runs as runs
from backend.ai.login.login_provider_contract import LoginError
from login_relay_fixture import relay_via

CLIENT = httpx.Client
CID = '11111111-2222-4333-8444-555555555555'


def claude_wire(text, mid):
    events = [{'type': 'message_start', 'message': {'uuid': mid, 'role': 'assistant'}},
              {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
              {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}},
              {'type': 'content_block_stop', 'index': 0},
              {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}}, {'type': 'message_stop'}]
    return ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()


def chatgpt_wire(text, mid):
    value = {'conversation_id': CID, 'message': {'id': mid, 'author': {'role': 'assistant'}, 'channel': 'final',
             'recipient': 'all', 'status': 'finished_successfully', 'end_turn': True,
             'content': {'content_type': 'text', 'parts': [text]}, 'metadata': {}}}
    return ('data: ' + json.dumps(value, ensure_ascii=False) + '\n\ndata: [DONE]\n\n').encode()


class LoginChatGPTClaude(unittest.TestCase):
    def setUp(self):
        store.clear(); runs.clear()
        self.env = patch.dict(os.environ, {'TP_CENTER_URL': 'http://127.0.0.1:9999', 'TP_AI_WIRE_TRACE': '0',
            'TP_LOGIN_ENABLED_PROVIDERS': 'login_chatgpt,login_claude,login_gemini,login_deepseek',
            'TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS': '0'})
        self.env.start()
        self.auth = patch.object(routes.login_entitlement, 'authorize', return_value='fiction-owner')
        self.auth.start()

    def tearDown(self):
        self.auth.stop(); self.env.stop(); store.clear(); runs.clear()

    def bind(self, provider, credentials, model_id):
        row = {'id': model_id, 'name': model_id, 'model_capabilities': {}, '_metadata': {'transport': 'web_endpoint'}}
        return store.bind_native('fiction-owner', provider, 'fiction-' + provider,
            {'transport': 'web_endpoint', 'credentials': credentials, 'models': [row], 'no_refresh': True})

    def request(self, session, model_id, op, source, *, history=()):
        return SimpleNamespace(api_key='x' * 48, model=session['id'] + '/' + model_id, image_b64='',
            system_text='Translate into Thai.', user_parts=['<<I1_P0:' + source + '>>'], history_messages=list(history),
            cache_context={'webchatRunId': 'run-' + session['provider'], 'operationId': op,
                           'conversationSource': '<<I1_P0:' + source + '>>'}, cancel_check=None, thinking='default')

    def run_with(self, handler, provider, session, model_id):
        with patch.object(endpoint.httpx, 'Client', side_effect=lambda **kw: CLIENT(transport=httpx.MockTransport(handler), **kw)), \
                patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage'), \
                patch('backend.ai.accounting.mark_dispatched'), relay_via(handler):
            first = translation.ADAPTER.generate(self.request(session, model_id, 'op-1', 'Hello'))
            second = translation.ADAPTER.generate(self.request(session, model_id, 'op-2', 'Bye',
                history=({'role': 'user', 'text': '<<I1_P0:Hello>>'}, {'role': 'assistant', 'text': first.text})))
        return first, second

    def test_label_kept_and_translation_listed(self):
        rows = {p.id for p in routes.PROVIDERS.values()}
        self.assertTrue({'login_chatgpt', 'login_claude'} <= rows)
        from backend.ai.login.login_provider_registry import translation_supported, TRANSLATION_TESTING
        self.assertTrue(translation_supported('login_chatgpt') and translation_supported('login_claude'))
        # .75: Claude runs through the customer's own claude.ai tab (browser relay).
        # .77: ChatGPT (Sign in with ChatGPT / chatgpt.com tab) is no longer labelled either.
        self.assertEqual(TRANSLATION_TESTING, frozenset())

    def test_claude_two_turns_one_conversation(self):
        session = self.bind('login_claude', {'organization': 'org-1'}, 'claude-fixture')
        sent = []

        def handle(request):
            self.assertNotIn('cookie', request.headers)  # .75: the browser tab owns the session
            body = json.loads(request.content)
            sent.append((request.url.path, body))
            return httpx.Response(200, content=claude_wire('<<I1_P0:แปล ' + str(len(sent)) + '>>', 'answer-' + str(len(sent))),
                                  headers={'content-type': 'text/event-stream'})
        with patch.object(native, 'module', return_value=claude):
            first, second = self.run_with(handle, 'login_claude', session, 'claude-fixture')
        self.assertEqual((first.text, second.text), ('<<I1_P0:แปล 1>>', '<<I1_P0:แปล 2>>'))
        (path1, body1), (path2, body2) = sent
        self.assertEqual(path1, path2, 'both turns go to the same website conversation')
        self.assertIn('create_conversation_params', body1)
        self.assertTrue(body1['prompt'].startswith('Translate into Thai.'), 'instructions only in the first turn')
        self.assertEqual(body2['prompt'], '<<I1_P0:Bye>>')
        self.assertEqual(body2['parent_message_uuid'], 'answer-1')

    # .77: the ChatGPT website path tested here (backend-api with an imported access token)
    # was removed. ChatGPT end-to-end turns: test-login-chatgpt-browser-10477.py.


if __name__ == '__main__':
    unittest.main()
