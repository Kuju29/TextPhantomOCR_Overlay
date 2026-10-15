""".92 owner goal (2026-10-15): choose the Login Claude model and AI think in the
extension, press Translate, and claude.ai applies it.

Evidence (sanitized owner captures, docs/login-web-fields-10492.md):
- app_start `model_selector_config` group "chat" is the website's chat picker:
  section main/overflow/deprecated, disabled + disabled_reason.required_plan +
  badge.message, and `thinking` (effort_and_mode / mode / none);
- the completion body carries `"effort": <id>` and `"thinking_mode": <id>`; the
  model_selector_state PATCH is only the picker's memory.

Checks: catalogue rows (deprecated hidden, plan-disabled rows with their badge,
fallback only for ids the picker does not describe), AI think records feed the
shared thinking-state classification, completion bodies match the website,
"provider default" sends neither field, an unsupported setting or plan-disabled
model sends nothing, no PATCH is made, and the invocation path gives the
user's choice to endpoint_generate. Offline: fictional HTTP only."""
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
from backend.ai.provider_resolution import normalize_model_capabilities  # noqa: E402
from backend.ai.reasoning_preference import resolve_reasoning_preference  # noqa: E402
from backend.ai.thinking_state import classify_thinking_state, thinking_control_options  # noqa: E402
from login_relay_fixture import relay_via  # noqa: E402

CLIENT = httpx.Client
ORG = 'org-fixture'


def effort(*ids, recommended='medium'):
    return [{'id': i, **({'recommended': True} if i == recommended else {})} for i in ids]


EFFORT_AUTO = {'type': 'effort_and_mode', 'effort_options': effort('low', 'medium', 'high', 'xhigh', 'max'),
               'mode_options': [{'id': 'auto'}]}
EFFORT_AUTO_OFF = {'type': 'effort_and_mode', 'effort_options': effort('low', 'medium', 'high', 'max'),
                   'mode_options': [{'id': 'auto'}, {'id': 'off'}]}
EFFORT_EXTENDED_OFF = {'type': 'effort_and_mode', 'effort_options': effort('low', 'medium', 'high'),
                       'mode_options': [{'id': 'extended'}, {'id': 'off'}]}
MODE = {'type': 'mode', 'mode_options': [{'id': 'extended'}, {'id': 'off'}]}
UPGRADE = {'type': 'upgrade_required', 'required_plan': 'pro'}

# Shapes and Free-plan values as in the capture; model ids are fictional.
APP_START = {
    'claude_ai_available_models': {'models': [
        {'model_id': 'claude-sonnet-fx', 'minimum_tier': 'free'}, {'model_id': 'claude-opus-fx', 'minimum_tier': 'pro'},
        {'model_id': 'claude-fable-fx', 'minimum_tier': 'pro'}, {'model_id': 'claude-haiku-fx', 'minimum_tier': 'free'},
        {'model_id': 'claude-old-fx', 'minimum_tier': 'free'}, {'model_id': 'claude-listed-only-fx', 'minimum_tier': 'free'}]},
    'model_selector_config': [
        {'id': 'code', 'models': [{'id': 'claude-code-only-fx', 'section': 'main', 'thinking': {'type': 'none'}}]},
        {'id': 'chat', 'settings_vocabulary': {}, 'models': [
            {'id': 'claude-sonnet-fx', 'name': 'Sonnet FX', 'section': 'main', 'disabled': None, 'disabled_reason': None,
             'capabilities': {'mm_images': True}, 'thinking': EFFORT_AUTO},
            {'id': 'claude-opus-fx', 'name': 'Opus FX', 'section': 'main', 'disabled': True, 'disabled_reason': UPGRADE,
             'badge': {'message': 'Pro'}, 'selection_notice': {'title': 'Upgrade to use Pro', 'text': 'This model requires a Pro plan.'},
             'thinking': EFFORT_AUTO},
            {'id': 'claude-fable-fx', 'name': 'Fable FX', 'section': 'main', 'disabled': True, 'disabled_reason': UPGRADE,
             'badge': {'message': 'Pro or Max'}, 'thinking': EFFORT_AUTO_OFF},
            {'id': 'claude-sonnet-prev-fx', 'name': 'Sonnet prev FX', 'section': 'overflow', 'disabled': None,
             'thinking': EFFORT_EXTENDED_OFF},
            {'id': 'claude-haiku-fx', 'name': 'Haiku FX', 'section': 'overflow', 'disabled': None, 'thinking': MODE},
            {'id': 'claude-old-fx', 'name': 'Old FX', 'section': 'deprecated', 'disabled': True, 'disabled_reason': None,
             'thinking': {'type': 'none'}},
        ]},
    ],
}


