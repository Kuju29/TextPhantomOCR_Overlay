""".77 ChatGPT Login through the customer's browser. Offline; no accounts.

Paid plans: the extension calls api.openai.com with its own Sign in with ChatGPT token
(relay provider login_chatgpt_official). Free plans: the extension types into its own
chatgpt.com tab (relay provider login_chatgpt_web). The API receives no token or cookie."""
import json
import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
from backend.ai.login import login_provider_chatgpt as chatgpt
from backend.ai.login import login_provider_registry as registry
from backend.ai.login import login_routes as routes
from backend.ai.login.endpoint import login_browser_relay as relay
from backend.ai.login.endpoint import login_endpoint_session as flows
from backend.ai.login.login_provider_contract import LoginError

ACCOUNT = 'a' * 64
OFFICIAL = {'mode': 'official', 'account': ACCOUNT, 'plan': 'plus'}
WEBSITE = {'mode': 'website', 'account': ACCOUNT, 'plan': 'free'}
FORBIDDEN = ('authorization', 'cookie', 'access_token', 'refresh_token', 'token')
MODELS = {'models': [
    {'slug': 'gpt-6.1-sol', 'display_name': 'GPT-6.1 Sol', 'visibility': 'list', 'input_modalities': ['text', 'image']},
    {'slug': 'gpt-6-mini', 'visibility': 'list', 'input_modalities': ['text']},
    {'slug': 'internal-review', 'visibility': 'hide'},
]}


def stream(*deltas, terminal='response.completed'):
    events = [{'type': 'response.created'}] + [{'type': 'response.output_text.delta', 'delta': d} for d in deltas]
    events.append({'type': terminal, 'response': {'usage': {'input_tokens': 10, 'output_tokens': 4}}})
    return ''.join('event: %s\ndata: %s\n\n' % (e['type'], json.dumps(e)) for e in events)


class Pump:
    """A fake extension of one owner: claims its jobs and answers them."""
    def __init__(self, answer, scope='owner-a'):
        self.answer, self.scope, self.jobs = answer, scope, []
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.is_set():
            job = relay.take(self.scope)
            if job is None:
                time.sleep(.005)
                continue
            text = json.dumps(job).lower()
            assert not any('"%s"' % key in text for key in FORBIDDEN), 'a relay job carried a credential'
            self.jobs.append(job)
            relay.complete(self.scope, job['id'], self.answer(job))

    def __enter__(self):
        relay.clear()
        self.thread.start()
        self.owner = relay.owner(self.scope)
        self.owner.__enter__()
        return self

    def __exit__(self, *args):
        self.owner.__exit__(*args)
        self.stop.set()
        self.thread.join(1)


def official_answer(job, responses=None):
    if job['method'] == 'GET' and job['path'] == '/v1/models':
        return {'status': 200, 'content_type': 'application/json', 'body': json.dumps(MODELS)}
    if job['method'] == 'POST' and job['path'] == '/v1/responses':
        # The 2026-10-12 real stream had no Content-Type header.
        return {'status': 200, 'content_type': '', 'body': (responses or [stream('สวัสดี', 'ครับ')]).pop(0)}
    return {'error': 'not_allowed'}


class Credentials(unittest.TestCase):
    def test_tokens_are_refused_and_shape_is_strict(self):
        with self.assertRaises(LoginError) as old:
            chatgpt.validate_credentials({'access_token': 'x' * 40, 'account_id': 'acc'})
        self.assertEqual(old.exception.code, 'login_reconnect_required')
        for bad in ({}, {**OFFICIAL, 'token': 'x'}, {**OFFICIAL, 'mode': 'api'}, {**OFFICIAL, 'account': 'A' * 64},
                    {**OFFICIAL, 'plan': 'Plus Plan'}):
            with self.assertRaises(LoginError):
                chatgpt.validate_credentials(bad)
        self.assertEqual(chatgpt.validate_credentials(OFFICIAL), OFFICIAL)
        self.assertEqual(flows.credentials('login_chatgpt', dict(WEBSITE)), WEBSITE)

    def test_translation_is_supported_and_not_labelled_testing(self):
        self.assertTrue(registry.translation_supported('login_chatgpt'))
        self.assertNotIn('login_chatgpt', registry.TRANSLATION_TESTING | registry.TRANSLATION_UNDER_IMPROVEMENT)

    def test_relay_result_accepts_website_error_codes(self):
        for code in ('account_changed', 'chat_lost', 'challenge', 'limit', 'busy', 'signed_out'):
            routes.RelayResultInput(id='lrj_' + 'b' * 48, error=code)


