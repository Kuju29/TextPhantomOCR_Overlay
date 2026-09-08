"""Offline provider usage/cache audit. All HTTP boundaries are mocked, no AI spend."""
from __future__ import annotations
import json, os, sqlite3, sys, tempfile, unittest
from contextlib import contextmanager, closing
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import httpx
from backend.ai import accounting
from backend.ai.usage import normalize_usage, aggregate_usage
from backend.ai.prompt_cache import apply_chat_cache, cache_policy
from backend.ai.provider_contract import GenerationRequest, SystemPromptSection
from backend.ai.providers import compose_providers
from backend.ai.provider_registry import ProviderRegistry
from backend.ai.transports import openai_chat
from backend.ai.translation.invocation import _translate_once
from backend.ai.translation.contracts import AiConfig

ANSWER = '<<TP_P0:สวัสดี>>'
RAW_USAGE = {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120,
             'prompt_tokens_details': {'cached_tokens': 70, 'cache_write_tokens': 5},
             'completion_tokens_details': {'reasoning_tokens': 3}, 'cost': 0.00001234567890123456789}

class FakeClient:
    calls = []
    def __init__(self, *args, **kw): pass
    def __enter__(self): return self
    def __exit__(self, *args): self.close()
    def close(self): pass
    def post(self, url, **kw):
        self.calls.append((str(url), kw))
        if 'anthropic.com' in str(url):
            data={'id':'native-claude', 'content':[{'type':'text','text':ANSWER}], 'stop_reason':'end_turn',
                  'usage':{'input_tokens':25, 'cache_read_input_tokens':70,'cache_creation_input_tokens':5,'output_tokens':20}}
        elif 'googleapis.com' in str(url):
            data={'responseId':'native-google','candidates':[{'finishReason':'STOP','content':{'parts':[
                {'text':'PRIVATE THOUGHT MUST NOT BECOME TRANSLATION','thought':True},{'text':ANSWER}]}}],
                  'usageMetadata':{'promptTokenCount':100,'cachedContentTokenCount':70,'candidatesTokenCount':17,'thoughtsTokenCount':3,'totalTokenCount':120}}
        elif str(url).endswith('/api/chat'):
            data={'model':'served-model','message':{'content':ANSWER},'done':True,'done_reason':'stop',
                  'prompt_eval_count':100,'prompt_eval_cached_count':70,'eval_count':20}
        else:
            data={'id':'chat-id','model':'served-model','choices':[{'finish_reason':'stop','message':{'content':ANSWER}}], 'usage':RAW_USAGE}
        return httpx.Response(200,json=data,request=httpx.Request('POST',str(url)))

