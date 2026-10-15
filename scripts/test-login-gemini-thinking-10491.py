""".91 owner question: can Login Gemini's AI think be set?

Evidence-only contract (offline: fictional HTTP, no account, network or secrets):
- Login Gemini is exactly one path, the gemini.google.com web endpoint
  (StreamGenerate, model 'web-default'). The module has no OAuth/API functions,
  so no Gemini API thinkingBudget/thinkingLevel request exists for Login.
- No capture shows a thinking/mode field in the web request, so nothing
  thinking-related is sent: the StreamGenerate shape is pinned to the evidenced
  fields, the module is never given the user's choice, and the catalogue row is
  the "default" AI think state (disabled provider default).
- A login_gemini session can never build Gemini API thinking fields
  (thinking_budget / reasoning_effort) in the native-payload branch.
"""
import inspect
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
from backend.ai.login import login_provider_gemini as gemini  # noqa: E402
from backend.ai.login import login_translation as adapter  # noqa: E402
from backend.ai.login.endpoint import login_endpoint_http as transport  # noqa: E402
from backend.ai.login.endpoint import login_endpoint_runs as runs  # noqa: E402
from backend.ai.login.login_provider_contract import LoginError  # noqa: E402
from backend.ai.provider_contract import GenerationRequest  # noqa: E402
from backend.ai.thinking_state import (classify_thinking_state, sends_provider_default,  # noqa: E402
                                       thinking_control_options)

REAL_CLIENT = httpx.Client
CREDS = {'psid': 'synthetic-cookie', 'auth_user': '0', 'identity': 'fixture@example.test'}
HTML = json.dumps({'oPEP7c': CREDS['identity'], 'SNlM0e': 'synthetic-at',
                   'cfb2h': 'synthetic-build', 'FdrFJe': 'synthetic-sid'}).encode()