class Official(unittest.TestCase):
    def test_catalogue_lists_plan_models_with_vision(self):
        with Pump(official_answer) as pump:
            result = chatgpt.endpoint_validate(OFFICIAL, lambda: None)
        self.assertEqual([row['id'] for row in result['models']], ['gpt-6.1-sol', 'gpt-6-mini'])
        self.assertTrue(result['models'][0]['model_capabilities']['vision']['supported'])
        self.assertFalse(result['models'][1]['model_capabilities']['vision']['supported'])
        self.assertEqual(result['identity'], 'chatgpt-official\0' + ACCOUNT)
        self.assertEqual([j['provider'] for j in pump.jobs], ['login_chatgpt_official'])

    def test_generate_streams_and_keeps_conversation_text_only(self):
        responses = [stream('แปล', 'หนึ่ง'), stream('แปลสอง')]
        remote, dispatched = {}, []
        with Pump(lambda job: official_answer(job, responses)) as pump:
            first = chatgpt.endpoint_generate(OFFICIAL, 'SYSTEM\n\nsource one', remote, 'gpt-6.1-sol', lambda: None,
                                              lambda: dispatched.append(1), image=(b'\x89PNG\r\n\x1a\n0', 'image/png'))
            second = chatgpt.endpoint_generate(OFFICIAL, 'source two', remote, 'gpt-6.1-sol', lambda: None,
                                               lambda: dispatched.append(2))
        self.assertEqual((first['text'], second['text']), ('แปลหนึ่ง', 'แปลสอง'))
        self.assertEqual(first['usage'], {'input_tokens': 10, 'output_tokens': 4})
        self.assertEqual(dispatched, [1, 2])
        body1, body2 = pump.jobs[0]['json'], pump.jobs[1]['json']
        self.assertEqual(body1['store'], False)
        self.assertEqual(body1['input'][0]['content'][1]['type'], 'input_image')
        self.assertEqual([m['role'] for m in body2['input']], ['user', 'assistant', 'user'])
        self.assertEqual(len(body2['input'][0]['content']), 1, 'the page image is not repeated')
        self.assertEqual(pump.jobs[0]['accept'], 'text/event-stream')
        with self.assertRaises(LoginError) as changed:
            chatgpt.endpoint_generate(OFFICIAL, 'x', remote, 'gpt-6-mini', lambda: None, lambda: None)
        self.assertEqual(changed.exception.code, 'login_chat_context_changed')

    def test_errors(self):
        cases = [
            ({'status': 200, 'content_type': '', 'body': stream('x', terminal='response.incomplete')}, 'login_endpoint_rejected'),
            ({'status': 200, 'content_type': '', 'body': 'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached"}}}\n\n'}, 'login_quota_exceeded'),
            ({'status': 200, 'content_type': '', 'body': 'data: {"type":"response.output_text.delta","delta":"half"}\n\n'}, 'login_endpoint_response_invalid'),
            ({'status': 401, 'content_type': 'application/json', 'body': '{}'}, 'login_session_expired'),
            ({'status': 429, 'content_type': 'application/json', 'body': '{}', 'headers': {'retry-after': '30'}}, 'login_quota_exceeded'),
            ({'error': 'signed_out'}, 'login_session_expired'),
        ]
        for answer, code in cases:
            with self.subTest(code=code), Pump(lambda job, a=answer: a):
                with self.assertRaises(LoginError) as raised:
                    chatgpt.endpoint_generate(OFFICIAL, 'p', {}, 'gpt-6.1-sol', lambda: None, lambda: None)
                self.assertEqual(raised.exception.code, code)


