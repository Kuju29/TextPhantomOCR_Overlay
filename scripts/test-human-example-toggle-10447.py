"""Selected human-example toggle through real API config and native serializers.

Manual/Paid HTTP and Gemini/DeepSeek web-session forms use fictional
MockTransport responses only. No live generation/account/billing occurs.
"""
from contextlib import ExitStack
from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('human_native_fixture_10443',
    ROOT / 'scripts/test-human-example-delivery-10443.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
from backend.application.ai_translation.request_validation import build_config
from backend.jobs.stages.config import build_ai_config
from backend.ai.prompts.builder import build_static_user_prefix
from backend.ai.prompts.layout import prompt_layout
from backend.ai.translation_paths.mode import scope_material
from backend.ai.translation_paths import store
from backend.jobs.cache import build_cache_key

ABSENT = object()


def canonical(provider, value, *, model='synthetic-model', key='synthetic-key', label='fixture'):
    memory = {'mode': 'full', 'seriesState': native.MEMORY}
    if value is not ABSENT:
        memory['styleExamples'] = value
    return {'schema': 'tp.ai.request/1', 'translationMode': 'conversation',
        'units': [{'id': 'I1_P0', 'text': native.MIXED[0]}], 'targetLang': 'th', 'sourceLang': 'ja',
        'prompt': native.STYLE, 'provider': {'id': provider, 'model': model,
            'apiKey': key, 'thinking': 'default'}, 'memory': memory,
        'conversation': {'documentId': 'human-toggle-47-' + label,
                         'webchatRunId': 'human-toggle-run-' + label,
                         'origins': native.origins(1)},
        'context': {'tp_tab_session': 'synthetic-owner'},
        'repair': {'owner': 'extension', 'enabled': False}}


class HumanExampleToggle(unittest.TestCase):
    def setUp(self):
        store._stores.clear()
        self.addCleanup(store._stores.clear)

    def check_anchor(self, text, enabled):
        expected = [f'H{i:02}' for i in range(1, 21)] if enabled else []
        self.assertEqual(native.example_ids(text), expected)
        if enabled:
            for row in native.STYLE_EXAMPLES[:20]:
                for lang in ('en', 'ja', 'th'):
                    self.assertIn(f'{lang.upper()}: {row[lang]}', text)
        self.assertNotIn('H21\nEN:', text)
        self.assertEqual(text.count(native.MEMORY), 1)

    def native_case(self, method, value, label):
        runner = native.HumanExampleDelivery(method)
        runner.setUp()
        expected = value is True
        def selected(provider, *, model, key):
            canonical_provider = 'paid' if provider == 'tp' else 'login' if provider.startswith('login_') else provider
            config = build_config(canonical(canonical_provider,
                value, model=model, key=key, label=label))
            runner.selected_style = config.prompt_editable
            return config
        runner.normal_config = selected
        runner.check_bootstrap = lambda text: self.check_anchor(text, expected)
        try:
            getattr(runner, method)()
        finally:
            runner.doCleanups()

    def test_gemini_actual_form_default_off_explicit_off_and_on(self):
        for label, value in [('absent', ABSENT), ('off', False), ('on', True)]:
            with self.subTest(preference=label):
                self.native_case('test_actual_gemini_login_form_preserves_first_examples_and_remote_continuation',
                    value, 'gemini-' + label)

    def test_deepseek_actual_http_default_off_explicit_off_and_on(self):
        for label, value in [('absent', ABSENT), ('off', False), ('on', True)]:
            with self.subTest(preference=label):
                self.native_case('test_actual_deepseek_login_http_preserves_first_examples_and_parent',
                    value, 'deepseek-' + label)

    def test_paid_actual_http_default_off_explicit_off_and_on(self):
        for label, value in [('absent', ABSENT), ('off', False), ('on', True)]:
            with self.subTest(preference=label):
                self.native_case('test_actual_paid_http_body_keeps_examples_and_owned_history', value, 'paid-' + label)

    def test_manual_actual_http_default_off_explicit_off_and_on(self):
        for label, value in [('absent', ABSENT), ('off', False), ('on', True)]:
            with self.subTest(preference=label), ExitStack() as stack:
                requests = []
                stack.enter_context(patch.dict(native.os.environ,
                    {'TP_AI_WIRE_TRACE': '0', 'TP_USAGE_RECEIPTS': 'off'}))
                stack.enter_context(patch('backend.ai.provider_resolution.discovered_model_capabilities',
                    return_value=(True, {'reasoning': {'supported': False, 'mandatory': False}})))
                def upstream(request):
                    self.assertEqual(str(request.url), 'https://api.openai.com/v1/chat/completions')
                    body = json.loads(request.content)
                    requests.append(body)
                    text = native.answer(body['messages'][-1]['content'])
                    frame = {'id': 'synthetic-response', 'model': 'synthetic-model',
                        'choices': [{'delta': {'content': text}, 'finish_reason': 'stop'}]}
                    return native.httpx.Response(200, content=('data: ' +
                        json.dumps(frame, ensure_ascii=False) + '\n\ndata: [DONE]\n\n').encode(),
                        headers={'Content-Type': 'text/event-stream'})
                stack.enter_context(patch('backend.ai.transports.openai_compat.core.httpx.Client',
                    side_effect=lambda **kw: native.REAL_CLIENT(
                        transport=native.httpx.MockTransport(upstream), **kw)))
                ai = build_config(canonical('openai', value, label='manual-' + label))
                native.invoke_three(ai)
                self.assertEqual(len(requests), 3)
                self.check_anchor(requests[0]['messages'][-1]['content'], value is True)
                self.assertEqual(requests[0]['messages'][0]['content'].count(native.STYLE), 1)
                for turn, body in enumerate(requests[1:], 2):
                    latest = body['messages'][-1]['content']
                    self.assertEqual(latest, f'<<I{turn}_P0:{native.MIXED[turn-1]}>>')
                    self.assertEqual(native.example_ids(latest), [])
                    self.assertEqual(body['messages'][1], requests[0]['messages'][1])
                    human_copies = sum(m['content'].count('H01\nEN:')
                        for m in body['messages'] if isinstance(m.get('content'), str))
                    self.assertEqual(human_copies, 1 if value is True else 0)

    def test_canonical_queued_and_low_level_defaults_are_off(self):
        self.assertIs(native.AiConfig(api_key='synthetic').style_examples, False)
        for provider in ('openai', 'paid', 'login_gemini', 'login_deepseek'):
            for value in (ABSENT, False, True):
                with self.subTest(provider=provider, value=value is True):
                    cfg = build_config(canonical(provider, value, label=provider))
                    self.assertIs(cfg.style_examples, value is True)
                    ai = {'provider': provider, 'api_key': 'synthetic', 'memory_mode': 'off'}
                    if value is not ABSENT:
                        ai['style_examples'] = value
                    cfg = build_ai_config({'ai': ai}, 'lens_text', 'ai')
                    self.assertIs(cfg.style_examples, value is True)

    def test_both_ingress_shapes_reject_non_boolean_preferences(self):
        for value in ('true', 'false', 1, 0, [], {}, None):
            with self.subTest(value_type=type(value).__name__):
                with self.assertRaises(ValueError):
                    build_config(canonical('openai', value))
                with self.assertRaises(ValueError):
                    build_ai_config({'ai': {'provider': 'openai', 'api_key': 'synthetic',
                        'style_examples': value}}, 'lens_text', 'ai')

    def test_builder_and_layout_default_off_without_changing_corpus(self):
        prefix = build_static_user_prefix('th', selected_style=native.STYLE)
        self.assertEqual(native.example_ids(prefix), [])
        system = native.invocation.prompts.build_translator_identity_system(native.STYLE, 'th')
        layout = prompt_layout(system, prefix + '\n\nSynthetic source', lang='th', selected_style=native.STYLE)
        self.assertIs(layout['examplesEnabled'], False)
        self.assertIs(layout['examplesIncluded'], False)
        self.assertEqual(layout['bootstrapExamplesChars'], 0)
        self.assertEqual(len(native.STYLE_EXAMPLES), 69)
        self.assertEqual({k for row in native.STYLE_EXAMPLES for k in row}, {'id', 'en', 'ja', 'th'})

    def test_toggle_separates_cache_and_conversation_owners(self):
        off = build_config(canonical('openai', False))
        on = replace(off, style_examples=True)
        self.assertNotEqual(scope_material(off, 'th'), scope_material(on, 'th'))
        self.assertNotEqual(build_cache_key('image', 'th', 'lens_text', 'ai', off, owner_scope='owner'),
                            build_cache_key('image', 'th', 'lens_text', 'ai', on, owner_scope='owner'))
        default = native.AiConfig(api_key=off.api_key, provider=off.provider, model=off.model,
            base_url=off.base_url, prompt_editable=off.prompt_editable, prompt_mode=off.prompt_mode,
            conversation=off.conversation, memory_mode=off.memory_mode, thinking=off.thinking)
        self.assertEqual(scope_material(default, 'th'), scope_material(off, 'th'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