class UsageTests(unittest.TestCase):
    def test_openai_subsets_are_not_added_twice(self):
        u=normalize_usage(RAW_USAGE,cost_authoritative=True)
        self.assertEqual((u['inputTokens'],u['outputTokens'],u['totalTokens']),(100,20,120))
        self.assertEqual((u['cachedInputTokens'],u['uncachedInputTokens'],u['ordinaryInputTokens']),(70,30,25))
        self.assertEqual((u['thinkingTokens'],u['visibleOutputTokens']),(3,17))
    def test_anthropic_native_input_includes_cache(self):
        u=normalize_usage({'input_tokens':25,'cache_read_input_tokens':70,'cache_creation_input_tokens':5,'output_tokens':20},'anthropic')
        self.assertEqual((u['inputTokens'],u['totalTokens']),(100,120))
        self.assertTrue(u['totalDerived']);self.assertEqual(u['ordinaryInputTokens'],25)
    def test_gemini_thoughts_and_cache(self):
        u=normalize_usage({'promptTokenCount':100,'cachedContentTokenCount':70,'candidatesTokenCount':17,'thoughtsTokenCount':3,'totalTokenCount':120},'gemini')
        self.assertEqual(u['outputTokens'],20);self.assertEqual(u['visibleOutputTokens'],17)
        self.assertEqual(u['usageStatus'],'reported')
    def test_deepseek_native_and_ollama(self):
        u=normalize_usage({'prompt_tokens':100,'prompt_cache_hit_tokens':70,'prompt_cache_miss_tokens':30,'completion_tokens':20,'total_tokens':120})
        self.assertEqual(u['cachedInputTokens'],70);self.assertEqual(u['uncachedInputTokens'],30)
        u=normalize_usage({'prompt_eval_count':100,'prompt_eval_cached_count':70,'eval_count':20},'ollama')
        self.assertEqual(u['totalTokens'],120);self.assertIsNone(u['providerCostUsd'])
    def test_unknown_is_not_zero_and_bad_counts_are_not_billed(self):
        for value in [None,{}, {'prompt_tokens':None,'completion_tokens':True,'total_tokens':-2},
                      {'prompt_tokens':100.0,'completion_tokens':'20','total_tokens':2**60}]:
            u=normalize_usage(value);self.assertIsNone(u['inputTokens']);self.assertNotEqual(u['usageStatus'],'reported')
        u=normalize_usage({'prompt_tokens':0,'completion_tokens':0,'total_tokens':0})
        self.assertEqual(u['usageStatus'],'reported');self.assertEqual(u['totalTokens'],0)
    def test_invalid_subsets_or_total_are_flagged(self):
        for usage in [dict(RAW_USAGE,total_tokens=121),dict(RAW_USAGE,prompt_tokens_details={'cached_tokens':101}),
                      dict(RAW_USAGE,completion_tokens_details={'reasoning_tokens':30}),
                      dict(RAW_USAGE,prompt_tokens_details={'cached_tokens':99,'cache_write_tokens':2})]:
            self.assertEqual(normalize_usage(usage)['usageStatus'],'inconsistent')
    def test_money_exact_and_authority_separate(self):
        raw={'prompt_tokens':1,'completion_tokens':1,'cost':Decimal('0.00001234567890123456789')}
        self.assertIsNone(normalize_usage(raw)['providerCostUsd'])
        u=normalize_usage(raw,cost_authoritative=True)
        self.assertEqual(u['providerCostUsd'],'0.00001234567890123456789')
        total=aggregate_usage([u,u,{}]);self.assertEqual(total['providerCostUsd'],'0.00002469135780246913578')
        self.assertEqual(total['missingUsageGenerations'],1);self.assertEqual(total['usageStatus'],'incomplete')
    def test_partial_protocol_not_reported_complete(self):
        self.assertEqual(normalize_usage(RAW_USAGE,complete=False)['usageStatus'],'incomplete')
    def test_openrouter_byok_upstream_is_separate_not_added(self):
        u=normalize_usage(dict(RAW_USAGE,is_byok=True,cost=Decimal('0.01'),cost_details={'upstream_inference_cost':'0.23'}),cost_authoritative=True)
        self.assertEqual(u['providerCostUsd'],'0.01');self.assertEqual(u['upstreamInferenceCostUsd'],'0.23')

class CacheTests(unittest.TestCase):
    def setUp(self):
        self.payload={'model':'any','messages':[{'role':'system','content':'Exact style'}, {'role':'user','content':'OCR A'}], 'response_format':{'type':'json_object'}}
    def apply(self, provider='openrouter',model='deepseek/example',url='https://openrouter.ai/api/v1/chat/completions',body=None,key='secret'):
        return apply_chat_cache(body or self.payload,provider=provider,model=model,url=url,headers={'Authorization':'Bearer '+key})
    def test_openrouter_sticky_key_static_without_history(self):
        a,p=self.apply();b,_=self.apply(body={**self.payload,'messages':[self.payload['messages'][0],{'role':'user','content':'OCR B'}]})
        self.assertEqual(a['session_id'],b['session_id']);self.assertLessEqual(len(a['session_id']),256)
        self.assertEqual(a['messages'],self.payload['messages']);self.assertNotIn('session_id',self.payload)
        self.assertFalse(p['discountGuaranteed']);self.assertIsNone(p['hit'])
        self.assertNotEqual(a['session_id'],self.apply(key='other')[0]['session_id'])
    def test_explicit_only_documented_model_family(self):
        for model in ('anthropic/claude-sonnet-4-6','qwen/qwen3-coder-plus'):
            body,p=self.apply(model=model);self.assertEqual(body['messages'][0]['content'][0]['text'],'Exact style')
            self.assertEqual(body['messages'][0]['content'][0]['cache_control'],{'type':'ephemeral'})
            self.assertEqual(body['messages'][1],self.payload['messages'][1]);self.assertEqual(body['response_format'],self.payload['response_format'])
        b,_=self.apply(model='qwen/qwen3.5-plus-02-15');self.assertIsInstance(b['messages'][0]['content'],str)
    def test_unknown_custom_endpoint_untouched(self):
        for url in ('https://openrouter.ai.attacker.test/v1','https://proxy.example/v1'):
            b,p=self.apply(url=url);self.assertEqual(b,self.payload);self.assertEqual(p['support'],'unknown')
    def test_openai_automatic_key_and_off_switch(self):
        b,_=self.apply(provider='openai',url='https://api.openai.com/v1/chat/completions');self.assertIn('prompt_cache_key',b);self.assertNotIn('session_id',b)
        with patch.dict(os.environ,{'TP_PROMPT_CACHE':'off'}):
            b,p=self.apply(model='anthropic/claude-sonnet-4-6');self.assertEqual(b,self.payload);self.assertEqual(p['strategy'],'disabled')
    def test_no_system_no_fake_cache_prefix(self):
        b,p=self.apply(body={'messages':[{'role':'user','content':'OCR'}]});self.assertNotIn('session_id',b)

