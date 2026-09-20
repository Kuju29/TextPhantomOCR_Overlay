"""Exact selected-model evidence must survive a metadata-only catalogue refresh.
All providers/HTTP are mocked. Includes the sequence observed in logs-13.2(1).
"""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.provider_bootstrap import ensure_provider_registry
ensure_provider_registry()
from backend.ai import provider_resolution as cache, resolve as resolver, probe as probing
from backend.ai.providers import cloud_huggingface as hf
from backend.ai.provider_contract import GenerationRequest, ModelListResult, ProbeResponse
from backend.ai.clients.base import ChatResult

MODEL = 'deepseek-ai/DeepSeek-V4-Flash-0731'
KEY = 'hf_fixture_no_network'
BASE = hf.DEFAULT_BASE_URL
CAP = {'reasoning': {'supported': True, 'mandatory': False, 'control': 'levels', 'supported_efforts': ['none', 'low'], 'dynamic': True}}

class EvidenceRefresh(unittest.TestCase):
    def setUp(self):
        cache._MODEL_CAPABILITIES.clear()
        cache._MODEL_PROMOTIONS.clear()
        probing._PROBE_CACHE.clear()
        self.clock = patch.object(cache.time, 'monotonic', return_value=1000.)
        self.clock_mock = self.clock.start()
        self.addCleanup(self.clock.stop)
    def refresh(self, models=None, caps=None):
        listed = ModelListResult(models=[MODEL] if models is None else models,
                                 capabilities=caps or {}, status='valid', http_status=200)
        with patch.object(hf.ADAPTER, 'list_models', return_value=listed):
            return resolver._enumerate_models_detailed('huggingface', KEY, BASE)
    def selected(self):
        cache.remember_selected_model_capability('huggingface', BASE, KEY, MODEL, CAP)
    def evidence(self, **kwargs):
        return cache.discovered_model_capabilities(kwargs.get('provider','huggingface'),
             kwargs.get('base',BASE), kwargs.get('model',MODEL), kwargs.get('key',KEY))
    def payload(self):
        _, caps = self.evidence()
        request = GenerationRequest(provider='huggingface', model=MODEL, api_key=KEY,
             base_url=BASE, system_text='unchanged system', user_parts=('<<TP_P0:Hello>>',),
             expected_ids=('P0',), unit_count=1, thinking='off', model_capabilities=caps)
        with patch.object(hf, 'execute_huggingface_chat', return_value=ChatResult('<<TP_P0:สวัสดี>>', MODEL, thinking_tokens=0)) as send:
            hf.ADAPTER.generate(request)
        return send.call_args.kwargs['payload']
    def test_exact_refresh_sequence_keeps_off_wire(self):
        self.refresh(); self.selected()
        before = self.payload()
        self.clock_mock.return_value = 1220.
        self.refresh()
        after = self.payload()
        self.assertEqual(before.get('reasoning_effort'), 'none')
        self.assertEqual(after.get('reasoning_effort'), 'none')
        self.assertEqual(before, after)
    def test_refresh_result_keeps_selected_control_for_ui(self):
        self.refresh(); self.selected()
        result = self.refresh()
        self.assertEqual(result['capabilities'][MODEL]['reasoning']['supported_efforts'], ['none','low'])
    def test_catalogue_ttl_does_not_expire_still_valid_probe(self):
        self.refresh(); self.selected(); self.clock_mock.return_value = 1301.
        fresh, caps = self.evidence()
        self.assertTrue(fresh)
        self.assertEqual(caps['reasoning']['supported_efforts'], ['none','low'])
    def test_refresh_does_not_renew_probe_forever(self):
        self.refresh(); self.selected(); self.clock_mock.return_value = 1800.
        self.refresh(); self.clock_mock.return_value = 1901.
        _, caps = self.evidence()
        self.assertNotIn('none', caps.get('reasoning',{}).get('supported_efforts',[]))
    def test_explicit_new_negative_is_authoritative(self):
        self.refresh(); self.selected()
        self.refresh(caps={MODEL: {'reasoning': {'supported': False}}})
        _, caps = self.evidence()
        self.assertIs(caps['reasoning']['supported'], False)
        self.assertNotIn('none', caps['reasoning'].get('supported_efforts',[]))
        self.refresh()
        self.assertNotIn('none', self.evidence()[1].get('reasoning',{}).get('supported_efforts',[]))
    def test_removed_model_does_not_regain_selected_evidence(self):
        self.refresh(); self.selected(); self.refresh(models=['different-model'])
        self.assertNotIn('none', self.evidence()[1].get('reasoning',{}).get('supported_efforts',[]))
        self.refresh()
        self.assertNotIn('none', self.evidence()[1].get('reasoning',{}).get('supported_efforts',[]))
    def test_scopes_are_isolated(self):
        self.refresh(); self.selected()
        for kwargs in [{'key':'hf_other'}, {'base':BASE+'/other'}, {'provider':'openai'}, {'model':'different-model'}]:
            with self.subTest(**kwargs):
                self.assertNotIn('none', self.evidence(**kwargs)[1].get('reasoning',{}).get('supported_efforts',[]))
    def test_unknown_catalogue_does_not_invent_support(self):
        self.refresh()
        self.assertNotIn('none', self.evidence()[1].get('reasoning',{}).get('supported_efforts',[]))
    def test_forget_drops_selected_evidence(self):
        self.refresh(); self.selected(); cache.forget_model_capabilities('huggingface',BASE,KEY)
        self.assertEqual(self.evidence(), (False,{}))
    def test_new_vision_metadata_coexists_with_reasoning_probe(self):
        self.refresh(); self.selected(); self.refresh(caps={MODEL:{'vision':{'supported':True}}})
        caps = self.evidence()[1]
        self.assertTrue(caps['vision']['supported'])
        self.assertIn('none',caps['reasoning']['supported_efforts'])

    def test_cached_probe_returns_current_merged_evidence(self):
        payload = {'provider': 'huggingface', 'model': MODEL, 'api_key': KEY}
        self.refresh()
        with patch.object(hf.ADAPTER, 'probe', return_value=ProbeResponse(True, 200, capabilities=CAP)) as call:
            first = probing.probe(payload)
            self.assertTrue(first['ok'])
            self.refresh()
            second = probing.probe(payload)
            self.assertTrue(second['cached'])
            self.assertEqual(second['model_capabilities'], first['model_capabilities'])
            self.refresh(caps={MODEL: {'reasoning': {'supported': False}}})
            third = probing.probe(payload)
            self.assertIs(third['model_capabilities']['reasoning']['supported'], False)
            self.assertNotIn('none', third['model_capabilities']['reasoning'].get('supported_efforts', []))
            self.assertEqual(call.call_count, 1)
    def test_forgotten_account_does_not_reuse_stale_success(self):
        payload = {'provider': 'huggingface', 'model': MODEL, 'api_key': KEY}
        self.refresh()
        with patch.object(hf.ADAPTER, 'probe', side_effect=[ProbeResponse(True, 200, capabilities=CAP), ProbeResponse(False, 403)]) as call:
            self.assertTrue(probing.probe(payload)['ok'])
            cache.forget_model_capabilities('huggingface', BASE, KEY)
            result = probing.probe(payload)
            self.assertFalse(result['ok'])
            self.assertFalse(result['cached'])
            self.assertEqual(call.call_count, 2)

if __name__ == '__main__': unittest.main()