class Website(unittest.TestCase):
    def answer(self, job):
        action = job['webchat']
        if action['action'] == 'probe':
            return {'status': 200, 'content_type': 'application/json', 'body': json.dumps({'ready': True, 'account': action['account']})}
        handle = action['chat'] or 'wc_' + 'c' * 32
        # .82: every website turn ends with the code-block reply format.
        assert action['prompt'].endswith(chatgpt.WEBSITE_REPLY_FORMAT), action['prompt'][-80:]
        prompt = action['prompt'][:-len(chatgpt.WEBSITE_REPLY_FORMAT)]
        return {'status': 200, 'content_type': 'application/json', 'body': json.dumps({'text': 'คำแปล ' + prompt[-3:], 'chat': handle})}

    def test_probe_and_turns_reuse_the_tab_conversation(self):
        remote, dispatched = {}, []
        with Pump(self.answer) as pump:
            result = chatgpt.endpoint_validate(WEBSITE, lambda: None)
            first = chatgpt.endpoint_generate(WEBSITE, 'SYSTEM\n\nabc', remote, 'web-current', lambda: None, lambda: dispatched.append(1))
            second = chatgpt.endpoint_generate(WEBSITE, 'def', remote, 'web-current', lambda: None, lambda: dispatched.append(2))
        self.assertEqual([row['id'] for row in result['models']], ['web-current'])
        self.assertFalse(result['models'][0]['model_capabilities']['vision']['supported'])
        self.assertEqual(result['identity'], 'chatgpt-website\0' + ACCOUNT)
        self.assertEqual((first['text'], second['text']), ('คำแปล abc', 'คำแปล def'))
        self.assertEqual(dispatched, [1, 2])
        turns = [job['webchat'] for job in pump.jobs if job['webchat']['action'] == 'turn']
        self.assertEqual([t['chat'] for t in turns], ['', 'wc_' + 'c' * 32])
        self.assertTrue(all(job['provider'] == 'login_chatgpt_web' and job['method'] == 'WEBCHAT' for job in pump.jobs))

    def test_probe_account_mismatch_and_errors(self):
        with Pump(lambda job: {'status': 200, 'body': json.dumps({'ready': True, 'account': 'b' * 64})}):
            with self.assertRaises(LoginError) as changed:
                chatgpt.endpoint_validate(WEBSITE, lambda: None)
        self.assertEqual(changed.exception.code, 'login_account_changed')
        for code, expected in (('chat_lost', 'login_chat_lost'), ('limit', 'login_quota_exceeded'),
                               ('challenge', 'login_endpoint_challenge_required'), ('signed_out', 'login_session_expired'),
                               ('network', 'login_endpoint_transport_failed')):
            with self.subTest(code=code), Pump(lambda job, c=code: {'error': c}):
                with self.assertRaises(LoginError) as raised:
                    chatgpt.endpoint_generate(WEBSITE, 'p', {}, 'web-current', lambda: None, lambda: None)
                self.assertEqual(raised.exception.code, expected)

    def test_image_and_model_are_checked_before_any_send(self):
        with Pump(self.answer) as pump:
            with self.assertRaises(LoginError) as image:
                chatgpt.endpoint_generate(WEBSITE, 'p', {}, 'web-current', lambda: None, lambda: None,
                                          image=(b'\xff\xd8\xff0', 'image/jpeg'))
            with self.assertRaises(LoginError) as other:
                chatgpt.endpoint_generate(WEBSITE, 'p', {}, 'gpt-6.1-sol', lambda: None, lambda: None)
        self.assertEqual((image.exception.code, other.exception.code), ('login_image_unsupported', 'login_model_unavailable'))
        self.assertEqual(pump.jobs, [])

    def test_no_extension_means_relay_unavailable(self):
        from backend.ai.login.endpoint.login_endpoint_http import relay_webchat
        relay.clear()
        original = relay.submit
        relay.submit = lambda job, check, **kw: original(job, check, claim_timeout=.2)
        try:
            with relay.owner('owner-a'), self.assertRaises(LoginError) as raised:
                relay_webchat('login_chatgpt_web', {'action': 'probe', 'account': ACCOUNT}, lambda: None)
        finally:
            relay.submit = original
        self.assertEqual(raised.exception.code, 'login_browser_relay_unavailable')