class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'receipts.sqlite'
        self.env=patch.dict(os.environ,{'TP_USAGE_STATE_FILE':str(self.path),'TP_USAGE_REQUIRED':'1','TP_USAGE_RECEIPTS':'on'})
        self.env.start();FakeClient.calls=[]
    def tearDown(self):self.env.stop();self.tmp.cleanup()
    def rows(self):
        if not self.path.exists():return []
        with closing(sqlite3.connect(self.path)) as db:
            return [json.loads(r[0]) for r in db.execute('select usage_json from provider_usage')]
    def test_all_19_provider_boundaries_both_engine_scopes(self):
        specs=list(compose_providers(ProviderRegistry()));self.assertEqual(len(specs),19)
        for engine in ('runsextension','runsapi'):
            for spec in specs:
                with self.subTest(engine=engine,provider=spec.provider_id):
                    req=GenerationRequest(provider=spec.provider_id,model=spec.default_model,api_key='secret-key',base_url=spec.default_base_url,
                      system_text='Private style sentinel',system_sections=(SystemPromptSection('identity','Private style sentinel',True),),
                      user_parts=('<<TP_P0:Private OCR sentinel>>',),thinking='off',expected_ids=('P0',),unit_count=1)
                    with patch.object(httpx,'Client',FakeClient),accounting.receipt_scope(engine,'operation-'+engine+'-'+spec.provider_id):
                        result=accounting.generate_with_receipt(spec.adapter,req)
                    self.assertEqual((result.input_tokens,result.output_tokens,result.total_tokens),(100,20,120))
                    self.assertEqual(result.usage_details['cachedInputTokens'],70)
                    self.assertEqual(result.usage_details['engine'],engine)
                    self.assertTrue(result.usage_details['receiptDurable']);self.assertFalse(result.usage_details['billingEligible'])
                    self.assertEqual(result.text,ANSWER)
        rows=self.rows();self.assertEqual(len(rows),38);self.assertEqual(len(FakeClient.calls),38)
        self.assertEqual(len({v['receiptId'] for v in rows}),38)
        serial=json.dumps(rows);self.assertNotIn('secret-key',serial);self.assertNotIn('Private OCR',serial);self.assertNotIn('Private style',serial)
    def test_actual_invocation_records_before_invalid_translation(self):
        from backend.ai.provider_registry import provider_registry
        spec=provider_registry.require('openrouter')
        original=FakeClient.post
        def invalid(client,url,**kw):
            response=original(client,url,**kw);data=response.json();data['choices'][0]['message']['content']='not a valid marker response'
            return httpx.Response(200,json=data,request=httpx.Request('POST',url))
        ai=AiConfig(api_key='secret-key',provider='openrouter',model=spec.default_model,base_url=spec.default_base_url,prompt_editable='Translate accurately.',prompt_mode='replace',thinking='off')
        with patch.object(httpx,'Client',FakeClient),patch.object(FakeClient,'post',invalid),patch('backend.ai.provider_resolution.discovered_model_capabilities',return_value=(False,{})),accounting.receipt_scope('runsextension','bad-translation'):
            with patch('backend.ai.translation.invocation.decode_result',side_effect=ValueError('test post-provider decode failure')):
                with self.assertRaisesRegex(ValueError,'post-provider'):_translate_once('<<TP_P0>>\nSource','th',ai)
        rows=self.rows();self.assertEqual(len(rows),1);self.assertEqual(rows[0]['totalTokens'],120)
    def test_preflight_cancellation_has_no_receipt_and_required_storage_fails_closed(self):
        from backend.ai.provider_registry import provider_registry
        spec=provider_registry.require('openrouter')
        req=GenerationRequest(provider=spec.provider_id,model=spec.default_model,api_key='secret',base_url=spec.default_base_url,system_text='style',user_parts=('source',),cancel_check=lambda:True)
        with patch.object(httpx,'Client',FakeClient):
            with self.assertRaises(Exception):accounting.generate_with_receipt(spec.adapter,req)
        self.assertEqual(self.rows(),[]);self.assertEqual(len(FakeClient.calls),0)
        from dataclasses import replace
        with patch.dict(os.environ,{'TP_USAGE_RECEIPTS':'off'}),patch.object(httpx,'Client',FakeClient):
            with self.assertRaisesRegex(RuntimeError,'PERSISTENCE_REQUIRED'):accounting.generate_with_receipt(spec.adapter,replace(req,cancel_check=None))
        self.assertEqual(len(FakeClient.calls),0)
    def test_untrusted_observe_without_active_generation_creates_nothing(self):
        accounting.observe(RAW_USAGE,cost_authoritative=True);accounting.mark_dispatched();self.assertEqual(self.rows(),[])
    def test_runsapi_render_error_preserves_receipt_and_queue_envelope(self):
        from backend.ai.provider_registry import provider_registry
        from backend.jobs.queue import _queue_error
        spec=provider_registry.require('openrouter')
        req=GenerationRequest(provider='openrouter',model=spec.default_model,api_key='secret',base_url=spec.default_base_url,system_text='style',user_parts=('source',))
        @accounting.api_pipeline_scope
        def pipeline(payload):
            accounting.generate_with_receipt(spec.adapter,req)
            raise ValueError('render failed after paid response')
        with patch.object(httpx,'Client',FakeClient):
            try:pipeline({'idempotency_key':'render-error'})
            except ValueError as exc: error=exc
        self.assertEqual(error.generationMeta['usage']['totalTokens'],120)
        envelope=_queue_error(error,{'ai':{'provider':'openrouter','model':spec.default_model}})
        self.assertEqual(envelope['generationAttempts'],1)
        self.assertEqual(envelope['structuralDetails']['generationMeta']['usage']['totalTokens'],120)
        self.assertEqual(self.rows()[0]['engine'],'runsapi')
    def test_concurrent_receipts_have_independent_immutable_identity(self):
        from concurrent.futures import ThreadPoolExecutor
        from backend.ai.provider_registry import provider_registry
        spec=provider_registry.require('openrouter')
        req=GenerationRequest(provider='openrouter',model=spec.default_model,api_key='secret',base_url=spec.default_base_url,system_text='style',user_parts=('source',))
        def run(i):
            with accounting.receipt_scope('runsextension',str(i)):
                return accounting.generate_with_receipt(spec.adapter,req).usage_details
        with patch.object(httpx,'Client',FakeClient),ThreadPoolExecutor(max_workers=8) as pool:
            rows=list(pool.map(run,range(32)))
        self.assertEqual(len(self.rows()),32);self.assertEqual(len({r['receiptId'] for r in rows}),32)
        self.assertEqual(sum(r['totalTokens'] for r in self.rows()),3840)
    def test_readonly_operator_audit_flags_pending_without_zero(self):
        import runpy
        from backend.ai.provider_registry import provider_registry
        spec=provider_registry.require('openrouter')
        req=GenerationRequest(provider='openrouter',model=spec.default_model,api_key='secret',base_url=spec.default_base_url,system_text='style',user_parts=('source',))
        with patch.object(httpx,'Client',FakeClient),accounting.receipt_scope('runsapi','audit'):
            accounting.generate_with_receipt(spec.adapter,req)
        audit=runpy.run_path(str(Path(__file__).with_name('audit-provider-usage.py')))['audit']
        before=self.path.read_bytes();result=audit(self.path,'runsapi')
        self.assertEqual(result['receiptCount'],1);self.assertEqual(result['knownTokenSubtotals']['totalTokens'],120)
        self.assertFalse(result['customerDebitAuthorized']);self.assertEqual(before,self.path.read_bytes())
    def test_queue_attempts_use_all_observed_generations_even_after_cancel(self):
        from backend.jobs.queue import _exception_generation_attempts, _result_generation_attempts, _queue_error
        exc=RuntimeError('cancelled');exc.requestDispatched=True
        exc.generationMeta={'usage':{'generations':[{'receiptId':'one'}, {'receiptId':'two'}]}}
        self.assertEqual(_exception_generation_attempts(exc),2)
        self.assertEqual(_queue_error(exc,{'ai':{'provider':'openrouter','model':'m'}},cancelled=True)['generationAttempts'],2)
        self.assertEqual(_result_generation_attempts({'Ai':{'meta':{'provider':'openrouter','usage':None}}}),1)
        self.assertEqual(_result_generation_attempts({'perf':{'cache':'hit'},'Ai':{'meta':{'provider':'openrouter'}}}),0)
    def test_native_pipeline_decorator_scope(self):
        @accounting.api_pipeline_scope
        def run(payload):return dict(accounting._scope.get())
        self.assertEqual(run({'idempotency_key':'run-key'}),{'engine':'runsapi','operationId':'run-key'})

