#!/usr/bin/env python3
from __future__ import annotations
import os,sys,unittest
from dataclasses import replace
from unittest.mock import patch
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0,os.path.join(ROOT,'api'))
from backend.ai.clients.base import ChatResult
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import cloud_huggingface as hf


def req(*,model='deepseek-ai/DeepSeek-V4-Flash-0731',context=None,capabilities=None):
    return GenerationRequest(provider='huggingface',model=model,api_key='hf_fixture',base_url=hf.DEFAULT_BASE_URL,
        system_text='STYLE',user_parts=('<<TP_P0:Hello>>',),thinking='off',expected_ids=('P0',),unit_count=1,
        cache_context=context or {},model_capabilities=capabilities or {})

class _CatalogueResponse:
    is_success=True
    status_code=200
    def json(self):
        return {"data":[{"id":"deepseek-ai/DeepSeek-V4-Flash-0731","architecture":{"input_modalities":["text"],"output_modalities":["text"]},
            "providers":[{"provider":"novita","status":"live","first_token_latency_ms":410.0,"throughput":60.0},
                         {"provider":"scaleway","status":"live","first_token_latency_ms":620.0,"throughput":180.0}]}]}

class _CatalogueClient:
    def __init__(self,*_,**__):pass
    def __enter__(self):return self
    def __exit__(self,*_):return False
    def get(self,*_,**__):return _CatalogueResponse()

class RoutingTests(unittest.TestCase):
    def test_live_catalogue_hint_does_not_become_runtime_affinity(self):
        with patch.object(hf.httpx,'Client',_CatalogueClient):
            listed=hf.ADAPTER.list_models(api_key='hf_fixture',base_url=hf.DEFAULT_BASE_URL)
        candidate=listed.candidates['deepseek-ai/DeepSeek-V4-Flash-0731']
        self.assertEqual(candidate['fastestProviderHint'],'scaleway')
        self.assertEqual(candidate['routingPolicy'],'hf_auto_fastest_failover')
        self.assertNotIn('deepseek-ai/DeepSeek-V4-Flash-0731', listed.capabilities)
        request=req(context={'translationMode':'conversation','hfInferenceProvider':'scaleway'},
                    capabilities={'routing':{'preferred_provider':'scaleway'}})
        self.assertEqual(hf._effective_conversation_model(request),
                         ('deepseek-ai/DeepSeek-V4-Flash-0731',''))

    def test_observed_provider_never_pins_but_explicit_user_suffix_wins(self):
        c={'translationMode':'conversation','hfInferenceProvider':'scaleway'}
        self.assertEqual(hf._effective_conversation_model(req(context=c)),
                         ('deepseek-ai/DeepSeek-V4-Flash-0731',''))
        self.assertEqual(hf._effective_conversation_model(req(model='deepseek-ai/DeepSeek-V4-Flash-0731:novita',context=c)),
                         ('deepseek-ai/DeepSeek-V4-Flash-0731:novita','novita'))

    def test_generate_keeps_auto_router_unqualified_and_records_actual_upstream(self):
        seen={}
        def fake(**kwargs):
            seen.update(kwargs)
            return ChatResult('<<TP_P0:สวัสดี>>','deepseek-v4-flash-0731',10,2,12,'stop',1,1,'provider',0,True,'done',
                              upstream_provider='scaleway',cached_input_tokens=8,
                              usage_details={'inputTokens':10,'outputTokens':2,'totalTokens':12,'cachedInputTokens':8})
        request=req(context={'translationMode':'conversation','hfInferenceProvider':'scaleway'})
        with patch.object(hf,'execute_huggingface_chat',side_effect=fake):
            result=hf.ADAPTER.generate(request)
        self.assertEqual(seen['model'],'deepseek-ai/DeepSeek-V4-Flash-0731')
        self.assertEqual(seen['payload']['model'],'deepseek-ai/DeepSeek-V4-Flash-0731')
        self.assertIsNone(seen['trace_fields']['hfInferenceProviderAffinity'])
        self.assertEqual(result.upstream_provider,'scaleway')

if __name__=='__main__':
    unittest.main(verbosity=2)
