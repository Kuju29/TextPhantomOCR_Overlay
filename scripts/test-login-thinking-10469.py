""".69 Login AI thinking: DeepSeek web has a verified DeepThink switch
(thinking_enabled) and receives the user's choice; Gemini web has no verified
switch and keeps the website default. Offline: no accounts, network or secrets."""
import json
import sys
from pathlib import Path
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
from backend.ai.login.endpoint import login_endpoint_http as endpoint
from backend.ai.login.endpoint import login_endpoint_runs as runs
from backend.ai.login import login_provider_deepseek as deepseek, login_provider_gemini as gemini

real_client = httpx.Client
session = 'fixture-session'
raw = ('event: ready\ndata: {"response_message_id":1}\n\n'
       'data: ' + json.dumps({'p': '', 'v': {'response': {'chat_session_id': session, 'message_id': 1,
           'role': 'ASSISTANT', 'status': 'FINISHED', 'fragments': [
               {'type': 'THINK', 'content': 'private reasoning'}, {'type': 'RESPONSE', 'content': 'fixture answer'}]}}}) + '\n\n'
       'event: close\ndata: {}\n\n').encode()
checks = 0


def generate(thinking):
    sent = []

    def handle(request):
        if request.url.path == '/api/v0/chat_session/create':
            return httpx.Response(200, json={'code': 0, 'data': {'biz_code': 0, 'biz_data': {'id': session}}})
        if request.url.path == '/api/v0/chat/create_pow_challenge':
            return httpx.Response(200, json={'code': 0, 'data': {'biz_code': 0, 'biz_data': {'challenge': {'f': 1}}}})
        sent.append(json.loads(request.content))
        return httpx.Response(200, content=raw, headers={'content-type': 'text/event-stream'})
    with patch.object(endpoint.httpx, 'Client', side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw)), \
            patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage'), \
            patch.object(deepseek, 'proof', return_value='fixture-proof'):
        kwargs = {} if thinking is None else {'thinking': thinking}
        result = deepseek.endpoint_generate({'token': 't'}, 'prompt', {}, 'web-default', lambda: None, lambda: None, **kwargs)
    assert result['text'] == 'fixture answer', 'THINK fragments never reach the translation'
    return sent[0]['thinking_enabled']


# The user's choice reaches DeepSeek's own switch; Lowest/Off/unknown stay off (previous behaviour).
for value, expected in (('on', True), ('high', True), ('off', False), ('minimum', False), ('default', False), (None, False)):
    assert generate(value) is expected, (value, expected)
    checks += 1

# The model row advertises a verified toggle, also for rows saved before .69.
row = deepseek.deepseek_model()
caps = row['model_capabilities']['reasoning']
assert caps['app_controlled'] is True and caps['can_disable'] is True and 'on' in caps['supported_efforts']
legacy = endpoint.model('web-default', 'DeepSeek consumer default')
assert legacy['model_capabilities']['reasoning']['app_controlled'] is False
assert deepseek.endpoint_model_rows([legacy])[0]['model_capabilities']['reasoning']['app_controlled'] is True
checks += 3

# Gemini web: no verified switch; its module is not given a thinking argument.
assert getattr(gemini, 'ENDPOINT_THINKING', False) is False
assert endpoint.model('web-default', 'x')['model_capabilities']['reasoning']['app_controlled'] is False
seen = {}


class Site:
    ENDPOINT_THINKING = False

    @staticmethod
    def endpoint_generate(credentials, prompt, remote, selected, check, dispatch, **extra):
        seen.update(extra)
        dispatch()
        return {'text': 'ok', 'completed': True, 'statuses': [200], 'terminal': 'fixture'}


class DeepSite(Site):
    ENDPOINT_THINKING = True


class Request:
    def __init__(self, thinking):
        self.thinking = thinking
        self.cache_context = {'webchatRunId': 'run-' + thinking, 'operationId': 'op-' + thinking}
        self.image_b64 = ''
        self.user_parts = ('<<I1_P0:hi>>',)
        self.system_text = 'SYS'
        self.model = 'lgs_x/web-default'
        self.history_messages = ()
        self.cancel_check = None


store_session = {'id': 'lgs_fixture', 'provider': 'login_deepseek'}
with patch.object(runs.store, 'credential_for_session', return_value={'tokens': {'credentials': {}}}), \
        patch.object(runs.store, 'active_session_ids', return_value={'lgs_fixture'}), \
        patch.object(runs.diagnostic, 'stage'), patch('backend.ai.wire_trace.write_json'), \
        patch('backend.ai.wire_trace.write_text'), patch('backend.ai.accounting.mark_dispatched'):
    runs.generate(store_session, Request('off'), Site)
    assert seen == {}, 'a site without a verified switch never receives thinking'
    runs.generate(store_session, Request('on'), DeepSite)
    assert seen == {'thinking': 'on'}
checks += 3
print(f'PASS {checks} Login thinking checks: DeepSeek web switch follows the user, Gemini web stays website-managed')
