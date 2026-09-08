"""Actual JS request -> API config -> invocation, before/after catalogue TTL.
External provider adapter is mocked. Network and credentials are never used.
"""
import asyncio
import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from types import SimpleNamespace
from fastapi import FastAPI
import httpx
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
ROOT = Path(os.environ.get('TP_TEST_ROOT', Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(ROOT / 'api'))
from backend.ai import provider_resolution as resolution, markers
from backend.ai.translation.invocation import _translate_once
from backend.application.ai_translation.request_validation import build_config
from backend.ai.provider_registry import provider_registry
from backend.ai.clients.base import ChatResult
from backend.ai.capabilities import OutputCapabilityChanged
from backend.api.routes.ai_v1 import router as ai_router
from backend.application.ai_translation import orchestration, idempotency_session, rate_admission

class CapabilityForwardingAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = Path(__file__).with_name('test-generation-contract.mjs')
        cls.rows = json.loads(subprocess.check_output(['node', str(script), '--capture'], cwd=ROOT, text=True))

    def invoke(self, body):
        calls = []
        def generate(request):
            calls.append(request)
            values = {uid:'คำแปล' for uid in request.expected_ids}
            answer = json.dumps(values, ensure_ascii=False) if request.response_schema else ''.join(f'<<TP_{uid}:คำแปล>>' for uid in values)
            return ChatResult(text=answer,used_model='test-model',input_tokens=20,output_tokens=8,total_tokens=28,
                              finish_reason='stop',terminal_completed=True,terminal_evidence='provider_done')
        spec = provider_registry.require('openrouter')
        with patch.object(spec.adapter, 'generate', side_effect=generate):
            _translate_once(markers.apply([u['text'] for u in body['units']]), body['targetLang'], build_config(body), is_retry=body.get('repair', {}).get('reason') == 'wrong_target_script')
        self.assertEqual(len(calls),1)
        self.assertEqual(len(calls[0].expected_ids),len(body['units']))
        return calls[0]

    def test_page_planner_checkpoint_transport_reaches_same_api_contract(self):
        bodies=json.loads(subprocess.check_output(['node',str(Path(__file__).with_name('test-execution-plan-pipeline.mjs')),'--capture'],cwd=ROOT,text=True))
        self.assertEqual(len(bodies),2)
        for body in bodies:
            resolution._MODEL_CAPABILITIES.clear()
            self.assertEqual(body['provider']['outputContract'],'json_schema_object_v1')
            self.assertIsNotNone(self.invoke(body).response_schema)

    def test_public_http_conflict_has_zero_calls_and_never_retries(self):
        body=copy.deepcopy(self.rows[0]['body']);p=body['provider']
        resolution._MODEL_CAPABILITIES.clear()
        resolution.remember_model_capabilities(p['id'],p['baseUrl'],p['apiKey'],{p['model']:{'structured_output':{'supported':False}}})
        @asynccontextmanager
        async def slot(_):
            yield
        async def reserve(*_):
            return SimpleNamespace(replay=None)
        async def acquire(**_):
            return None,0
        app=FastAPI();app.include_router(ai_router)
        app.state.ai_admission_gate=SimpleNamespace(slot=slot)
        with ThreadPoolExecutor(max_workers=1) as executor:
            app.state.ai_executor=executor
            async def request():
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture.invalid') as client:
                    return await client.post('/v1/ai/translate',json=body)
            # Only unrelated admission/idempotency persistence is isolated. The
            # real router/config/provider executor/invocation/error mapper run.
            with patch.object(idempotency_session,'reserve',side_effect=reserve), patch.object(rate_admission,'acquire',side_effect=acquire), patch.object(provider_registry.require('openrouter').adapter,'generate') as generate:
                reply=asyncio.run(request())
                self.assertEqual(reply.status_code,409,reply.text)
                detail=reply.json()['detail']
                self.assertEqual(detail['code'],'ai_output_capability_changed')
                self.assertFalse(detail['requestDispatched'])
                self.assertEqual(detail['providerAttempts'],0)
                self.assertEqual(detail['generationAttempts'],0)
                self.assertFalse(detail['retryable'])
                generate.assert_not_called()

    def test_true_false_unknown_before_and_after_cache_expiry(self):
        for row in self.rows:
            with self.subTest(name=row['name'],repair=row['repair']):
                resolution._MODEL_CAPABILITIES.clear()
                body = row['body']
                p = body['provider']
                caps = {} if row['supported'] is None else {'structured_output':{'supported':row['supported']}}
                with patch.object(resolution.time,'monotonic',return_value=1000):
                    resolution.remember_model_capabilities(p['id'],p['baseUrl'],p['apiKey'],{p['model']:caps})
                requests = []
                for clock in (1001,1301):
                    with patch.object(resolution.time,'monotonic',return_value=clock):
                        requests.append(self.invoke(body))
                expected = row['supported'] is True
                self.assertEqual(bool(requests[0].response_schema),expected)
                self.assertEqual(bool(requests[1].response_schema),expected)
                self.assertEqual(requests[0].response_schema,requests[1].response_schema)
                self.assertEqual(requests[0].system_text,requests[1].system_text)
                self.assertEqual(requests[0].user_parts,requests[1].user_parts)
                self.assertEqual(requests[0].thinking,requests[1].thinking)
                self.assertEqual(requests[0].expected_ids,requests[1].expected_ids)
                resolution._MODEL_CAPABILITIES.clear()  # API worker restart, no server cache
                self.assertEqual(bool(self.invoke(body).response_schema),expected)

    def test_fresh_server_negative_is_authoritative_not_forced_json(self):
        row=self.rows[0];p=row['body']['provider']
        resolution._MODEL_CAPABILITIES.clear()
        resolution.remember_model_capabilities(p['id'],p['baseUrl'],p['apiKey'],{p['model']:{'structured_output':{'supported':False}}})
        with patch.object(provider_registry.require('openrouter').adapter, 'generate') as generate:
            with self.assertRaises(OutputCapabilityChanged) as caught:
                _translate_once('<<TP_P0>>\nHello', 'th', build_config(row['body']))
            self.assertEqual(caught.exception.providerAttempts, 0)
            self.assertFalse(caught.exception.requestDispatched)
            generate.assert_not_called()

    def test_account_and_model_scopes_do_not_leak(self):
        resolution._MODEL_CAPABILITIES.clear()
        body=copy.deepcopy(next(r['body'] for r in self.rows if r['name']=='unknown'))
        p=body['provider']
        resolution.remember_model_capabilities(p['id'],p['baseUrl'],'different-fixture-key',
            {p['model']:{'structured_output':{'supported':True}}})
        self.assertFalse(self.invoke(body).response_schema)
        resolution.remember_model_capabilities(p['id'],p['baseUrl'],p['apiKey'],
            {'different-model':{'structured_output':{'supported':True}}})
        self.assertFalse(self.invoke(body).response_schema)

    def test_planned_markers_never_upgraded_after_packing(self):
        body = copy.deepcopy(next(r['body'] for r in self.rows if r['name']=='unsupported'))
        p=body['provider'];resolution._MODEL_CAPABILITIES.clear()
        resolution.remember_model_capabilities(p['id'],p['baseUrl'],p['apiKey'],{p['model']:{'structured_output':{'supported':True}}})
        self.assertIsNone(self.invoke(body).response_schema)

    def test_invalid_plan_rejected_before_generation(self):
        body=copy.deepcopy(self.rows[0]['body'])
        for value in ('anything', True, {}, None):
            body['provider']['outputContract']=value
            with self.subTest(value=value), self.assertRaises(ValueError):
                build_config(body)

    def test_legacy_and_standalone_contract_defaults_unchanged(self):
        body=copy.deepcopy(self.rows[0]['body']);body['provider'].pop('outputContract')
        resolution._MODEL_CAPABILITIES.clear()
        self.assertIsNotNone(self.invoke(body).response_schema)
        body['provider']['modelCapabilities']={}
        self.assertIsNone(self.invoke(body).response_schema)

if __name__ == '__main__': unittest.main(verbosity=2)
