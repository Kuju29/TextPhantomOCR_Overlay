"""Actual Paid adapter and API configuration; synchronous synthetic provider only."""
import hashlib
import sys
import unittest
from contextvars import copy_context
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
sys.path.insert(0, str(Path(__file__).resolve().parent / 'lib'))
from paid_center_fake import HealthzClient, reset_protocol_cache
from backend.application.ai_translation.request_validation import build_config
from backend.jobs.stages.config import build_ai_config
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers.cloud_paid import ADAPTER
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation_paths.ready_registry import ReadyRegistry


class Client(HealthzClient):  # also answers the Paid protocol health read
    calls=[]
    def post(self, url, json, headers):
        if url.endswith('/chat/receipt'):
            class Receipt:
                status_code=200;is_success=True;headers={}
                def json(self):return {'found':False}
            return Receipt()
        if url.endswith('/price-quote'):
            class Quote:
                status_code=200; is_success=True; headers={}
                def json(self): return {'quote_token':'synthetic-owned-route-quote'}
            return Quote()
        self.calls.append(json)
        class Response:
            status_code=200; is_success=True; headers={}
            def json(self): return {'choices':[{'message':{'content':'Translated'}}], 'model':'qa/test', 'charged_tp':'43', 'balance_tp':'57'}
        return Response()


class TranslationRuns(unittest.TestCase):
    def test_ingress_and_job_configuration_preserve_owned_click(self):
        provider={'id':'paid','apiKey':'synthetic-session'}
        self.assertEqual(build_config({'targetLang':'th','provider':provider,'operationId':'gen-A','userRunId':'click-A','batchId':'click-A'}).paid_user_run_id,'click-A')
        self.assertEqual(build_config({'targetLang':'th','provider':provider,'batchId':'legacy-click'}).paid_user_run_id,'legacy-click')
        job=build_ai_config({'metadata':{'batch_id':'click-all'},'idempotency_key':'image-A','ai':{'provider':'paid','api_key':'synthetic-session'}},'lens_text','ai')
        self.assertEqual((job.paid_user_run_id,job.paid_operation_id),('click-all','image-A'))
        self.assertEqual(build_config({'provider':provider}).paid_user_run_id,'')
        with self.assertRaises(ValueError): build_config({'provider':provider,'userRunId':'not an opaque id'})

    def test_actual_invocation_preserves_user_run_in_initial_and_repair_generation(self):
        from backend.ai import markers
        from backend.ai.clients.base import ChatResult
        from backend.ai.provider_registry import provider_registry
        from backend.ai.translation.invocation import translate
        config=AiConfig(api_key='synthetic',provider='openrouter',model='fixture',thinking='default',style_examples=False,paid_operation_id='initial-operation',paid_user_run_id='same-user-click')
        captured=[]
        def generate(request):
            captured.append(request)
            return ChatResult(text='<<TP_P0:I>>',used_model='fixture',finish_reason='stop',terminal_completed=True,terminal_evidence='provider_done')
        with patch.object(provider_registry.require('openrouter').adapter,'generate',side_effect=generate):
            translate(markers.apply(['Hello world']),'en',config)
            config.paid_operation_id='repair-operation'
            translate(markers.apply(['Hello world']),'en',config,is_retry=True)
        self.assertEqual([r.cache_context['userRunId'] for r in captured],['same-user-click']*2)
        self.assertEqual([r.cache_context['operationId'] for r in captured],['initial-operation','repair-operation'])

    def test_real_adapter_hash_stable_across_session_refresh_and_distinct_generations(self):
        Client.calls=[]
        reset_protocol_cache()
        with patch('backend.ai.providers.cloud_paid.center_base_url',return_value='https://fixture.invalid'), patch('backend.ai.providers.cloud_paid.center_origin',return_value='https://fixture.invalid'), patch('backend.ai.providers.cloud_paid.httpx.Client',Client):
            for credential, operation in [('session-before','main'),('session-before','repair'),('session-after','last')]:
                ADAPTER.generate(GenerationRequest(provider='paid',model='qa/test',api_key=credential,system_text='Translate',user_parts=('Hello world',),cache_context={'operationId':operation,'userRunId':'user-click','paidPriceQuoteToken':'qa-click-preflight'}))
            expected=hashlib.sha256(b'tp-user-run\0user-click').hexdigest()
            self.assertEqual({p['user_run_id'] for p in Client.calls},{expected})
            self.assertEqual(len({p['operation_id'] for p in Client.calls}),3)
            ADAPTER.generate(GenerationRequest(provider='paid',model='qa/test',api_key='synthetic',system_text='Translate',user_parts=('Hello world',),cache_context={'operationId':'legacy','paidPriceQuoteToken':'qa-click-preflight'}))
            self.assertNotIn('user_run_id',Client.calls[-1])
            before=len(Client.calls)
            with self.assertRaises(ValueError): ADAPTER.generate(GenerationRequest(provider='paid',model='qa/test',api_key='synthetic',system_text='Translate',user_parts=('Hello world',),cache_context={'operationId':'bad','userRunId':{'id':'bad'}}))
            self.assertEqual(len(Client.calls),before)

    def test_actual_python_ready_partition_owns_exactly_one_click(self):
        seen=[]
        def dispatch(rows,*_args):
            seen.append([row['ticket'].ai.paid_user_run_id for row in rows])
            return {'values':['คำแปล']*len(rows),'meta':{},'batchId':'operation-'+str(len(seen))}
        registry=ReadyRegistry(dispatch,lambda rows,*_: (rows,{},'ready_queue_drained'),lambda t:list(t.values.values()),lambda _:None)
        configs=[AiConfig(api_key='synthetic',provider='paid',model='qa/test',paid_user_run_id=run,conversation={'owner':'qa','documentId':'same-document','pageId':str(i),'pageIndex':i}) for i,run in enumerate(['one','one','two'])]
        tickets=[registry.reserve(ai,'th') for ai in configs]
        # Feed ready data under the production lock so the first dispatch sees
        # all three pages, matching OCR completions accumulated behind a turn.
        with registry.lock:
            for t in tickets: t.units=['Hello']; t.options={'compat':'same'}; t.context=copy_context()
            registry._start(tickets[0].group)
        self.assertEqual([t.future.result(timeout=3) for t in tickets],[['คำแปล']]*3)
        self.assertEqual(seen,[['one','one'],['two']])

if __name__=='__main__': unittest.main()