def wire(text='<<I1_P0:fixture>>'):
    body = [None] * 26
    body[1] = ['c_fixture', 'r_fixture']
    body[4] = [['rc_fixture', [text], None, None, None, None, None, None, [2]]]
    value = '\n' + json.dumps([['wrb.fr', None, json.dumps(body)]])
    return b")]}'\n" + (str(len(value.encode('utf-16-le')) // 2) + value).encode()


class LoginGeminiThinking(unittest.TestCase):
    def test_only_the_web_endpoint_path_exists(self):
        self.assertEqual(gemini.PROVIDER.channel, 'web_endpoint')
        for name in ('prepare', 'auth_url', 'exchange', 'models', 'refresh', 'generate', 'configuration'):
            self.assertFalse(hasattr(gemini, name), f'login_gemini has no OAuth/API {name}()')
        self.assertFalse(getattr(gemini, 'ENDPOINT_THINKING', False), 'no verified web thinking switch')
        self.assertNotIn('thinking', inspect.signature(gemini.endpoint_generate).parameters)

    def test_catalogue_row_is_provider_default_state(self):
        row = gemini.endpoint_model_rows([transport.model('web-default', 'saved before .91')])[0]
        reasoning = row['model_capabilities']['reasoning']
        self.assertIs(reasoning['app_controlled'], False)
        self.assertEqual(thinking_control_options(reasoning), ())
        state = classify_thinking_state(reasoning, fresh=True)
        self.assertEqual(state, 'default')
        self.assertTrue(sends_provider_default(state))
        # A late or failed catalogue is never "default".
        self.assertEqual(classify_thinking_state(reasoning, fresh=False), 'loading')

    def test_stream_generate_carries_only_evidenced_fields(self):
        posts = []

        def handle(request):
            if request.method == 'GET':
                return httpx.Response(200, content=HTML, headers={'content-type': 'text/html'})
            outer = json.loads(parse_qs(request.content.decode())['f.req'][0])
            posts.append((json.loads(outer[1]), {k.lower(): v for k, v in request.headers.items()}))
            return httpx.Response(200, content=wire())
        with patch.object(transport.httpx, 'Client', side_effect=lambda **kw:
                          REAL_CLIENT(transport=httpx.MockTransport(handle), **kw)):
            gemini.endpoint_generate(CREDS, 'fixture source', {}, 'web-default', lambda: None, lambda: None)
        inner, headers = posts[0]
        # Pinned to the fields the website client was observed sending. A
        # thinking/mode field needs a capture before it is added here.
        self.assertEqual({i for i, v in enumerate(inner) if v is not None},
                         {0, 1, 2, 6, 7, 10, 11, 17, 18, 27, 30, 41, 53, 59, 61, 68, 79, 80})
        self.assertEqual(sorted(k for k in headers if k.startswith('x-goog-ext-')), ['x-goog-ext-525005358-jspb'])
        self.assertNotIn('thinking', json.dumps(inner).lower())

    def test_user_choice_never_reaches_the_web_module(self):
        seen = []

        def endpoint_generate(credentials, prompt, remote, selected, check, dispatch, image=None, **extra):
            seen.append(extra)
            dispatch()
            return {'text': '<<I1_P0:ok>>', 'completed': True, 'statuses': [200], 'terminal': 'fixture'}

        class Request:
            image_b64, user_parts, system_text = '', ('<<I1_P0:hi>>',), 'SYS'
            model, history_messages, cancel_check = 'lgs_x/web-default', (), None

            def __init__(self, thinking):
                self.thinking = thinking
                self.cache_context = {'webchatRunId': 'run-' + thinking, 'operationId': 'op-' + thinking}
        session = {'id': 'lgs_fixture', 'provider': 'login_gemini', 'credential': 'fixture'}
        with patch.object(gemini, 'endpoint_generate', endpoint_generate), \
                patch.object(runs.store, 'credential_for_session', return_value={'tokens': {'credentials': {}}}), \
                patch.object(runs.store, 'active_session_ids', return_value={'lgs_fixture'}), \
                patch.object(runs.diagnostic, 'stage'), patch('backend.ai.wire_trace.write_json'), \
                patch('backend.ai.wire_trace.write_text'), patch('backend.ai.accounting.mark_dispatched'):
            for value in ('on', 'high', 'off', 'minimum', 'default'):
                runs.generate(session, Request(value), gemini)
        self.assertEqual(seen, [{}] * 5)

    def test_gemini_session_never_builds_api_thinking_fields(self):
        # Hypothetical non-web login_gemini session (none can be created: the
        # module has no OAuth exchange). Even then no Gemini API field is built.
        session = {'id': 'lgs_' + 'a' * 48, 'provider': 'login_gemini', 'credential': 'fixture'}
        selected = {'id': 'gemini-2.5-flash', '_metadata': {}, 'model_capabilities': {
            'reasoning': {'supported': True, 'control': 'levels', 'can_disable': True,
                          'supported_efforts': ['none', 'low', 'medium', 'high']}}}
        sent = []

        def native_generate(_session, payload, cancel_check=None):
            sent.append(dict(payload))
            return {'choices': [{'message': {'content': 'ok'}, 'finish_reason': 'stop'}]}

        def call(thinking):
            request = GenerationRequest(provider='login', model=session['id'] + '/gemini-2.5-flash',
                                        system_text='SYS', user_parts=('<<I1_P0:hi>>',), thinking=thinking)
            return adapter.ADAPTER.generate(request)
        with patch.object(adapter, 'authorize_model', return_value=('owner', session, 'gemini-2.5-flash')), \
                patch.object(adapter.login_profiles, 'model_list', return_value=[selected]), \
                patch.object(adapter.store, 'credential_for_session', return_value={'tokens': {'transport': 'oauth'}}), \
                patch.object(adapter.native, 'generate', native_generate):
            call('default')
            for value in ('low', 'high', 'on'):
                with self.assertRaises(LoginError) as caught:
                    call(value)
                self.assertEqual(caught.exception.code, 'login_thinking_unsupported')
        self.assertEqual(len(sent), 1, 'unverified choices stop before dispatch')
        self.assertFalse({'thinking_budget', 'reasoning_effort', 'reasoning'} & set(sent[0]))


if __name__ == '__main__':
    unittest.main()