def claude_wire(text, mid):
    events = [{'type': 'message_start', 'message': {'uuid': mid, 'role': 'assistant'}},
              {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
              {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}},
              {'type': 'content_block_stop', 'index': 0},
              {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}}, {'type': 'message_stop'}]
    return ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()


class Upstream:
    def __init__(self, app_start=APP_START):
        self.app_start, self.calls, self.bodies = app_start, [], []

    def __call__(self, request):
        self.calls.append((request.method, request.url.path))
        path = request.url.path
        if path == '/api/bootstrap':
            return httpx.Response(200, json={'account': {'uuid': 'account-fixture', 'lastActiveOrgId': ORG}})
        if path == '/api/organizations':
            return httpx.Response(200, json=[{'uuid': ORG}])
        if path.endswith('/app_start'):
            return httpx.Response(200, json=self.app_start)
        if path.endswith('/completion'):
            self.bodies.append(json.loads(request.content))
            return httpx.Response(200, content=claude_wire('<<I1_P0:สวัสดี>>', 'answer-' + str(len(self.bodies))),
                                  headers={'content-type': 'text/event-stream'})
        return httpx.Response(404, json={})

    def transport(self):
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch.object(endpoint.httpx, 'Client',
            side_effect=lambda **kw: CLIENT(transport=httpx.MockTransport(self), **kw)))
        stack.enter_context(patch.object(endpoint.diagnostic, 'emit'))
        stack.enter_context(patch.object(endpoint.diagnostic, 'stage'))
        stack.enter_context(relay_via(self))
        return stack


def catalogue(app_start=APP_START):
    upstream = Upstream(app_start)
    with upstream.transport():
        return claude.endpoint_validate({'organization': ORG}, lambda: None)['models']


