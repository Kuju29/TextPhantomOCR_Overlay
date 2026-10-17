"""Actual FastAPI routes and Paid adapter with fictional owned Center receipts.

Run --http where asyncio loopback sockets are allowed. No live Center/provider
traffic, credentials or wallet mutation occurs; upstream is httpx.MockTransport.
"""
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'api'))
os.environ['TP_CENTER_URL']='https://center.fixture.invalid'
os.environ['TP_AI_WIRE_TRACE']='0'
import httpx
from fastapi import FastAPI
from backend.ai.provider_bootstrap import ensure_provider_registry
ensure_provider_registry()
from backend.api.routes.ai_v1 import router
from backend.jobs.admission import AdmissionGate
from backend.application import idempotency
from backend.application.ai_translation import provider_execution
from backend.ai.translation_paths import store as conversations

RUN_HTTP='--http' in sys.argv
if RUN_HTTP:sys.argv.remove('--http')


@unittest.skipUnless(RUN_HTTP,'Pass --http to execute actual ASGI requests')
class PaidReplayErrors(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        idempotency.clear();conversations._stores.clear()
        self.app=FastAPI();self.app.include_router(router)
        self.app.state.ai_admission_gate=AdmissionGate(2)
        self.app.state.ai_executor=None
        self.calls=[];self.replay=True;self.foreign=False;self.answer=''
        client_type=httpx.Client
        def transport(request):
            self.assertEqual((request.url.scheme,request.url.host),('https','center.fixture.invalid'))
            self.assertEqual(request.headers['authorization'],'Bearer '+'q'*64)
            self.calls.append(request.url.path)
            if request.url.path=='/api/customer/me':
                self.assertEqual(request.method,'GET')
                return httpx.Response(200,json={'models':[{'id':'qa/test','name':'Synthetic model',
                    'max_output':8192,'model_capabilities':{'structured_output':{'supported':False},
                        'reasoning':{'supported':False},'limits':{'contextTokens':32768}}}]})
            body=json.loads(request.content)
            if request.url.path.endswith('/chat/receipt'):
                if self.foreign:return httpx.Response(401,json={'error':{'code':'AUTH_REQUIRED'}})
                return httpx.Response(200,json={'found':True,'result':self.result(body)} if self.replay else {'found':False})
            if request.url.path.endswith('/price-quote'):
                return httpx.Response(200,json={'quote_token':'synthetic-renewed-quote'})
            self.assertTrue(request.url.path.endswith('/chat/completions'))
            self.assertEqual(body['price_quote_token'],'synthetic-renewed-quote')
            return httpx.Response(200,json=self.result(body))
        self.patch=patch('backend.ai.providers.cloud_paid.httpx.Client',
            side_effect=lambda **kw:client_type(transport=httpx.MockTransport(transport),**kw))
        self.patch.start()
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url='http://test')

    async def asyncTearDown(self):
        await self.client.aclose();self.patch.stop();idempotency.clear();conversations._stores.clear()

    def result(self,body):
        return {'model':'qa/test','choices':[{'message':{'content':self.answer},'finish_reason':'stop'}],
                'charged_tp':3,'balance_tp':997,'usage':{'cost':'0.0001','prompt_tokens':10,'completion_tokens':5}}

    def payload(self):
        return {'schema':'tp.ai.request/1','operationId':'synthetic-http-owned-receipt',
            'translationMode':'independent','userRunId':'click_fixture',
            'units':[{'id':'P0','text':'Synthetic source'}],'targetLang':'th',
            'provider':{'id':'paid','model':'qa/test','apiKey':'q'*64,'thinking':'default',
                'priceQuoteToken':'synthetic-initial-quote','modelCapabilities':{
                    'limits':{'contextTokens':32768,'maxOutputTokens':8192}}},
            'memory':{'mode':'off'},'repair':{'owner':'extension','enabled':False}}

    def operation_calls(self):
        return [p.rsplit('/',1)[-1] for p in self.calls if p!='/api/customer/me']

    async def test_owned_settled_malformed_receipt_reports_zero_new_execution(self):
        response=await self.client.post('/v2/engine/runsextension/ai/translate',json=self.payload())
        self.assertEqual(response.status_code,502,response.text)
        detail=response.json()['detail']
        self.assertEqual((detail['generationAttempts'],detail['providerAttempts']),(0,0))
        self.assertFalse(detail['requestDispatched'])
        self.assertFalse(detail['automaticTransportRetry']);self.assertFalse(detail['automaticContentRetry'])
        self.assertEqual(self.operation_calls(),['receipt'])
        usage=detail['structuralDetails']['generationMeta']['usage']
        self.assertEqual(usage['chargedTp'],3)
        self.assertTrue(usage['centerOperationReplayed'])
        # Error retries retrieve the owned receipt again, never quote/dispatch.
        again=await self.client.post('/v2/engine/runsextension/ai/translate',json=self.payload())
        self.assertEqual(again.status_code,502,again.text)
        self.assertEqual(self.operation_calls(),['receipt','receipt'])

    async def test_fresh_malformed_completion_keeps_one_real_execution(self):
        self.replay=False
        response=await self.client.post('/v2/engine/runsextension/ai/translate',json=self.payload())
        self.assertEqual(response.status_code,502,response.text)
        detail=response.json()['detail']
        self.assertEqual((detail['generationAttempts'],detail['providerAttempts']),(1,1))
        self.assertTrue(detail['requestDispatched'])
        self.assertEqual(self.operation_calls(),['receipt','price-quote','completions'])

    async def test_foreign_receipt_failure_never_dispatches_or_returns_retained_usage(self):
        self.foreign=True
        response=await self.client.post('/v2/engine/runsextension/ai/translate',json=self.payload())
        self.assertEqual(response.status_code,401,response.text)
        self.assertEqual(self.operation_calls(),['receipt'])
        self.assertNotIn('chargedTp',response.text)
        self.assertNotIn('centerOperationReplayed',response.text)

    async def test_cancel_after_owned_receipt_is_zero_new_execution(self):
        self.answer='<<TP_P0:คำแปล>>'
        with patch.object(provider_execution,'_cancelled',side_effect=lambda ctx:'/api/customer/chat/receipt' in self.calls):
            response=await self.client.post('/v2/engine/runsextension/ai/translate',json=self.payload())
        self.assertEqual(response.status_code,409,response.text)
        detail=response.json()['detail']
        self.assertEqual(detail['generationAttempts'],0)
        self.assertEqual(detail['providerAttempts'],0)
        self.assertFalse(detail['requestDispatched'])
        usage=detail['structuralDetails']['generationMeta']['usage']
        self.assertEqual(usage['generationCount'],0)
        self.assertEqual(usage['inputTokens'],0)
        self.assertEqual(usage['retainedGenerations'][0]['chargedTp'],3)
        self.assertEqual(self.operation_calls(),['receipt'])

    async def test_cancel_after_fresh_completion_keeps_one_actual_execution(self):
        self.replay=False;self.answer='<<TP_P0:คำแปล>>'
        with patch.object(provider_execution,'_cancelled',side_effect=lambda ctx:'/api/customer/chat/completions' in self.calls):
            response=await self.client.post('/v2/engine/runsextension/ai/translate',json=self.payload())
        self.assertEqual(response.status_code,409,response.text)
        detail=response.json()['detail']
        self.assertEqual(detail['generationAttempts'],1)
        self.assertTrue(detail['requestDispatched'])
        self.assertEqual(detail['structuralDetails']['generationMeta']['usage']['chargedTp'],3)
        self.assertNotIn('centerOperationReplayed',detail)
        self.assertEqual(self.operation_calls(),['receipt','price-quote','completions'])


if __name__=='__main__':unittest.main()
