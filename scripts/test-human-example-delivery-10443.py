"""Capture canonical first/continuation/repair requests without live accounts.

Native Gemini/DeepSeek form/SSE and Paid HTTP serializers are exercised with
synthetic httpx responses. This is prompt-delivery evidence, not provider QA.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import unittest
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from urllib.parse import parse_qs
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
# Configure the normal provider composition root before its imports, exactly as
# a Paid/Login-enabled API startup does. The target is synthetic and intercepted.
os.environ['TP_CENTER_URL'] = 'https://center.example.test'
from backend.ai import markers
from backend.ai.clients.base import ChatResult
from backend.ai.prompts.localization import STYLE_EXAMPLES, HUMAN_STYLE_EXAMPLE_LIMIT
from backend.ai.translation import invocation
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation_paths.mode import descriptor
from backend.ai.login import login_entitlement, login_native, login_session_store
from backend.ai.login.endpoint import login_endpoint_http, login_endpoint_runs
from backend.ai.login import login_provider_gemini, login_provider_deepseek
from backend.ai.providers import cloud_paid

REAL_CLIENT = httpx.Client
STYLE = 'SYNTHETIC CUSTOM STYLE: preserve the current scene and natural wording.'
MEMORY = 'SYNTHETIC SERIES MEMORY: Established title is Dawn.'
MIXED = ('英語の台詞 Hello. 한국어 대사 안녕하세요.', '別の台詞 Goodbye. 다음 대사 감사합니다.',
         '修正する台詞 Thanks. 남은 대사 고마워요.')


def source_ids(text):
    return re.findall(r'<<(I[1-9][0-9]{0,6}_P[0-9]{1,6}):', text)


def answer(text):
    ids = source_ids(text)
    assert ids, 'Synthetic transport received no source records'
    return '\n'.join(f'<<{uid}:คำแปล>>' for uid in ids)


def origins(i):
    return [{'pageId': f'synthetic-page-{i}', 'pageOrder': i,
             'unitIds': [f'I{i}_P0'], 'originalIds': ['g0']}]


def config(label, provider='openai', model='synthetic-model', key='synthetic-key'):
    return AiConfig(provider=provider, model=model, api_key=key, thinking='default',
        translation_mode='conversation', memory_mode='full', series_state=MEMORY,
        prompt_editable=STYLE, style_examples=True, source_lang='ja',
        conversation=descriptor({'documentId': 'synthetic-human-examples-' + label,
                                 'webchatRunId': 'synthetic-run-' + label,
                                 'origins': origins(1)}, context={'tp_tab_session': 'synthetic-owner'}))


def invoke_three(ai):
    out = []
    for i in (1, 2, 3):
        current = replace(ai, source_lang=('ja', 'en', 'ko')[i - 1],
            paid_operation_id=f'synthetic-operation-{i}', paid_user_run_id='synthetic-click',
            series_state=MEMORY if i == 1 else 'LATER MEMORY MUST NOT REPEAT',
            conversation={**ai.conversation, 'origins': origins(i),
                          **({'branch': 'repair'} if i == 3 else {})})
        out.append(invocation.translate(markers.apply([MIXED[i - 1]]), 'th', current))
    return out


def example_ids(text):
    return re.findall(r'(?m)^(H[0-9]{2})\nEN:', text)


def gemini_frame(text, turn):
    candidate = ['synthetic-candidate-' + str(turn), [text], None, None, None, None, None, None, [2]]
    body = [None, ['synthetic-conversation', 'synthetic-response-' + str(turn)], None, None, [candidate]]
    frame = json.dumps([['wrb.fr', None, json.dumps(body, ensure_ascii=False)]], ensure_ascii=False)
    length = 1 + len(frame.encode('utf-16-le')) // 2  # Native length includes its leading LF.
    return (")]}'\n" + str(length) + '\n' + frame + '\n').encode('utf-8')


def deepseek_stream(text, turn):
    def frame(value, event=''):
        return ((('event: ' + event + '\n') if event else '') + 'data: ' +
                json.dumps(value, ensure_ascii=False) + '\n\n').encode('utf-8')
    return frame({'response_message_id': turn}, 'ready') + frame({'p': '', 'v': {'response': {
        'chat_session_id': 'synthetic-conversation', 'message_id': turn, 'role': 'ASSISTANT',
        'status': 'FINISHED', 'fragments': [{'type': 'RESPONSE', 'content': text}]}}}) + frame({}, 'close')


class HumanExampleDelivery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(['node', str(ROOT / 'scripts/test-human-examples-default-wire-10443.mjs'),
                                 '--emit-fixtures'], cwd=ROOT, capture_output=True, text=True,
                                encoding='utf-8', timeout=30)
        if result.returncode:
            raise AssertionError('Normal frontend resolver-to-wire regression failed; run the Node fixture for details')
        cls.normal_wires = json.loads(result.stdout)

    def setUp(self):
        self.fixture_kind = 'legacy-forced-off'
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {'TP_AI_WIRE_TRACE': '0',
            'TP_USAGE_RECEIPTS': 'off', 'TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS': '0'}))
        self.stack.enter_context(patch('backend.ai.provider_resolution.discovered_model_capabilities',
                                      return_value=(True, {'reasoning': {'supported': False, 'mandatory': False}})))
        login_endpoint_runs.clear()
        login_session_store.clear()
        self.addCleanup(login_endpoint_runs.clear)
        self.addCleanup(login_session_store.clear)

    def check_bootstrap(self, text):
        enabled = self.fixture_kind == 'saved-on'
        self.assertEqual(example_ids(text), [f'H{i:02}' for i in range(1, 21)] if enabled else [])
        if enabled:
            for row in STYLE_EXAMPLES[:20]:
                for lang in ('en', 'ja', 'th'):
                    self.assertIn(f'{lang.upper()}: {row[lang]}', text)
        self.assertEqual(text.count(MEMORY), 0 if self.fixture_kind == 'fresh' else 1)
        self.assertNotIn('H21\nEN:', text)

    def check_current_sources(self, texts):
        for i, text in enumerate(texts[1:], 2):
            self.assertEqual(text, f'<<I{i}_P0:{MIXED[i-1]}>>')
            self.assertFalse(example_ids(text))
            self.assertNotIn(STYLE, text)
            self.assertNotIn('LATER MEMORY MUST NOT REPEAT', text)

    def normal_config(self, provider, *, model, key):
        from backend.application.ai_translation.request_validation import build_config
        payload = json.loads(json.dumps(next(f['wire'] for f in self.normal_wires
            if f['provider'] == provider and f['kind'] == self.fixture_kind)))
        payload['provider']['apiKey'] = key
        payload['provider']['model'] = model
        ai = build_config(payload)
        self.selected_style = ai.prompt_editable
        self.assertIs(ai.style_examples, self.fixture_kind == 'saved-on',
                      'Normal settings and ingress must retain the selected toggle')
        return ai

    def test_original_parallel_corpus_is_not_a_new_or_korean_reconstruction(self):
        self.assertEqual(len(STYLE_EXAMPLES), 69)
        self.assertEqual(HUMAN_STYLE_EXAMPLE_LIMIT, 20)
        self.assertEqual({k for row in STYLE_EXAMPLES for k in row}, {'id', 'en', 'ja', 'th'})
        digest = hashlib.sha256(json.dumps(STYLE_EXAMPLES, ensure_ascii=False).encode()).hexdigest()
        self.assertEqual(digest, '261f69f7d0530bef4dad62a8c82ec7404a7e2fd6d4f7b8adf450eb9f3eed7a0f',
                         'The exact corpus verified in original Source .36 and delivered Source .39 changed')

    def test_canonical_mixed_source_request_keeps_twenty_examples_and_user_style(self):
        self.fixture_kind = 'saved-on'
        requests = []
        def generate(req):
            requests.append(req)
            return ChatResult(answer(req.user_parts[0]), req.model, finish_reason='stop',
                              terminal_completed=True, terminal_evidence='synthetic_complete')
        adapter = invocation.provider_registry.require('openai').adapter
        self.stack.enter_context(patch.object(adapter, 'generate', side_effect=generate))
        invoke_three(config('canonical'))
        self.assertEqual(len(requests), 3)
        self.check_bootstrap(requests[0].user_parts[0])
        self.check_current_sources([r.user_parts[0] for r in requests])
        self.assertEqual(requests[0].system_text.count(STYLE), 1)
        self.assertNotIn(STYLE, requests[0].user_parts[0])
        self.assertEqual(requests[1].history_messages[0]['text'], requests[0].user_parts[0])
        self.assertEqual(requests[2].history_messages[0]['text'], requests[0].user_parts[0])

    def test_normal_new_and_legacy_paid_login_wire_reaches_first_provider_request(self):
        from backend.application.ai_translation.request_validation import build_config
        requests = []
        def generate(req):
            requests.append(req)
            return ChatResult(answer(req.user_parts[0]), req.model, finish_reason='stop',
                              terminal_completed=True, terminal_evidence='synthetic_complete')
        adapter = invocation.provider_registry.require('openai').adapter
        self.stack.enter_context(patch.object(adapter, 'generate', side_effect=generate))
        for fixture in self.normal_wires:
            with self.subTest(provider=fixture['provider'], kind=fixture['kind']):
                # Owned provider authentication is separately covered below;
                # the normal frontend wire's prompt, memory, language and run
                # fields go through real ingress and canonical assembly here.
                payload = json.loads(json.dumps(fixture['wire']))
                payload['provider'] = {**payload['provider'], 'id':'openai',
                                       'model':'synthetic-model', 'apiKey':'synthetic-key'}
                ai = build_config(payload)
                invocation.translate(markers.apply([u['text'] for u in payload['units']]), 'th', ai)
                first = requests[-1]
                self.assertEqual(example_ids(first.user_parts[0]),
                    [f'H{i:02}' for i in range(1,21)] if fixture['kind'] == 'saved-on' else [])
                self.assertEqual(ai.memory_mode, 'off' if fixture['kind'] == 'fresh' else 'full')
                self.assertEqual(first.system_text.count(payload['prompt']), 1)
                if fixture['kind'] != 'fresh':
                    self.assertIn('SYNTHETIC SERIES MEMORY', first.user_parts[0])
                else:
                    self.assertNotIn('SYNTHETIC SERIES MEMORY', first.user_parts[0])
        self.assertEqual(len(requests), 21, 'One generation per original source request, no setup generation')

    def login_capture(self, provider, credentials, handle):
        from backend.ai.login.endpoint.login_endpoint_http import model
        label = provider.removeprefix('login_')
        session = login_session_store.bind_native('synthetic-owner', provider,
            'synthetic-' + label + '-identity', {'transport': 'web_endpoint', 'no_refresh': True,
                'credentials': credentials, 'models': [model('web-default', 'Synthetic website default')]})
        self.stack.enter_context(patch.object(login_entitlement, 'authorize', return_value='synthetic-owner'))
        self.stack.enter_context(patch('backend.ai.login.login_routes.enabled', return_value=True))
        self.stack.enter_context(patch.object(login_endpoint_http.httpx, 'Client',
            side_effect=lambda **kw: REAL_CLIENT(**dict(kw, transport=httpx.MockTransport(handle)))))
        results = invoke_three(self.normal_config(provider, model=session['id'] + '/web-default',
                                                 key='synthetic-owner-session'))
        self.assertEqual([r['meta']['usage']['promptDelivery']['firstTurn'] for r in results], [True, False, False])
        return results

    def test_actual_gemini_login_form_preserves_first_examples_and_remote_continuation(self):
        sent, metadata = [], []
        def handle(request):
            if request.url.path == '/app':
                return httpx.Response(200, text=json.dumps({'oPEP7c': 'synthetic@example.test',
                    'SNlM0e': 'synthetic-form-token', 'cfb2h': 'synthetic-build', 'FdrFJe': 'synthetic-sid'}))
            self.assertTrue(request.url.path.endswith('/StreamGenerate'))
            form = parse_qs(request.content.decode('utf8'))
            inner = json.loads(json.loads(form['f.req'][0])[1])
            prompt = inner[0][0]
            sent.append(prompt); metadata.append(inner[2])
            return httpx.Response(200, content=gemini_frame(answer(prompt), len(sent)))
        self.login_capture('login_gemini', {'psid': 'synthetic-private-psid',
            'identity': 'synthetic@example.test', 'auth_user': '0'}, handle)
        self.assertEqual(len(sent), 3)
        self.check_bootstrap(sent[0]); self.check_current_sources(sent)
        self.assertEqual(sent[0].count(self.selected_style), 1)
        self.assertEqual(metadata[0][0], '')
        self.assertEqual(metadata[1][0], 'synthetic-conversation')
        self.assertEqual(metadata[2][2], 'synthetic-candidate-2')

    def test_actual_deepseek_login_http_preserves_first_examples_and_parent(self):
        sent, parents, creates = [], [], []
        def business(value):
            return httpx.Response(200, json={'code': 0, 'data': {'biz_code': 0, 'biz_data': value}})
        def handle(request):
            if request.url.path == '/api/v0/chat_session/create':
                creates.append(True); return business({'id': 'synthetic-conversation'})
            if request.url.path == '/api/v0/chat/create_pow_challenge':
                return business({'challenge': {'fixture_only': True}})
            self.assertEqual(request.url.path, '/api/v0/chat/completion')
            body = json.loads(request.content); sent.append(body['prompt']); parents.append(body['parent_message_id'])
            return httpx.Response(200, content=deepseek_stream(answer(body['prompt']), len(sent)),
                                  headers={'Content-Type': 'text/event-stream'})
        # Challenge computation is not a prompt-delivery assertion and is
        # replaced explicitly; the normal endpoint run/HTTP/SSE path is intact.
        self.stack.enter_context(patch.object(login_provider_deepseek, 'proof', return_value='synthetic-proof'))
        self.login_capture('login_deepseek', {'token': 'synthetic-private-token'}, handle)
        self.assertEqual(len(sent), 3); self.assertEqual(len(creates), 1)
        self.check_bootstrap(sent[0]); self.check_current_sources(sent)
        self.assertEqual(sent[0].count(self.selected_style), 1)
        self.assertEqual(parents, [None, 1, 2])

    def test_actual_paid_http_body_keeps_examples_and_owned_history(self):
        sent = []
        def handle(request):
            if request.url.path == '/healthz':
                return httpx.Response(200, json={'ok': True, 'service': 'textphantom-control-center',
                    'release': '2026.10.4.63', 'paid_protocol': 'tp-paid-v2'})
            if request.url.path.endswith('/chat/receipt'):
                return httpx.Response(200,json={'found':False})
            if request.url.path.endswith('/price-quote'):
                return httpx.Response(200,json={'quote_token':'synthetic-human-examples-click-quote'})
            self.assertEqual(str(request.url), 'https://center.example.test/api/customer/chat/completions')
            body = json.loads(request.content); sent.append(body)
            content = body['messages'][-1]['content']
            return httpx.Response(200, json={'id': 'synthetic-center-response', 'model': 'qa/test',
                'choices': [{'message': {'content': answer(content)}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 100, 'completion_tokens': 10, 'total_tokens': 110},
                'charged_tp': '0', 'balance_tp': '0'})
        self.stack.enter_context(patch.object(cloud_paid, 'center_base_url', return_value='https://center.example.test'))
        self.stack.enter_context(patch.object(cloud_paid, 'center_origin', return_value='https://center.example.test'))
        self.stack.enter_context(patch.object(invocation, 'assert_ai_base_url_allowed'))
        self.stack.enter_context(patch.object(cloud_paid.httpx, 'Client',
            side_effect=lambda **kw: REAL_CLIENT(**dict(kw, transport=httpx.MockTransport(handle)))))
        ai = self.normal_config('tp', model='qa/test', key='synthetic-customer-session')
        ai.base_url = 'https://center.example.test/api/customer'
        # This suite owns only native prompt delivery; its synthetic read-only
        # preflight supplies the click approval. Real sealed Center quote and
        # billing validation are covered by the 10445 Gateway/Center suite.
        with REAL_CLIENT(transport=httpx.MockTransport(handle)) as preflight:
            ai.paid_price_quote_token=preflight.post(ai.base_url+'/price-quote',json={
                'model':'qa/test','max_tokens':8192,'thinking':'minimum'}).json()['quote_token']
        invoke_three(ai)
        self.assertEqual(len(sent), 3)
        self.check_bootstrap(sent[0]['messages'][-1]['content'])
        self.check_current_sources([b['messages'][-1]['content'] for b in sent])
        self.assertEqual(sent[0]['messages'][0]['content'].count(self.selected_style), 1)
        self.assertEqual(sent[1]['messages'][1], sent[0]['messages'][1])
        self.assertEqual(sent[2]['messages'][1], sent[0]['messages'][1])
        self.assertEqual(len({b['operation_id'] for b in sent}), 3)
        self.assertEqual(len({b['user_run_id'] for b in sent}), 1)

    def test_normal_fresh_defaults_reach_native_gemini_deepseek_and_paid_serializers(self):
        self.fixture_kind = 'fresh'
        for provider, test in (
            ('gemini', self.test_actual_gemini_login_form_preserves_first_examples_and_remote_continuation),
            ('deepseek', self.test_actual_deepseek_login_http_preserves_first_examples_and_parent),
            ('paid', self.test_actual_paid_http_body_keeps_examples_and_owned_history),
        ):
            with self.subTest(provider=provider):
                test()


if __name__ == '__main__':
    unittest.main()