class ClaudeCatalogue(unittest.TestCase):
    def test_chat_picker_rows(self):
        rows = {row['id']: row for row in catalogue()}
        # Chat picker order (main, overflow), deprecated hidden, other groups
        # ignored; ids the picker does not describe fall back to the plain list.
        self.assertEqual(list(rows), ['claude-sonnet-fx', 'claude-opus-fx', 'claude-fable-fx', 'claude-sonnet-prev-fx',
                                      'claude-haiku-fx', 'claude-listed-only-fx'])
        self.assertEqual(rows['claude-sonnet-fx']['name'], 'Sonnet FX')
        self.assertNotIn('availability', rows['claude-sonnet-fx'])
        self.assertEqual(rows['claude-opus-fx']['availability'], {'usable': False, 'reason': 'plan_required',
            'evidence': 'claude_model_selector_disabled', 'required_plan': 'pro', 'badge': 'Pro'})
        self.assertEqual(rows['claude-fable-fx']['availability']['badge'], 'Pro or Max')
        # The fallback row keeps the previous website-managed default (403 backstop).
        listed = rows['claude-listed-only-fx']
        self.assertEqual(listed['model_capabilities']['reasoning'], {'supported': None, 'control': 'provider', 'app_controlled': False})
        self.assertNotIn('availability', listed)

    def test_ai_think_records_offer_exactly_the_website_levels(self):
        rows = {row['id']: row for row in catalogue()}
        expect = {'claude-sonnet-fx': ['low', 'medium', 'high', 'xhigh', 'max'],
                  'claude-fable-fx': ['off', 'low', 'medium', 'high', 'max'],
                  'claude-sonnet-prev-fx': ['off', 'low', 'medium', 'high'],
                  'claude-haiku-fx': ['off', 'on'], 'claude-listed-only-fx': []}
        for mid, options in expect.items():
            reasoning = rows[mid]['model_capabilities']['reasoning']
            self.assertEqual(list(thinking_control_options(reasoning)), options, mid)
            # Same answer after the API's capability normalizer (what invocation classifies).
            normalized = normalize_model_capabilities(rows[mid]['model_capabilities']).get('reasoning', {})
            self.assertEqual(list(thinking_control_options(normalized)), options, mid)
        sonnet = rows['claude-sonnet-fx']['model_capabilities']['reasoning']
        self.assertIs(sonnet['app_controlled'], True)
        self.assertEqual(sonnet['default_effort'], 'medium')
        self.assertEqual(classify_thinking_state(sonnet, fresh=True), 'controllable')
        # Lowest available: Off where the website has Off, else its lowest effort.
        self.assertEqual(resolve_reasoning_preference('minimum', sonnet), 'low')
        self.assertEqual(resolve_reasoning_preference('minimum', rows['claude-fable-fx']['model_capabilities']['reasoning']), 'off')
        none, spec = claude.website_thinking({'type': 'none'})
        self.assertEqual((none['supported'], spec), (False, {'type': 'none'}))
        self.assertEqual(classify_thinking_state(none, fresh=True), 'none')
        for odd in (None, {}, {'type': 'future'}, {'type': 'effort_and_mode', 'effort_options': [{'id': 'Bad Id'}]},
                    {'type': 'effort_and_mode', 'effort_options': [], 'mode_options': []}):
            self.assertEqual(claude.website_thinking(odd), (None, None), odd)

    def test_public_rows_hide_the_send_spec_and_saved_rows_upgrade(self):
        rows = catalogue()
        public = login_profiles.public_models(rows)
        self.assertTrue(all('_metadata' not in row for row in public))
        self.assertEqual(claude.endpoint_model_rows(rows), rows, 'chat-picker rows are kept as they are')
        legacy = claude.website_model('claude-sonnet-fx')
        self.assertEqual(claude.endpoint_model_rows([legacy])[0]['model_capabilities']['reasoning']['app_controlled'], False)

    def test_without_the_chat_group_the_plain_list_is_used(self):
        rows = catalogue({'claude_ai_available_models': APP_START['claude_ai_available_models']})
        self.assertEqual([row['id'] for row in rows], [m['model_id'] for m in APP_START['claude_ai_available_models']['models']])
        self.assertTrue(all(row['model_capabilities']['reasoning']['app_controlled'] is False for row in rows))