class EndToEnd(unittest.TestCase):
    """Login adapter -> endpoint run -> ChatGPT module -> relay -> fake extension."""
    def setUp(self):
        import os
        from unittest.mock import patch
        from backend.ai.login import login_session_store as store
        from backend.ai.login.endpoint import login_endpoint_runs as runs
        self.store, self.runs = store, runs
        store.clear(); runs.clear()
        self.patches = [patch.dict(os.environ, {'TP_AI_WIRE_TRACE': '0', 'TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS': '0',
                                                'TP_LOGIN_ENABLED_PROVIDERS': 'login_chatgpt,login_claude,login_gemini,login_deepseek'}),
                        patch('backend.ai.accounting.mark_dispatched'),
                        patch.object(routes.login_entitlement, 'authorize', return_value='fiction-owner')]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self.store.clear(); self.runs.clear()

    def request(self, session, model_id, op, source):
        from types import SimpleNamespace
        return SimpleNamespace(api_key='x' * 48, model=session['id'] + '/' + model_id, image_b64='',
            system_text='Translate into Thai.', user_parts=['<<I1_P0:' + source + '>>'], history_messages=[],
            cache_context={'webchatRunId': 'run-1', 'operationId': op, 'conversationSource': '<<I1_P0:' + source + '>>'},
            cancel_check=None, thinking='default')

    def run_two(self, credentials, model_id, answer):
        from backend.ai.login import login_translation as translation
        row = chatgpt.website_model() if credentials['mode'] == 'website' else chatgpt.official_model(MODELS['models'][0])
        session = self.store.bind_native('fiction-owner', 'login_chatgpt', chatgpt.identity_of(credentials),
            {'transport': 'web_endpoint', 'credentials': dict(credentials), 'models': [row], 'no_refresh': True})
        with Pump(answer, scope=session['owner']) as pump:
            first = translation.ADAPTER.generate(self.request(session, model_id, 'op-1', 'Hello'))
            second = translation.ADAPTER.generate(self.request(session, model_id, 'op-2', 'Bye'))
        return first, second, pump.jobs

    def test_official_two_turns(self):
        responses = [stream('สวัสดี'), stream('ลาก่อน')]
        first, second, jobs = self.run_two(OFFICIAL, 'gpt-6.1-sol', lambda job: official_answer(job, responses))
        self.assertEqual((first.text, second.text), ('สวัสดี', 'ลาก่อน'))
        prompts = [job['json']['input'][-1]['content'][0]['text'] for job in jobs]
        self.assertTrue(prompts[0].startswith('Translate into Thai.'), 'first turn carries the instructions')
        self.assertEqual(prompts[1], '<<I1_P0:Bye>>', 'later turns send only the new source')

    def test_website_two_turns(self):
        def answer(job):
            action = job['webchat']
            prompt = action['prompt'][:-len(chatgpt.WEBSITE_REPLY_FORMAT)] if action['prompt'].endswith(chatgpt.WEBSITE_REPLY_FORMAT) else 'missing-format'
            return {'status': 200, 'body': json.dumps({'text': 'ตอบ ' + prompt[-8:], 'chat': action['chat'] or 'wc_' + 'd' * 32})}
        first, second, jobs = self.run_two(WEBSITE, 'web-current', answer)
        self.assertTrue(first.text.endswith(':Hello>>') and second.text.endswith(':Bye>>'), (first.text, second.text))
        self.assertEqual([job['webchat']['chat'] for job in jobs], ['', 'wc_' + 'd' * 32])


if __name__ == '__main__':
    unittest.main(verbosity=2)
