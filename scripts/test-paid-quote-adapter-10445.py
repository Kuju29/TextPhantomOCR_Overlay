"""Production Paid adapter: server-owned route admission replaces the quote hop (.60)."""
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import httpx
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.ai.providers.cloud_paid import ADAPTER
from backend.ai.provider_contract import GenerationRequest
from backend.ai.clients.provider_error import ProviderFailure
from backend.ai.wire_trace import redact
from backend.ai.failure_reason import provider_http_failure
from backend.ai.translation.contracts import AiConfig
from backend.jobs.stages.config import build_ai_config
from backend.application.ai_translation.request_validation import build_config
from backend.ai import accounting, markers
from backend.ai.request_diagnostics import request_diagnostics
from backend.ai.translation.result_decode import decode_result
from backend.jobs.stages.ai_repair import translate_with_one_repair
from backend.ai.errors import ModelOutputContractError
from backend.application.ai_translation.provider_errors import raise_execution_error
from fastapi import HTTPException


class PaidQuotes(unittest.TestCase):
    def run_adapter(self, status=200, malformed=False, count=1, anchor=True, replay=False, receipt=False, answer='คำแปล', charge=3, raw_text=None):
        calls=[]; client_type=httpx.Client
        self.last_calls=calls
        def transport(req):
            body=json.loads(req.content);calls.append((req.url.path,body))
            content=f'<<I1_P0:{answer}>>' if raw_text is None else raw_text
            if req.url.path.endswith('/chat/receipt'):
                if malformed: return httpx.Response(200,json={'found':'invalid'})
                return httpx.Response(200,json={'found':True,'result':{'model':'qa/test',
                    'choices':[{'message':{'content':content},'finish_reason':'stop'}],
                    'charged_tp':charge,'balance_tp':997,'usage':{'cost':'0.0001','prompt_tokens':10,'completion_tokens':5}}} if replay else {'found':False})
            if req.url.path.endswith('/price-quote'):
                raise AssertionError('Unexpected separate price quote')
            if status != 200:
                return httpx.Response(status,json={'error':{'code':'PAID_PRICE_REFRESHING','message':'Checking current route prices'}})
            return httpx.Response(200,json={'model':'qa/test','choices':[{'message':{'content':content},'finish_reason':'stop'}],
                'charged_tp':charge,'balance_tp':997,'usage':{'cost':'0.0001','prompt_tokens':10,'completion_tokens':5}})
        with patch('backend.ai.providers.cloud_paid.center_base_url',return_value='https://fixture.invalid'), \
             patch('backend.ai.providers.cloud_paid.center_origin',return_value='https://fixture.invalid'), \
             patch('backend.ai.providers.cloud_paid.httpx.Client',side_effect=lambda **kw:client_type(**kw,transport=httpx.MockTransport(transport))):
            for index in range(count):
                request=GenerationRequest(provider='paid',model='qa/test',api_key='synthetic-owner',system_text='Translate',
                    user_parts=('Owned source',),thinking='minimum',model_capabilities={'limits':{'maxOutputTokens':2048}},
                    cache_context={'operationId':'main' if index==0 else 'repair','userRunId':'same-owned-click',
                        **({'paidPriceQuoteToken':'original-click-approval'} if anchor else {})})
                result=accounting.generate_with_receipt(ADAPTER,request) if receipt else ADAPTER.generate(request)
        return calls,result

    def test_main_and_repair_each_use_own_atomic_admission(self):
        calls,result=self.run_adapter(count=2)
        self.assertEqual([path.rsplit('/',1)[-1] for path,_ in calls],['receipt','completions']*2)
        for index in [1,3]:
            self.assertNotIn('price_quote_token', calls[index][1])
        self.assertNotEqual(calls[1][1]['operation_id'],calls[3][1]['operation_id'])
        self.assertEqual(calls[1][1]['user_run_id'],calls[3][1]['user_run_id'])
        self.assertTrue(result.terminal_completed)

    def test_admission_failure_and_malformed_receipt_are_zero_generation(self):
        for status,malformed in [(503,False),(200,True)]:
            with self.subTest(status=status):
                with self.assertRaises(ProviderFailure) as failure:self.run_adapter(status,malformed)
                self.assertTrue(failure.exception.centerAdmissionRejected)
                self.assertFalse(failure.exception.requestDispatched)
                self.assertEqual(failure.exception.generationAttempts,0)
                self.assertEqual([path.rsplit('/',1)[-1] for path,_ in self.last_calls],['receipt'] if malformed else ['receipt','completions'])

    def test_opaque_quote_is_redacted_in_normal_wire_log(self):
        self.assertEqual(redact({'price_quote_token':'owned-private-quote'})['price_quote_token'],'<redacted>')

    def test_current_quote_needs_no_click_anchor_and_owned_settled_receipt_remains_available(self):
        calls,result=self.run_adapter(anchor=False)
        self.assertEqual([path.rsplit('/',1)[-1] for path,_ in calls],['receipt','completions'])
        self.assertNotIn('price_quote_token',calls[1][1])
        self.assertTrue(result.terminal_completed)
        calls,result=self.run_adapter(anchor=False,replay=True)
        self.assertEqual([path.rsplit('/',1)[-1] for path,_ in calls],['receipt'])
        self.assertTrue(result.terminal_completed)

    def test_public_price_admission_preserves_typed_actionable_status(self):
        with self.assertRaises(ProviderFailure) as failure:self.run_adapter(status=503)
        public=provider_http_failure(failure.exception)
        self.assertEqual((public.status,public.code,public.retryable),(503,'paid_price_refreshing',False))

    def test_owned_settled_receipt_retains_answer_and_charge_without_new_generation_receipt(self):
        with accounting.receipt_scope('runsextension','fresh-owned-operation'):
            _,fresh=self.run_adapter(receipt=True)
            self.assertEqual(len(accounting._receipts.get()),1)
            self.assertEqual(fresh.usage_details['chargedTp'],3)
        with accounting.receipt_scope('runsextension','replayed-owned-operation'):
            calls,replayed=self.run_adapter(anchor=False,replay=True,receipt=True)
            self.assertEqual([path.rsplit('/',1)[-1] for path,_ in calls],['receipt'])
            self.assertEqual(accounting._receipts.get(),[])
            self.assertEqual(replayed.text,fresh.text)
            self.assertEqual(replayed.usage_details['chargedTp'],fresh.usage_details['chargedTp'])
            self.assertEqual(replayed.usage_details['providerCostUsd'],fresh.usage_details['providerCostUsd'])
            self.assertTrue(replayed.usage_details['centerOperationReplayed'])
            self.assertNotIn('receiptId',replayed.usage_details)

    def decoded_owned_replay(self, replay=True, **options):
        _,result=self.run_adapter(anchor=not replay,replay=replay,**options)
        return decode_result(result=result,ids=['I1_P0'],provider='paid',base_url='',used_model='qa/test',
            target_lang='th',ai=AiConfig(api_key='synthetic-owner',provider='paid',model='qa/test'),context_frozen=False,
            selected_wire_contract='tp.translation.compact-records/1',want_memo=False,image_b64='',
            thinking_selected='minimum',thinking_applied='unverified',system_text='Translate',
            user_parts=['Owned source'],capture_request=False,is_retry=False)

    def test_replay_diagnostics_count_only_new_request_not_retained_token_evidence(self):
        decoded=self.decoded_owned_replay()
        diagnostic=request_diagnostics(decoded['meta'])
        self.assertEqual(diagnostic['inputActual'],0)
        self.assertEqual(diagnostic['outputActual'],0)
        self.assertEqual(decoded['meta']['usage']['inputTokens'],10)
        self.assertTrue(diagnostic['centerOperationReplayed'])
        # An untrusted flag on another provider cannot erase real observations.
        other=request_diagnostics({**decoded['meta'],'provider':'openrouter'})
        self.assertEqual(other['inputActual'],10)

    def test_legacy_valid_answer_consumer_does_not_clamp_owned_replay_to_one_attempt(self):
        decoded=self.decoded_owned_replay()
        result=translate_with_one_repair('<<TP_P0:Owned source>>','th',AiConfig(api_key='synthetic-owner',provider='paid',model='qa/test'),1,
            translate_fn=lambda *args,**kwargs:decoded)
        self.assertEqual(result['meta']['generation_attempts'],0)
        self.assertEqual(result['meta']['provider_attempts'],0)
        self.assertEqual(result['meta']['usage']['chargedTp'],3)
        self.assertFalse(result['meta']['repair_attempted'])
        from backend.jobs.queue import _result_generation_attempts
        self.assertEqual(_result_generation_attempts({'Ai':result}),0)

    def test_enabled_server_repair_counts_only_fresh_dispatches_for_all_replay_combinations(self):
        from backend.jobs.queue import _result_generation_attempts
        for main_replayed,repair_replayed in [(True,True),(True,False),(False,True),(False,False)]:
            with self.subTest(main_replayed=main_replayed,repair_replayed=repair_replayed):
                phase=[];native_posts=[]
                def translate(*args,**kwargs):
                    index=len(phase)
                    decoded=self.decoded_owned_replay(replay=[main_replayed,repair_replayed][index],receipt=True,
                        answer='This is an incorrect English answer' if index==0 else 'คำแปลที่ถูกต้อง',charge=3+index)
                    native_posts.extend(path for path,_ in self.last_calls if path.endswith('/completions'))
                    phase.append(decoded)
                    return decoded
                with accounting.receipt_scope('runsapi','owned-server-repair'):
                    result=translate_with_one_repair(markers.apply(['Owned source']),'th',
                        AiConfig(api_key='synthetic-owner',provider='paid',model='qa/test',repair_enabled=True),1,
                        translate_fn=translate)
                    new_calls=2-int(main_replayed)-int(repair_replayed)
                    self.assertEqual(len(native_posts),new_calls)
                    self.assertEqual(len(accounting._receipts.get()),new_calls)
                meta=result['meta'];usage=meta['usage']
                self.assertEqual(meta['generationAttempts'],new_calls)
                self.assertEqual(meta['generation_attempts'],new_calls)
                self.assertEqual(meta['providerAttempts'],new_calls)
                self.assertEqual(meta['provider_attempts'],new_calls)
                self.assertEqual(_result_generation_attempts({'Ai':result}),new_calls)
                self.assertEqual(usage['generationCount'],new_calls)
                self.assertEqual(usage['inputTokens'],10*new_calls)
                self.assertEqual(usage['outputTokens'],5*new_calls)
                self.assertEqual(len(usage['generations']),new_calls)
                self.assertEqual(len(usage.get('retainedGenerations',[])),2-new_calls)
                self.assertEqual(sorted(row['chargedTp'] for row in [*usage['generations'],*usage.get('retainedGenerations',[])]),[3,4])
                self.assertEqual(meta.get('centerOperationReplayed',False),new_calls==0)
                self.assertEqual(meta.get('requestDispatched',True),new_calls>0)
                self.assertEqual(usage.get('centerOperationReplayed',False),new_calls==0)
                self.assertEqual(result['aiTextFull'],markers.apply(['คำแปลที่ถูกต้อง']))

    def test_invalid_retained_repair_keeps_zero_new_attempts_in_failure_metadata(self):
        from backend.jobs.queue import _exception_generation_attempts
        phases=[]
        def translate(*args,**kwargs):
            decoded=self.decoded_owned_replay(replay=True,receipt=True,
                answer='This is still an incorrect English answer',charge=3+len(phases))
            phases.append(decoded)
            return decoded
        with accounting.receipt_scope('runsapi','owned-invalid-retained-repair'):
            with self.assertRaises(ModelOutputContractError) as failure:
                translate_with_one_repair(markers.apply(['Owned source']),'th',
                    AiConfig(api_key='synthetic-owner',provider='paid',model='qa/test',repair_enabled=True),1,
                    translate_fn=translate)
            self.assertEqual(accounting._receipts.get(),[])
        error=failure.exception
        self.assertEqual(error.generationAttempts,0)
        self.assertEqual(error.providerAttempts,0)
        self.assertEqual(_exception_generation_attempts(error),0)
        self.assertEqual(error.generationMeta['usage']['generationCount'],0)
        self.assertEqual(error.generationMeta['usage']['inputTokens'],0)
        self.assertEqual([row['chargedTp'] for row in error.generationMeta['usage']['retainedGenerations']],[3,4])

    def disabled_repair_failure(self, replay=True, answer='This is still an incorrect English answer',
                                mutate_meta=None, raw_text=None):
        native_posts=[]
        def translate(*args,**kwargs):
            try:
                decoded=self.decoded_owned_replay(replay=replay,receipt=True,answer=answer,raw_text=raw_text)
                if mutate_meta: mutate_meta(decoded['meta'])
                return decoded
            finally:
                native_posts.extend(path for path,_ in self.last_calls if path.endswith('/completions'))
        with accounting.receipt_scope('runsapi','synthetic-disabled-repair'):
            with self.assertRaises(ModelOutputContractError) as failure:
                translate_with_one_repair(markers.apply(['Synthetic source']),'th',
                    AiConfig(api_key='synthetic-owner',provider='paid',model='qa/test',repair_enabled=False),1,
                    translate_fn=translate)
            receipt_count=len(accounting._receipts.get())
        return failure.exception,len(native_posts),receipt_count

    def test_disabled_server_repair_owned_replay_rejection_is_zero_new_execution(self):
        from backend.jobs.queue import _exception_generation_attempts,_queue_error
        for raw_text in (None,''):
            with self.subTest(shape='wrong_language' if raw_text is None else 'malformed'):
                error,posts,receipts=self.disabled_repair_failure(raw_text=raw_text)
                self.assertEqual((posts,receipts),(0,0))
                self.assertEqual(error.generationAttempts,0)
                self.assertEqual(error.providerAttempts,0)
                self.assertFalse(error.requestDispatched)
                self.assertEqual(_exception_generation_attempts(error),0)
                meta=error.generationMeta
                self.assertTrue(meta['centerOperationReplayed'])
                self.assertEqual(meta['usage']['generations'],[])
                self.assertEqual(meta['usage']['retainedGenerations'][0]['chargedTp'],3)
                queued=_queue_error(error,{'ai':{'provider':'paid','model':'qa/test'}})
                self.assertEqual((queued['generationAttempts'],queued['providerAttempts']),(0,0))
                self.assertFalse(queued['requestDispatched'])
                self.assertTrue(queued['centerOperationReplayed'])
                self.assertEqual(queued['structuralDetails']['generationMeta']['usage']['retainedGenerations'][0]['chargedTp'],3)

    def test_disabled_server_repair_partial_owned_replay_keeps_zero_new_attempts(self):
        from backend.jobs.queue import _result_generation_attempts
        for replay in (True,False):
            decoded=self.decoded_owned_replay(replay=replay,answer='')
            result=translate_with_one_repair(markers.apply(['Synthetic source']),'th',
                AiConfig(api_key='synthetic-owner',provider='paid',model='qa/test',repair_enabled=False),1,
                translate_fn=lambda *args,**kwargs:decoded)
            self.assertEqual(result['meta']['generation_attempts'],0 if replay else 1)
            self.assertEqual(_result_generation_attempts({'Ai':result}),0 if replay else 1)
            self.assertEqual(result['meta']['usage']['chargedTp'],3)

    def test_disabled_server_repair_fresh_and_untrusted_metadata_keep_real_attempt(self):
        from backend.jobs.queue import _exception_generation_attempts,_queue_error
        for replay,mutate in [(False,None),(True,lambda m:m.update(provider='openrouter')),
                (True,lambda m:m.update(requestDispatched=True)),
                (True,lambda m:m['usage'].update(centerOperationReplayed=False))]:
            with self.subTest(replay=replay,guard=None if mutate is None else 'inconsistent'):
                error,posts,receipts=self.disabled_repair_failure(replay=replay,mutate_meta=mutate)
                self.assertEqual((posts,receipts),(0,0) if replay else (1,1))
                self.assertEqual(error.generationAttempts,1)
                self.assertEqual(error.providerAttempts,1)
                self.assertEqual(_exception_generation_attempts(error),1)
                queued=_queue_error(error,{'ai':{'provider':'paid','model':'qa/test'}})
                self.assertEqual(queued['generationAttempts'],1)
                self.assertTrue(queued['requestDispatched'])
                self.assertNotIn('centerOperationReplayed',queued)

    def test_public_contract_failure_does_not_clamp_owned_replay_zero_to_one(self):
        config=AiConfig(api_key='synthetic-owner',provider='paid',model='qa/test',repair_enabled=False)
        ctx=SimpleNamespace(unit_count=1,char_count=16,config=config,trace_id='',correlation={},
            route_identity={},requested_route='runsextension',resolved_provider='paid',resolved_model='qa/test')
        for replay in (True,False):
            for raw_text in (None,''):
                with self.subTest(replay=replay,malformed=raw_text is not None):
                    error,posts,receipts=self.disabled_repair_failure(replay=replay,raw_text=raw_text)
                    with self.assertRaises(HTTPException) as failure:
                        raise_execution_error(ctx,error,rate_wait_ms=0,admission_wait_ms=0,provider_ms=0)
                    detail=failure.exception.detail
                    self.assertEqual(detail['generationAttempts'],0 if replay else 1)
                    self.assertEqual(detail['providerAttempts'],0 if replay else 1)
                    self.assertEqual(detail['requestDispatched'],not replay)
                    self.assertFalse(detail['automaticTransportRetry'])
                    self.assertFalse(detail['automaticContentRetry'])

    def test_quote_is_private_in_config_repr_and_bounded_in_both_ingress_paths(self):
        self.assertNotIn('opaque-click-approval',repr(AiConfig(api_key='synthetic',paid_price_quote_token='opaque-click-approval')))
        for bad in [{'secret':'not-a-quote'},'x'*8193]:
            with self.subTest(kind=type(bad).__name__):
                with self.assertRaises(ValueError):build_ai_config({'ai':{'provider':'paid','api_key':'synthetic','price_quote_token':bad}},'lens_text','ai')
                with self.assertRaises(ValueError):build_config({'provider':{'id':'paid','apiKey':'synthetic','priceQuoteToken':bad}})


if __name__=='__main__':unittest.main()
