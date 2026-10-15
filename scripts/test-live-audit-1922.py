"""Offline regression: Conversation owner, adapter and HTTP reader (the /ai/probe service was removed in 10491)."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from dataclasses import replace
from contextlib import ExitStack
from unittest.mock import patch
import httpx
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai import markers
from backend.ai.provider_registry import provider_registry
from backend.ai.provider_contract import GenerationRequest, ModelListResult
from backend.ai.cloud_reasoning import CloudReasoningPreferenceUnavailable
from backend.ai.providers import compose_providers
from backend.ai.providers import cloud_openrouter
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.invocation import translate
from backend.ai.translation_paths.mode import descriptor
compose_providers()

class RouterSessionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        env=patch.dict(os.environ,{'TP_CONVERSATION_STATE_FILE':self.tmp.name+'/history',
             'TP_AI_WIRE_TRACE':'0','TP_USAGE_RECEIPTS':'off','TP_PROMPT_CACHE':'auto'})
        env.start();self.addCleanup(env.stop)
        def discovered(provider,base_url,model,api_key):
            # Only the fixture's exact server-side account/model metadata proves
            # Off. Retain the real preflight guard against browser-only hints.
            if (provider=='openrouter' and base_url=='https://openrouter.ai/api/v1'
                    and (model,api_key) in {('fixture-model','fake-private-key'),
                        ('fixture-model','different-private-fixture-key'),
                        ('fixture-model-b','fake-private-key')}):
                return True,{'reasoning':{'supported':False},'structured_output':{'supported':False},
                             'limits':{'contextTokens':65536}}
            return False,{}
        discovery=patch('backend.ai.provider_resolution.discovered_model_capabilities',side_effect=discovered)
        discovery.start();self.addCleanup(discovery.stop)
        self.payloads=[];self.headers=[]
        real_client=httpx.Client
        def fake_client(*args,**kw):
            kw['transport']=httpx.MockTransport(self.respond)
            return real_client(*args,**kw)
        mock=patch.object(httpx,'Client',side_effect=fake_client);mock.start();self.addCleanup(mock.stop)
        self.ai=AiConfig(provider='openrouter',model='fixture-model',api_key='fake-private-key',
            base_url='https://openrouter.ai/api/v1',thinking='off',translation_mode='conversation',
            memory_mode='off',source_lang='en',conversation=descriptor({'documentId':'doc-a'},context={'tp_tab_session':'owner-a'}),
            model_capabilities={'structured_output':{'supported':False},'limits':{'contextTokens':65536}})
    def respond(self,request):
        self.assertEqual(request.method,'POST','no extra discovery, warmup or probe')
        p=json.loads(request.content);self.payloads.append(p);self.headers.append(dict(request.headers))
        frames=[{'id':'fixture-response','model':p['model'],'choices':[{'delta':{'content':'<<TP_P0:คำแปลไทย>>'},'finish_reason':None}]},
                {'choices':[{'delta':{},'finish_reason':'stop'}],
                 'usage':{'prompt_tokens':100,'completion_tokens':10,'total_tokens':110,'prompt_tokens_details':{'cached_tokens':40}}}]
        data=''.join('data: '+json.dumps(f)+'\n\n' for f in frames)+'data: [DONE]\n\n'
        return httpx.Response(200,headers={'content-type':'text/event-stream'},text=data,request=request)
    def call(self,source='Hello',ai=None):
        return translate(markers.apply([source]),'th',ai or self.ai)
    def test_client_off_hint_without_server_evidence_never_dispatches(self):
        hinted=replace(self.ai,model_capabilities={'reasoning':{'supported':False},
            'structured_output':{'supported':False},'limits':{'contextTokens':65536}})
        adapter=provider_registry.require('openrouter').adapter
        with patch('backend.ai.provider_resolution.discovered_model_capabilities',return_value=(False,{})), \
                patch.object(adapter,'list_models',return_value=ModelListResult(status='invalid_key',http_status=401)) as discovery:
            with self.assertRaises(CloudReasoningPreferenceUnavailable) as rejected:
                self.call(ai=hinted)
        self.assertEqual(rejected.exception.code,'ai_thinking_off_unavailable')
        self.assertFalse(rejected.exception.requestDispatched)
        self.assertEqual(rejected.exception.providerAttempts,0)
        self.assertEqual(discovery.call_count,1);self.assertEqual(self.payloads,[])
        self.assertEqual(self.headers,[])
    def test_first_continuation_and_repair_keep_session_and_exact_prefix(self):
        previous=None;ids=[]
        for i in range(3):
            ai=copy.deepcopy(self.ai)
            if i==2:ai.conversation['branch']='repair'
            result=self.call(f'current {i}',ai)
            self.assertEqual(result['meta']['usage']['inputTokens'],100)
            self.assertEqual(result['meta']['usage']['cachedInputTokens'],40)
            p=self.payloads[-1];ids.append(p['session_id'])
            if previous:self.assertEqual(p['messages'][:len(previous['messages'])],previous['messages'])
            previous=p
        self.assertEqual(len(set(ids)),1);self.assertRegex(ids[0],r'^tp-c-[a-f0-9]{48}$')
        self.assertEqual(len(self.payloads),3)
        self.assertNotIn('fake-private-key',ids[0]);self.assertNotIn('doc-a',ids[0])
        print('Captured 3 real native payloads: first/continuation/repair; unchanged prefix, 1 session')
    def test_owner_document_key_model_and_language_are_isolated(self):
        configs=[copy.deepcopy(self.ai) for _ in range(5)]
        configs[1].api_key='different-private-fixture-key'
        configs[2].conversation['documentId']='doc-b'
        configs[3].conversation['owner']='owner-b'
        configs[4].model='fixture-model-b'
        for ai in configs:self.call(ai=ai)
        translate(markers.apply(['Hello']),'ja',self.ai)
        self.assertEqual(len(set(p['session_id'] for p in self.payloads)),6)
    def test_independent_and_cache_off_do_not_send_session(self):
        self.call(ai=replace(self.ai,translation_mode='independent'))
        self.assertNotIn('session_id',self.payloads[-1])
        with patch.dict(os.environ,{'TP_PROMPT_CACHE':'off'}):self.call()
        self.assertNotIn('session_id',self.payloads[-1])
    def test_unscoped_or_custom_endpoint_not_tagged(self):
        # Leaf calls with no live document owner must not share a global prefix ID.
        adapter=cloud_openrouter.OpenRouterAdapter()
        req=GenerationRequest(provider='openrouter',model='fixture-model',api_key='fake-key',
            system_text='Stable',user_parts=('<<TP_P0:source>>',),thinking='off',expected_ids=('P0',),
            cache_context={'translationMode':'conversation'})
        adapter.generate(req);self.assertNotIn('session_id',self.payloads[-1])
        req=replace(req,base_url='https://approved-fixture.invalid/v1',
            cache_context={'translationMode':'conversation','conversationScope':'private-scope'})
        adapter.generate(req);self.assertNotIn('session_id',self.payloads[-1])
    def test_cache_hint_changes_no_prompt_text_or_order(self):
        adapter=cloud_openrouter.OpenRouterAdapter()
        req=GenerationRequest(provider='openrouter',model='fixture-model',api_key='fake-key',
            system_text='STABLE SYSTEM',user_parts=('<<TP_P0:current source>>',),thinking='off',expected_ids=('P0',),
            history_messages=({'role':'user','text':'previous source'},{'role':'assistant','text':'previous translation'}),
            cache_context={'translationMode':'conversation','conversationScope':'private-owner'})
        adapter.generate(req);with_session=self.payloads[-1]
        adapter.generate(replace(req,cache_context={}));without_session=self.payloads[-1]
        expected=copy.deepcopy(with_session);expected.pop('session_id')
        self.assertEqual(expected,without_session)
        self.assertEqual(with_session['messages'][1:3],[{'role':'user','content':'previous source'},{'role':'assistant','content':'previous translation'}])

if __name__=='__main__':unittest.main(verbosity=2)