class ClaudeCompletionBody(unittest.TestCase):
    def setUp(self):
        store.clear(); runs.clear()
        self.env = patch.dict(os.environ, {'TP_CENTER_URL': 'http://127.0.0.1:9999', 'TP_AI_WIRE_TRACE': '0',
            'TP_LOGIN_ENABLED_PROVIDERS': 'login_chatgpt,login_claude,login_gemini,login_deepseek',
            'TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS': '0'})
        self.env.start()
        self.auth = patch.object(routes.login_entitlement, 'authorize', return_value='fiction-owner')
        self.auth.start()
        self.session = store.bind_native('fiction-owner', 'login_claude', 'fiction-claude',
            {'transport': 'web_endpoint', 'credentials': {'organization': ORG}, 'models': catalogue(), 'no_refresh': True})
        self.upstream = Upstream()

    def tearDown(self):
        self.auth.stop(); self.env.stop(); store.clear(); runs.clear()

    def generate(self, model_id, thinking, run):
        request = SimpleNamespace(api_key='x' * 48, model=self.session['id'] + '/' + model_id, image_b64='',
            system_text='Translate into Thai.', user_parts=['<<I1_P0:Hello>>'], history_messages=[],
            cache_context={'webchatRunId': run, 'operationId': 'op-1', 'conversationSource': '<<I1_P0:Hello>>'},
            cancel_check=None, thinking=thinking)
        with self.upstream.transport(), patch.object(translation.diagnostic, 'emit'), \
                patch('backend.ai.accounting.mark_dispatched'), patch.object(native, 'module', return_value=claude):
            return translation.ADAPTER.generate(request)

    def sent(self):
        body = self.upstream.bodies[-1]
        return {key: body[key] for key in ('effort', 'thinking_mode') if key in body}

    def test_bodies_match_the_website(self):
        cases = [('claude-sonnet-fx', 'medium', {'effort': 'medium', 'thinking_mode': 'auto'}),
                 ('claude-sonnet-fx', 'xhigh', {'effort': 'xhigh', 'thinking_mode': 'auto'}),
                 ('claude-sonnet-fx', 'default', {}),
                 ('claude-sonnet-prev-fx', 'low', {'effort': 'low', 'thinking_mode': 'extended'}),
                 ('claude-sonnet-prev-fx', 'off', {'thinking_mode': 'off'}),
                 ('claude-haiku-fx', 'on', {'thinking_mode': 'extended'}),
                 ('claude-haiku-fx', 'off', {'thinking_mode': 'off'}),
                 ('claude-listed-only-fx', 'default', {})]
        for index, (mid, thinking, expected) in enumerate(cases):
            result = self.generate(mid, thinking, 'run-%d' % index)
            self.assertEqual(result.text, '<<I1_P0:สวัสดี>>')
            self.assertEqual(self.sent(), expected, (mid, thinking))
            self.assertEqual(self.upstream.bodies[-1]['model'], mid)
            self.assertEqual(result.thinking_applied, 'requested_' + thinking if expected else 'provider_default')
        # Only the completion is sent: the picker memory (model_selector_state) is never patched.
        self.assertTrue(all(path.endswith('/completion') for method, path in self.upstream.calls if method != 'GET'))
        self.assertFalse(any('model_selector_state' in path for _, path in self.upstream.calls))

    def test_unsupported_setting_and_plan_disabled_model_send_nothing(self):
        for mid, thinking, code in (('claude-sonnet-fx', 'off', 'ai_thinking_mode_unavailable'),
                                    ('claude-sonnet-prev-fx', 'max', 'ai_thinking_mode_unavailable'),
                                    ('claude-haiku-fx', 'high', 'ai_thinking_mode_unavailable'),
                                    ('claude-listed-only-fx', 'low', 'ai_thinking_mode_unavailable'),
                                    ('claude-opus-fx', 'medium', 'login_model_access_denied')):
            with self.assertRaises(LoginError) as caught:
                self.generate(mid, thinking, 'run-' + mid + thinking)
            self.assertEqual(caught.exception.code, code, (mid, thinking))
            self.assertFalse(getattr(caught.exception, 'requestDispatched', False))
        self.assertEqual(self.upstream.bodies, [], 'nothing reached claude.ai')


