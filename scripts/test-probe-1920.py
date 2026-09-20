"""Real probe service/router, mocked native I/O. No live Provider calls."""
from __future__ import annotations
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from dataclasses import replace
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import httpx
from fastapi import FastAPI
from backend.ai import probe as service
from backend.ai.provider_contract import ProbeRequest, ProbeResponse
from backend.ai.providers import compose_providers, cloud_huggingface as hf
from backend.ai.providers.probe_support import openai_chat_probe, response_error, response_error_details
from backend.api.routes import ai as routes
from backend.config import settings

compose_providers()
PAYLOAD = {'provider': 'openrouter', 'model': 'fixture-model',
           'base_url': 'https://openrouter.ai/api/v1', 'api_key': 'sk-or-v1-fixture-not-real'}

class Probe1920(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(service._PROBE_CACHE, {}, clear=True))
        self.stack.enter_context(patch.dict(service._PROBE_INFLIGHT, {}, clear=True))
        self.stack.enter_context(patch.object(service, 'discovered_model_capabilities', return_value=(True, {})))
        self.stack.enter_context(patch.object(service, 'model_is_promoted', return_value=True))
        self.promotion = self.stack.enter_context(patch.object(service, 'remember_model_promotion'))
        self.rejection = self.stack.enter_context(patch.object(service, 'remember_model_rejection'))
        self.notes = self.stack.enter_context(patch('backend.trace.note'))
        self.adapter = service.provider_registry.get('openrouter').adapter

    def test_identical_six_via_real_asgi_share_one_generation(self):
        count = 0
        lock = threading.Lock()
        def native(req):
            nonlocal count
            with lock: count += 1
            time.sleep(.08)
            return ProbeResponse(True, 200)
        async def run():
            app = FastAPI(); app.include_router(routes.router)
            with patch.object(self.adapter, 'probe', side_effect=native):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture') as client:
                    responses = await asyncio.gather(*[client.post('/ai/probe', json=PAYLOAD) for _ in range(6)])
                    results = [response.json() for response in responses]
                    later = (await client.post('/ai/probe', json=PAYLOAD)).json()
            self.assertEqual(count, 1)
            self.assertTrue(all(item['ok'] for item in results))
            self.assertEqual(sum(item.get('shared', False) for item in results), 5)
            self.assertEqual(len({item['probeId'] for item in results}), 1)
            self.assertTrue(later['cached'])
            self.assertFalse(service._PROBE_INFLIGHT)
            completed = [call for call in self.notes.call_args_list if call.args[0] == 'model_probe_completed']
            self.assertEqual(len(completed), 1)
            self.assertEqual(completed[0].args[1]['model'], PAYLOAD['model'])
            print('ASGI: 6 identical requests -> 1 native call, 5 shared; subsequent request cached')
        asyncio.run(run())

    def test_identity_scopes_stay_parallel(self):
        payloads = [PAYLOAD,
            {**PAYLOAD, 'api_key': PAYLOAD['api_key'] + '-B'},
            {**PAYLOAD, 'model': 'model-B'},
            {'provider': 'huggingface', 'model': 'fixture-model', 'api_key': 'hf_fixture', 'base_url': hf.DEFAULT_BASE_URL}]
        barrier = threading.Barrier(len(payloads))
        calls = []
        def native(req):
            calls.append((req.model, req.base_url, req.api_key))
            barrier.wait(timeout=3)  # Would time out under a global transport lock.
            return ProbeResponse(True, 200)
        with patch.object(self.adapter, 'probe', side_effect=native), patch.object(hf.ADAPTER, 'probe', side_effect=native):
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(service.probe, payloads))
        self.assertEqual(len(calls), 4)
        self.assertEqual(len({item['probeId'] for item in results}), 4)
        self.assertTrue(all(item['ok'] for item in results))
        self.assertFalse(service._PROBE_INFLIGHT)

    def test_effective_endpoint_is_part_of_identity(self):
        self.assertNotEqual(service._cache_key('customlocal', 'm', 'http://localhost:1001', ''),
                            service._cache_key('customlocal', 'm', 'http://localhost:1002', ''))
        self.assertNotEqual(service._cache_key('lmstudio', 'm|http://localhost:1/path', 'http://localhost:2', ''),
                            service._cache_key('lmstudio', 'm', 'http://localhost:1/path|http://localhost:2', ''))
        # A named Cloud provider ignores an untrusted custom hint by design.
        # Such requests MUST coalesce using the same effective endpoint.
        with patch.object(self.adapter, 'probe', return_value=ProbeResponse(True, 200)) as mock:
            first = service.probe(PAYLOAD)
            second = service.probe({**PAYLOAD, 'base_url': 'https://example.invalid/ignored'})
        self.assertEqual(mock.call_count, 1)
        self.assertEqual(first['probeId'], second['probeId'])

    def test_local_endpoints_are_independent_with_real_resolution(self):
        adapter = service.provider_registry.get('lmstudio').adapter
        barrier = threading.Barrier(2)
        def native(req):
            barrier.wait(2)
            return ProbeResponse(True, 200)
        payloads = [{'provider': 'lmstudio', 'model': 'fixture', 'base_url': base}
                    for base in ('http://localhost:1111/v1', 'http://localhost:2222/v1')]
        with patch('backend.security.settings', replace(settings, ai_endpoint_policy='personal')), patch.object(adapter, 'probe', side_effect=native) as mock:
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(service.probe, payloads))
        self.assertEqual(mock.call_count, 2)
        self.assertEqual(len({result['probeId'] for result in results}), 2)

    def test_transport_failure_shared_and_cleaned(self):
        def native(req):
            time.sleep(.06)
            raise httpx.ReadTimeout('fixture only')
        with patch.object(self.adapter, 'probe', side_effect=native) as mock:
            with ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(service.probe, [PAYLOAD] * 6))
        self.assertEqual(mock.call_count, 1)
        self.assertTrue(all(item['status'] == 'unreachable' for item in results))
        self.assertFalse(service._PROBE_INFLIGHT)
        self.rejection.assert_not_called()

    def test_unexpected_exception_shared_not_poisoned(self):
        def native(req):
            time.sleep(.07)
            raise RuntimeError('fixture adapter bug')
        with patch.object(self.adapter, 'probe', side_effect=native) as mock:
            with ThreadPoolExecutor(max_workers=4) as pool:
                jobs = [pool.submit(service.probe, PAYLOAD) for _ in range(4)]
                for job in jobs:
                    with self.assertRaisesRegex(RuntimeError, 'fixture adapter bug'): job.result(timeout=2)
        self.assertEqual(mock.call_count, 1)
        self.assertFalse(service._PROBE_INFLIGHT)
        self.assertFalse(service._PROBE_CACHE)
        with patch.object(self.adapter, 'probe', return_value=ProbeResponse(True, 200)) as mock:
            self.assertTrue(service.probe(PAYLOAD)['ok'])
            self.assertEqual(mock.call_count, 1)

    def test_follower_timeout_never_cancels_or_duplicates_owner(self):
        started, release = threading.Event(), threading.Event()
        def native(req):
            started.set(); self.assertTrue(release.wait(2)); return ProbeResponse(True, 200)
        with patch.object(self.adapter, 'probe', side_effect=native) as mock, patch.object(service, 'PROBE_FOLLOWER_WAIT_SEC', .01):
            with ThreadPoolExecutor(max_workers=1) as pool:
                owner = pool.submit(service.probe, PAYLOAD); self.assertTrue(started.wait(2))
                result = service.probe(PAYLOAD)
                self.assertEqual(result['status'], 'probe_pending')
                self.assertEqual(len(service._PROBE_INFLIGHT), 1)
                self.assertEqual(mock.call_count, 1)
                release.set(); self.assertTrue(owner.result(2)['ok'])
        self.assertFalse(service._PROBE_INFLIGHT)

    def test_cancelled_follower_does_not_cancel_owner(self):
        started, release = threading.Event(), threading.Event()
        def native(req):
            started.set(); self.assertTrue(release.wait(3)); return ProbeResponse(True, 200)
        async def run():
            app = FastAPI(); app.include_router(routes.router)
            with patch.object(self.adapter, 'probe', side_effect=native) as mock:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture') as client:
                    owner = asyncio.create_task(client.post('/ai/probe', json=PAYLOAD))
                    self.assertTrue(await asyncio.to_thread(started.wait, 2))
                    follower = asyncio.create_task(client.post('/ai/probe', json=PAYLOAD))
                    await asyncio.sleep(.025)
                    follower.cancel()
                    release.set()
                    await asyncio.gather(follower, return_exceptions=True)
                    self.assertTrue((await owner).json()['ok'])
                    # A started synchronous waiter unwinds after its owner; no force-kill claim.
                    await asyncio.sleep(.03)
            self.assertEqual(mock.call_count, 1)
            self.assertFalse(service._PROBE_INFLIGHT)
        asyncio.run(run())

    def test_inflight_and_cache_bounds(self):
        started, release = threading.Event(), threading.Event()
        def native(req):
            started.set(); self.assertTrue(release.wait(2)); return ProbeResponse(True, 200)
        with patch.object(service, 'PROBE_MAX_INFLIGHT', 1), patch.object(self.adapter, 'probe', side_effect=native) as mock:
            with ThreadPoolExecutor(max_workers=1) as pool:
                owner = pool.submit(service.probe, PAYLOAD); self.assertTrue(started.wait(2))
                busy = service.probe({**PAYLOAD, 'model': 'other'})
                self.assertEqual(busy['status'], 'probe_busy')
                self.assertEqual(mock.call_count, 1)
                release.set(); owner.result(2)
        with patch.object(service, 'PROBE_MAX_CACHE', 2), patch.object(self.adapter, 'probe', return_value=ProbeResponse(True, 200)):
            for i in range(4): service.probe({**PAYLOAD, 'model': f'new-{i}'})
        self.assertLessEqual(len(service._PROBE_CACHE), 2)

    def test_follower_result_has_independent_nested_values(self):
        with patch.object(self.adapter, 'probe', return_value=ProbeResponse(False, 400, error='fixture', error_details={'provider_code': 'bad_param'})):
            first = service.probe(PAYLOAD)
            first['error_details']['provider_code'] = 'mutated'
            later = service.probe(PAYLOAD)
        self.assertEqual(later['error_details']['provider_code'], 'bad_param')

    def test_hf_lowest_success_never_calls_optional_low(self):
        efforts = []
        def native(req, effort):
            efforts.append(effort)
            if effort == 'none': return ProbeResponse(True, 200)
            raise httpx.ReadTimeout('optional Low must not run')
        with patch.object(hf, '_probe_effort', side_effect=native):
            result = service.probe({'provider': 'huggingface', 'model': 'fixture/off-works',
                                   'base_url': hf.DEFAULT_BASE_URL, 'api_key': 'hf_fixture'})
        self.assertEqual(efforts, ['none'])
        self.assertEqual(result['status'], 'passed')
        # Service discovery is mocked above; adapter output independently proves control acceptance.
        with patch.object(hf, '_probe_effort', return_value=ProbeResponse(True, 200)):
            response = hf.ADAPTER.probe(ProbeRequest(model='fixture'))
        self.assertEqual(response.capabilities['reasoning']['supported_efforts'], ['none'])

    def test_hf_retains_scoped_verified_nonzero_options_without_probing_them(self):
        cap = {'reasoning': {'supported': True, 'control': 'levels', 'supported_efforts': ['none', 'low', 'high']}}
        with patch.object(hf, '_probe_effort', return_value=ProbeResponse(True, 200)) as mock:
            response = hf.ADAPTER.probe(ProbeRequest(model='fixture', model_capabilities=cap))
        self.assertEqual(mock.call_count, 1)
        self.assertEqual(response.capabilities['reasoning']['supported_efforts'], ['none', 'low', 'high'])

    def test_hf_actual_lowest_timeout_still_fails(self):
        with patch.object(hf, '_probe_effort', side_effect=httpx.ReadTimeout('lowest unavailable')) as mock:
            result = service.probe({'provider': 'huggingface', 'model': 'fixture-fail', 'base_url': hf.DEFAULT_BASE_URL, 'api_key': 'hf_fixture'})
        self.assertEqual(result['status'], 'unreachable')
        self.assertEqual(mock.call_count, 1)
        self.promotion.assert_not_called()

    def test_structured_details_and_exact_credential_redaction_to_route(self):
        secret = 'unfamiliar+credential/fixture'
        error = {'error': {'code': 400, 'message': 'Provider returned error', 'metadata': {
            'error_type': 'invalid_request', 'provider_code': 'unsupported_parameter', 'provider_name': 'Fixture',
            'raw': json.dumps({'error': {'message': f'Unsupported reasoning field. api_key="{secret}" Authorization: Bearer sk-very-secret-fixture',
                                        'param': 'reasoning.effort', 'type': 'invalid_request_error'},
                               'headers': {'authorization': secret}, 'prompt': 'DO_NOT_COPY_PROMPT'}),
            'api_key': secret, 'private': 'DO_NOT_COPY_PRIVATE'}}}
        response = httpx.Response(400, json=error)
        details = response_error_details(response, api_key=secret)
        self.assertEqual(details['provider_code'], 'unsupported_parameter')
        self.assertEqual(details['provider_param'], 'reasoning.effort')
        self.assertIn('Unsupported reasoning field', response_error(response, api_key=secret))
        encoded = json.dumps(details)
        for bad in [secret, 'sk-very-secret-fixture', 'DO_NOT_COPY_PROMPT', 'DO_NOT_COPY_PRIVATE']:
            self.assertNotIn(bad, encoded)
        class Client:
            def __init__(self, **kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def post(self, *args, **kwargs): return response
        with patch('backend.ai.providers.probe_support.httpx.Client', Client):
            native = openai_chat_probe(ProbeRequest(model='fixture', api_key=secret, base_url=PAYLOAD['base_url']))
        with patch.object(self.adapter, 'probe', return_value=native), patch.object(routes, 'event') as event:
            result = routes._probe(PAYLOAD)
        self.assertEqual(result['status'], 'request_rejected')
        self.assertFalse(result['ok'])
        self.rejection.assert_not_called()
        self.assertEqual(event.call_args.args[1]['error_details'], details)
        self.assertEqual(result['error_details'], details)

    def test_request_rejection_not_model_demotion_but_model_evidence_is(self):
        for status in ['', 'rejected']:
            with self.subTest(status=status), patch.object(self.adapter, 'probe', return_value=ProbeResponse(False, 400, status, 'Bad request')):
                result = service.probe({**PAYLOAD, 'model': f'bad-request-{status}'})
                self.assertEqual(result['status'], 'request_rejected')
        self.rejection.assert_not_called()
        with patch.object(self.adapter, 'probe', return_value=ProbeResponse(False, 400, error='missing', error_details={'provider_code': 'model_not_found'})):
            result = service.probe({**PAYLOAD, 'model': 'missing-model'})
        self.assertEqual(result['status'], 'model_unavailable')
        self.rejection.assert_called_once()

    def test_details_bounded_malformed_and_non_json(self):
        response = httpx.Response(400, json={'error': {'message': 'x' * 5000, 'metadata': {
            'raw': 'bad' * 10_000, 'error_type': {'must': 'not be serialized'}, 'provider_code': 17}}})
        detail = response_error_details(response)
        self.assertLessEqual(len(detail['message']), 240)
        self.assertNotIn('error_type', detail)
        self.assertEqual(detail['provider_code'], '17')
        self.assertNotIn('very-secret', response_error(httpx.Response(502, text='token=very-secret upstream failed')))

if __name__ == '__main__':
    unittest.main(verbosity=2)
