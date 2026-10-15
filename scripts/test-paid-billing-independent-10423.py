"""Independent Paid refusals come from Center; no cached API wallet fence.
Other accounts keep their results and later owned requests can recover.
"""
import asyncio
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch
import httpx
import pytest

_candidate=Path(__file__).resolve().parents[1]
ROOT=Path(os.getenv('TP_TEST_ROOT',str(_candidate if (_candidate/'api/backend').is_dir() else Path(__file__).resolve().parents[2]/'source/TextPhantom')))
sys.path.insert(0,str(ROOT/'api'))
from backend.application.ai_translation import provider_execution
from backend.ai.translation.contracts import AiConfig
from backend.ai import accounting
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import cloud_paid
from backend.jobs.admission import AdmissionGate
from backend.api.errors import classify_failure
from fastapi import HTTPException

CASES=[('PAID_PROVIDER_KEY_LIMIT','paid_provider_key_limit',503),
       ('PAID_PROVIDER_CAPACITY','paid_provider_capacity',503),
       ('PAID_PROVIDER_BALANCE','paid_provider_balance',502),
       ('INSUFFICIENT_CREDITS','paid_insufficient_credits',402)]

@pytest.mark.parametrize('center_code,public_code,admission_status',CASES)
@pytest.mark.parametrize('unlimited',[False,True])
def test_independent_calls_use_center_admission_and_later_attempt_recovers(center_code,public_code,admission_status,unlimited):
    async def scenario():
        shared=NS(ai_admission_gate=AdmissionGate(2,max_waiters=64,max_wait_sec=3),ai_executor=ThreadPoolExecutor(4))
        started_a,started_b,release,release_other=threading.Event(),threading.Event(),threading.Event(),threading.Event()
        mutex=threading.Lock();provider_dispatches=[];center_posts=[];receipts={};tasks=[]
        real_provider_error=center_code!='INSUFFICIENT_CREDITS'
        def context(label):
            wallet='A' if label.startswith('A') else 'B'
            return NS(trace_id='trace-'+label,payload={'operationId':label},marked=label,target_lang='th',
                config=AiConfig(api_key='synthetic-wallet-'+wallet,provider='paid',model='qa/'+label,
                              translation_mode='independent',thinking='minimum'),
                request=NS(app=NS(state=shared)),identity=label,correlation={'requestId':'request-'+label,'imageId':'image-'+label,'batchId':'batch-'+wallet,'operationId':label},resolved_provider='paid',resolved_model='qa/'+label,
                rate={'enabled':False},unlimited=unlimited,unit_count=1,char_count=1,
                requested_route='/synthetic/ai/translate',route_identity={})
        class CenterClient:
            def __init__(self,**kwargs):pass
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def post(self,url,*,json,headers):
                if url.endswith('/chat/receipt'):return httpx.Response(200,json={'found':False})
                if url.endswith('/price-quote'):return httpx.Response(200,json={'quote_token':'synthetic-independent-click-quote'})
                label=json['messages'][-1]['content'];wallet='A' if headers['Authorization'].endswith('-A') else 'B'
                with mutex:center_posts.append((wallet,label))
                if wallet=='B':
                    started_b.set();assert release_other.wait(5),'Other running account release timed out'
                    with mutex:provider_dispatches.append((wallet,label))
                    return httpx.Response(200,json={'id':'gen-independent-B','model':'qa/B0',
                        'choices':[{'message':{'content':'Retained synthetic translation'},'finish_reason':'stop'}],
                        'usage':{'cost':'0.00001','prompt_tokens':20,'completion_tokens':5},'charged_tp':'9','balance_tp':'9991'})
                if label=='A-resumed':
                    with mutex:provider_dispatches.append((wallet,label))
                    return httpx.Response(200,json={'id':'gen-independent-A-resumed','model':'qa/A-resumed',
                        'choices':[{'message':{'content':'Intentional recovered request'},'finish_reason':'stop'}],
                        'usage':{'cost':'0.00001','prompt_tokens':20,'completion_tokens':5},'charged_tp':'9','balance_tp':'9991'})
                assert label.startswith('A'), 'Unexpected request owner'
                if label=='A0':
                    started_a.set();assert release.wait(5),'Quota fixture release timed out'
                    if real_provider_error:
                        with mutex:provider_dispatches.append((wallet,label))
                        return httpx.Response(502,json={'error':{'code':center_code,'details':{'upstream_http_status':402,
                          'provider_dispatched':True,'credit_state':'released','automatic_retry':False}}})
                return httpx.Response(admission_status,json={'error':{'code':center_code,'details':{
                    'provider_dispatched':False,'credit_reserved':False,'credit_state':'not_reserved','automatic_retry':False}}})
        def translate(text,lang,config,**kwargs):
            preflight=CenterClient().post('https://center.example/api/customer/price-quote',
                json={'model':config.model,'max_tokens':8192,'thinking':'minimum'},headers={}).json()['quote_token']
            request=GenerationRequest(provider='paid',model=config.model,api_key=config.api_key,system_text='Synthetic QA',
                user_parts=(text,),thinking='minimum',cache_context={'operationId':text,'thinkingRequested':'minimum',
                    'paidPriceQuoteToken':preflight},
                model_capabilities={'reasoning':{'supported':False},'limits':{'maxOutputTokens':8192}})
            try:
                result=accounting.generate_with_receipt(cloud_paid.ADAPTER,request)
                return {'meta':{'provider':'paid','model':config.model,'usage':result.usage_details}}
            finally:
                with mutex:receipts[text]=list(accounting._receipts.get())
        with patch.object(provider_execution,'translate',side_effect=translate), \
             patch.object(cloud_paid,'center_base_url',lambda:'https://center.example'), \
             patch.object(cloud_paid,'center_origin',lambda:'https://center.example'), \
             patch.object(cloud_paid.httpx,'Client',CenterClient), \
             patch.object(cloud_paid.wire_trace,'provider_request'), \
             patch.object(cloud_paid.wire_trace,'write_json'), \
             patch.object(cloud_paid.diagnostics,'emit'), \
             patch('backend.application.ai_translation.provider_errors.trace.write'), \
             patch('backend.application.ai_translation.provider_errors.failure_event'):
            try:
                first=asyncio.create_task(provider_execution.run(context('A0'),rate_wait_ms=0));tasks.append(first)
                assert await asyncio.to_thread(started_a.wait,1)
                for n in range(1,8):tasks.append(asyncio.create_task(provider_execution.run(context('A'+str(n)),rate_wait_ms=0)))
                await asyncio.sleep(.02)
                other=asyncio.create_task(provider_execution.run(context('B0'),rate_wait_ms=0));tasks.append(other)
                assert await asyncio.to_thread(started_b.wait,1),'Queued wallet blocked the other customer'
                assert not other.done(), 'Other account should still own its running provider request'
                release.set();answers=await asyncio.wait_for(asyncio.gather(*tasks[:8],return_exceptions=True),5)
                for n,answer in enumerate(answers[:8]):
                    assert isinstance(answer,HTTPException),type(answer)
                    assert answer.detail['code']==public_code
                    if n==0 and real_provider_error:
                        assert answer.detail['requestDispatched'] is True
                        assert len(receipts['A0'])==1
                    else:
                        assert answer.detail['requestDispatched'] is False
                        assert answer.detail['providerAttempts']==answer.detail['generationAttempts']==0
                        assert not receipts.get('A'+str(n)), 'Queued admission refusal invented an AI receipt'
                        assert answer.detail['origin']=='control_center'
                        assert answer.detail['traceId']=='trace-A'+str(n)
                assert sorted(label for wallet,label in center_posts if wallet=='A')==['A'+str(n) for n in range(8)]
                assert len([x for x in provider_dispatches if x[0]=='A'])==int(real_provider_error)
                assert not other.done(), 'Failed wallet must not cancel another provider owner'
                release_other.set();other_result=await asyncio.wait_for(other,5)
                assert other_result.result['meta']['usage']['chargedTp']=='9'
                assert len([x for x in provider_dispatches if x[0]=='B'])==1
                assert len(receipts['B0'])==1
                assert not hasattr(shared, 'paid_wallet_gate')
                resumed=await asyncio.wait_for(provider_execution.run(context('A-resumed'),rate_wait_ms=0),5)
                assert resumed.result['meta']['usage']['chargedTp']=='9'
                assert len(receipts['A-resumed'])==1
                assert len([label for wallet,label in center_posts if wallet=='A'])==9
                assert not hasattr(shared, 'paid_wallet_gate')
                if not unlimited:assert shared.ai_admission_gate.stats().running==0
            finally:
                release.set();release_other.set()
                if tasks:await asyncio.gather(*tasks,return_exceptions=True)
                shared.ai_executor.shutdown(wait=True)
    asyncio.run(scenario())