class InvocationPassesTheChoice(unittest.TestCase):
    """invocation.py gives the user's AI think to endpoint_generate for Claude."""

    def test_capability_flags(self):
        self.assertIs(claude.ENDPOINT_THINKING, True)
        self.assertIs(claude.ENDPOINT_MODEL_ROW, True)

    def test_runs_hands_thinking_and_the_verified_row(self):
        seen = {}
        rows = catalogue()

        class Site:
            ENDPOINT_THINKING = True
            ENDPOINT_MODEL_ROW = True

            @staticmethod
            def endpoint_generate(credentials, prompt, remote, selected, check, dispatch, **extra):
                seen.update(extra, selected=selected)
                dispatch()
                return {'text': 'ok', 'completed': True, 'statuses': [200], 'terminal': 'fixture'}

        request = SimpleNamespace(thinking='high', cache_context={'webchatRunId': 'run-x', 'operationId': 'op-x'},
            image_b64='', user_parts=('<<I1_P0:hi>>',), system_text='SYS', model='lgs_x/claude-sonnet-fx',
            history_messages=(), cancel_check=None)
        with patch.object(runs.store, 'credential_for_session',
                          return_value={'tokens': {'credentials': {}, 'models': rows}}), \
                patch.object(runs.store, 'active_session_ids', return_value={'lgs_fixture'}), \
                patch.object(runs.diagnostic, 'stage'), patch('backend.ai.wire_trace.write_json'), \
                patch('backend.ai.wire_trace.write_text'), patch('backend.ai.accounting.mark_dispatched'):
            runs.generate({'id': 'lgs_fixture', 'provider': 'login_claude'}, request, Site)
        self.assertEqual(seen['thinking'], 'high')
        self.assertEqual(seen['selected'], 'claude-sonnet-fx')
        self.assertEqual(seen['model_row']['_metadata']['thinking']['efforts'], ['low', 'medium', 'high', 'xhigh', 'max'])

    def test_translate_resolves_the_saved_choice_for_claude(self):
        from backend.ai import markers
        from backend.ai.clients.base import ChatResult
        from backend.ai.provider_registry import provider_registry
        from backend.ai.translation import invocation
        from backend.ai.translation.contracts import AiConfig
        if provider_registry.get('login') is None:
            provider_registry.register(translation.SPEC)
        caps = {'reasoning': claude.website_thinking({'type': 'effort_and_mode', 'mode_options': [{'id': 'auto'}],
            'effort_options': effort('low', 'medium', 'high')})[0]}
        model = 'lgs_' + 'a' * 48 + '/claude-sonnet-fx'

        def run(thinking):
            with patch.object(translation, 'authorize_model', return_value=('o', {'provider': 'login_claude', 'id': 'lgs_x'}, 'claude-sonnet-fx')), \
                    patch.object(store, 'credential_for_session', return_value={'tokens': {'transport': 'web_endpoint'}}), \
                    patch.object(native, 'module', return_value=claude), \
                    patch('backend.ai.provider_resolution.discovered_model_capabilities', return_value=(True, caps)), \
                    patch('backend.ai.provider_resolution.refresh_cloud_model_capabilities', return_value=(True, caps)), \
                    patch.object(invocation, 'assert_ai_base_url_allowed'), \
                    patch('backend.ai.accounting.generate_with_receipt', return_value=ChatResult('translated', model)) as sent, \
                    patch.object(invocation, 'decode_result', side_effect=lambda **v: {**v, 'meta': {'prompt_audit': {}}}), \
                    patch.object(invocation.trace_preview, 'note'):
                try:
                    invocation._translate_once_impl(markers.apply(['source']), 'th', AiConfig(api_key='tp_login_' + 'x' * 40,
                        provider='login', model=model, thinking=thinking, prompt_mode='replace', prompt_editable='Translate.'))
                except Exception as error:  # noqa: BLE001
                    self.assertEqual(sent.call_count, 0)
                    return getattr(error, 'code', type(error).__name__)
                return sent.call_args.args[1].thinking

        # The saved choice reaches the Claude request; Lowest is the website's lowest
        # effort; a choice the website does not offer stops before sending.
        self.assertEqual([run(value) for value in ('medium', 'high', 'minimum', 'default', 'off', 'max')],
                         ['medium', 'high', 'low', 'default', 'ai_thinking_off_unavailable', 'ai_thinking_mode_unavailable'])


if __name__ == '__main__':
    unittest.main()