class SseTests(unittest.TestCase):
    setUp = ReceiptTests.setUp
    tearDown = ReceiptTests.tearDown
    rows = ReceiptTests.rows
    def stream(self, fail=False):
        exact='0.00001234567890123456789'
        class Client:
            _textphantom_streaming=True
            def __init__(self,*a,**kw):pass
            def __enter__(self):return self
            def __exit__(self,*a):pass
            @contextmanager
            def stream(self,*a,**kw):
                class Response:
                    is_success=True;status_code=200
                    def raise_for_status(self):pass
                    def close(self):pass
                    def iter_lines(self):
                        yield 'data: '+json.dumps({'id':'sse-id','choices':[{'delta':{'content':ANSWER},'finish_reason':'stop'}]})
                        yield 'data: '+json.dumps({'choices':[],'usage':dict(RAW_USAGE,cost=None)})
                        yield 'data: {"choices":[],"usage":{"cost":'+exact+',"prompt_tokens_details":{"cache_write_tokens":5}}}'
                        if fail:raise httpx.ReadError('connection lost')
                        yield 'data: [DONE]'
                yield Response()
        return Client
    def test_usage_after_content_and_decimal_snapshot_not_summed(self):
        from backend.ai.provider_registry import provider_registry
        spec=provider_registry.require('openrouter');req=GenerationRequest(provider='openrouter',model=spec.default_model,api_key='secret',base_url=spec.default_base_url,system_text='style',user_parts=('source',),expected_ids=('P0',),unit_count=1)
        with patch.object(httpx,'Client',self.stream()),accounting.receipt_scope('runsapi','stream-op'):
            result=accounting.generate_with_receipt(spec.adapter,req)
        u=result.usage_details;self.assertEqual(u['totalTokens'],120);self.assertEqual(u['cachedInputTokens'],70)
        self.assertEqual(u['providerCostUsd'],'0.00001234567890123456789');self.assertEqual(len(self.rows()),1)
    def test_interrupted_stream_preserves_observed_partial_usage(self):
        from backend.ai.provider_registry import provider_registry
        spec=provider_registry.require('openrouter');req=GenerationRequest(provider='openrouter',model=spec.default_model,api_key='secret',base_url=spec.default_base_url,system_text='style',user_parts=('source',))
        with patch.object(httpx,'Client',self.stream(True)),accounting.receipt_scope('runsextension','lost-op'):
            with self.assertRaises(Exception):accounting.generate_with_receipt(spec.adapter,req)
        u=self.rows()[0];self.assertEqual(u['totalTokens'],120);self.assertEqual(u['usageStatus'],'incomplete')
        self.assertEqual(u['operationId'],'lost-op');self.assertFalse(u['billingEligible'])

if __name__=='__main__':unittest.main(verbosity=2)
