"""Capture actual Anthropic adapter payloads; fake only HTTP, never call a provider."""
import copy
import os
import sys
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
import httpx
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.providers import cloud_anthropic as provider
from backend.ai.provider_contract import GenerationRequest, SystemPromptSection
from backend.ai.clients.base import ProviderGenerationCancelled


class ConversationCacheTests(unittest.TestCase):
    def setUp(self):
        self.payloads = []
        self.request = GenerationRequest(provider='anthropic', model='claude-sonnet-4-6',
            api_key='fixture-not-a-real-key', system_text='STABLE SYSTEM',
            system_sections=(SystemPromptSection('system', 'STABLE SYSTEM', cacheable=True),),
            user_parts=('<<I1_P0:hello>>',), thinking='off',
            cache_context={'translationMode': 'conversation'})
        self.adapter = provider.AnthropicAdapter()
        self.env = patch.dict(os.environ, {'TP_PROMPT_CACHE': 'auto'})
        self.env.start(); self.addCleanup(self.env.stop)

    def post(self, url, **kw):
        self.payloads.append(copy.deepcopy(kw['json']))
        return httpx.Response(200, request=httpx.Request('POST', url), json={
            'id': 'fixture-reply', 'stop_reason': 'end_turn',
            'content': [{'type': 'text', 'text': '<<I1_P0:สวัสดี>>'}],
            'usage': {'input_tokens': 11, 'cache_read_input_tokens': 22,
                      'cache_creation_input_tokens': 33, 'output_tokens': 7}})

    def dispatch(self, req):
        with patch.object(provider, 'post_json', side_effect=self.post):
            return self.adapter.generate(req)

    def test_first_turn_caches_current_input_without_history(self):
        result = self.dispatch(self.request)
        p = self.payloads[0]
        self.assertEqual(p['cache_control'], {'type': 'ephemeral'})
        self.assertEqual(p['messages'], [{'role': 'user', 'content': '<<I1_P0:hello>>'}])
        self.assertEqual(p['system'][0]['cache_control'], {'type': 'ephemeral'})
        self.assertEqual(len(self.payloads), 1)
        self.assertEqual(result.input_tokens, 66)
        self.assertEqual(result.cached_input_tokens, 22)
        self.assertEqual(result.usage_details['cacheWriteInputTokens'], 33)

    def test_continuation_and_repair_keep_exact_native_prefix(self):
        history = []
        previous = None
        for turn in range(1, 8):
            text = f'<<I{turn}_P0:source {turn}>>'
            req = replace(self.request, user_parts=(text,), history_messages=tuple(history))
            before = [dict(m) for m in req.history_messages]
            self.dispatch(req)
            current = self.payloads[-1]
            self.assertEqual([dict(m) for m in req.history_messages], before)
            if previous:
                self.assertEqual(current['messages'][:len(previous['messages'])], previous['messages'])
                self.assertEqual(current['system'], previous['system'])
            self.assertEqual(current['cache_control'], {'type': 'ephemeral'})
            self.assertEqual(len(current['messages']), 2 * turn - 1)
            history.extend([{'role':'user', 'text':text}, {'role':'assistant', 'text':f'<<I{turn}_P0:คำแปล>>'}])
            previous = current
        self.assertEqual(len(self.payloads), 7, 'no warmup, extra generation, or retry')

    def test_independent_does_not_cache_one_off_current_input(self):
        self.dispatch(replace(self.request, cache_context={}))
        p = self.payloads[0]
        self.assertNotIn('cache_control', p)
        self.assertIn('cache_control', p['system'][0])

    def test_off_disables_all_cache_hints(self):
        with patch.dict(os.environ, {'TP_PROMPT_CACHE': 'off'}):
            self.dispatch(self.request)
        p = self.payloads[0]
        self.assertNotIn('cache_control', p)
        self.assertNotIn('cache_control', p['system'][0])

    def test_more_sections_reserve_slot_without_changing_text_or_input(self):
        sections = tuple(SystemPromptSection(f'part-{i}', f'text-{i}', cacheable=True) for i in range(8))
        self.dispatch(replace(self.request, system_sections=sections))
        p = self.payloads[0]
        self.assertEqual([b['text'] for b in p['system']], [s.text for s in sections])
        self.assertEqual(sum('cache_control' in b for b in p['system']) + ('cache_control' in p), 4)
        self.assertTrue(all(s.cacheable for s in sections))

    def test_vision_history_is_not_rewritten_or_reordered(self):
        history = ({'role':'user','text':'old','image_b64':'Zml4dHVyZQ==','image_mime':'image/png'},
                   {'role':'assistant','text':'previous answer'})
        self.dispatch(replace(self.request, history_messages=history, image_b64='bmV3', image_mime='image/png'))
        p = self.payloads[0]
        self.assertEqual([m['role'] for m in p['messages']], ['user','assistant','user'])
        self.assertEqual(p['messages'][0]['content'][0]['source']['data'], 'Zml4dHVyZQ==')
        self.assertEqual(p['messages'][-1]['content'][0]['source']['data'], 'bmV3')
        self.assertEqual(history[0]['text'], 'old')

    def test_cancelled_before_io_does_not_dispatch(self):
        with self.assertRaises(ProviderGenerationCancelled):
            self.dispatch(replace(self.request, cancel_check=lambda: True))
        self.assertEqual(self.payloads, [])

    def test_stream_uses_same_caching_and_keeps_terminal_usage(self):
        from backend.ai.transports import native_stream
        with patch.object(provider.content_stream, 'active', return_value=True), \
             patch.object(native_stream, 'post_native_stream', side_effect=self.post):
            result = self.adapter.generate(self.request)
        self.assertTrue(self.payloads[0]['stream'])
        self.assertEqual(self.payloads[0]['cache_control'], {'type':'ephemeral'})
        self.assertEqual(result.usage_details['cacheWriteInputTokens'], 33)
        self.assertEqual(result.usage_details['totalTokens'], 73)
        self.assertEqual(len(self.payloads),1)

if __name__ == '__main__':
    unittest.main(verbosity=2)
