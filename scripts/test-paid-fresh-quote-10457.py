"""Synthetic Center transport; verify atomic price admission and replay boundaries (.60)."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import httpx
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import cloud_paid
sys.path.insert(0,str(Path(__file__).resolve().parent/'lib'))
from paid_center_fake import reset_protocol_cache, with_healthz

RESULT={'model':'qa/test','choices':[{'message':{'content':'<<TP_P0:Translated>>'},'finish_reason':'stop'}],
        'usage':{'prompt_tokens':10,'completion_tokens':4,'total_tokens':14},'charged_tp':'3','balance_tp':'97'}
class FreshQuoteTests(unittest.TestCase):
    def setUp(self):
        self.calls=[];self.dispatches=[];self.replay=False;self.fail_admission=False;self.timeout=False;self.expired=False
        original=httpx.Client
        def client(*a,**kw):
            kw["transport"] = httpx.MockTransport(with_healthz(self.handle))  # + Paid protocol health read
            return original(*a,**kw)
        for p in [patch.object(cloud_paid,'center_base_url',return_value='https://center.test'),
                  patch.object(cloud_paid,'center_origin',return_value='https://center.test'),
                  patch.object(cloud_paid.httpx,'Client',side_effect=client),
                  patch.object(cloud_paid.accounting,'mark_dispatched',side_effect=lambda:self.dispatches.append(True))]:
            p.start();self.addCleanup(p.stop)
        reset_protocol_cache()
    def handle(self,request):
        path=request.url.path;body=json.loads(request.content);self.calls.append((path,body))
        if path.endswith('/chat/receipt'): return httpx.Response(200,json={'found':self.replay,**({'result':RESULT} if self.replay else {})})
        if path.endswith('/price-quote'):
            raise AssertionError('New operations must not make a separate price-quote hop')
        if path.endswith('/chat/completions'):
            if self.expired: return httpx.Response(409,json={'error':{'code':'REQUEST_RESULT_EXPIRED','details':{'credit_state':'settled','provider_dispatched':False,'charged_tp':'3'}}})
            if self.fail_admission: return httpx.Response(503,json={'error':{'code':'PAID_PRICE_REFRESHING','message':'Synthetic'}})
            if self.timeout: raise httpx.ReadTimeout('Synthetic',request=request)
            return httpx.Response(200,json=dict(RESULT, operation_replayed=self.replay))
        raise AssertionError(path)
    def generate(self,old=None):
        return cloud_paid.PaidAdapter().generate(GenerationRequest(provider='paid',model='qa/test',api_key='synthetic-session-token',
            system_text='Translate',user_parts=('<<TP_P0:Source>>',),thinking='minimum',
            cache_context={'operationId':'owned-operation','paidPriceQuoteToken':old or ''},
            model_capabilities={'limits':{'maxOutputTokens':2048}}))
    def bodies(self,suffix): return [b for p,b in self.calls if p.endswith(suffix)]
    def test_new_without_click_token(self):
        self.assertEqual(self.generate().text,'<<TP_P0:Translated>>')
        self.assertEqual(self.bodies('/price-quote'),[])
        self.assertNotIn('price_quote_token',self.bodies('/chat/completions')[0])
    def test_stale_click_token_not_forwarded(self):
        self.generate('old-click-token');self.assertEqual(self.bodies('/price-quote'),[])
        self.assertNotIn('price_quote_token',self.bodies('/chat/completions')[0])
    def test_owned_settled_receipt_skips_quote_and_dispatch(self):
        self.replay=True;r=self.generate()
        self.assertIs(r.usage_details['centerOperationReplayed'],True)
        self.assertEqual(r.usage_details['chargedTp'],'3')
        self.assertEqual(self.bodies('/price-quote'),[]);self.assertEqual(len(self.bodies('/chat/completions')),1);self.assertEqual(self.bodies('/chat/receipt'),[]);self.assertEqual(self.dispatches,[])
    def test_paid_keeps_manual_workload_output_budget_above_8192(self):
        source='Hello world. ' * 2000
        request=GenerationRequest(provider='paid',model='qa/test',api_key='synthetic-session-token',
            system_text='Translate',user_parts=('<<TP_P0:'+source+'>>',),thinking='off',
            cache_context={'operationId':'long-operation'},source_unit_texts=(source,),unit_count=1,
            workload={'version':1,'predictedOutput':12000},model_capabilities={'limits':{'maxOutputTokens':16384,'contextWindow':100000}})
        manual=cloud_paid.prepare_payload(request)
        expected=manual.get('max_completion_tokens',manual.get('max_tokens'))
        cloud_paid.PaidAdapter().generate(request)
        sent=self.bodies('/chat/completions')[0]
        self.assertGreater(expected,8192)
        self.assertEqual(sent['max_tokens'],expected)
        self.assertEqual(sent['output_policy'],'workload_v1')

    def test_expired_historical_result_is_not_new_dispatch(self):
        self.expired=True
        with self.assertRaises(Exception) as caught:self.generate()
        self.assertIs(caught.exception.centerHistoricalResultUnavailable,True)
        self.assertIs(caught.exception.requestDispatched,False)
        self.assertEqual(caught.exception.providerAttempts,0)
        self.assertEqual(self.dispatches,[])

    def test_operation_identity_survives_customer_token_refresh(self):
        for token in ('old-session','new-session'):
            cloud_paid.PaidAdapter().generate(GenerationRequest(provider='paid',model='qa/test',api_key=token,
                system_text='Translate',user_parts=('<<TP_P0:Source>>',),thinking='off',cache_context={'operationId':'same-operation'}))
        bodies=self.bodies('/chat/completions')
        self.assertEqual(bodies[0]['operation_id'],bodies[1]['operation_id'])
        self.assertNotEqual(bodies[0]['legacy_operation_id'],bodies[1]['legacy_operation_id'])

    def test_admission_failure_has_zero_generation_attempts(self):
        self.fail_admission=True
        with self.assertRaises(Exception) as caught:self.generate()
        e=caught.exception
        self.assertIs(e.centerAdmissionRejected,True);self.assertIs(e.requestDispatched,False)
        self.assertEqual(e.providerAttempts,0);self.assertEqual(e.generationAttempts,0)
        self.assertEqual(len(self.bodies('/chat/completions')),1);self.assertEqual(self.dispatches,[])
    def test_timeout_never_resends_uncertain_dispatch(self):
        self.timeout=True
        with self.assertRaises(cloud_paid.ProviderTransportError):self.generate()
        self.assertEqual(len(self.bodies('/chat/completions')),1);self.assertTrue(self.dispatches)
if __name__=='__main__':unittest.main()
