"""Native selected-model probe helpers (adapter level), mocked I/O. No live Provider calls.

10491: the /ai/probe route and its service cache were removed (Manual models
are no longer probed when selected). Adapter probe() stays part of the
ProviderAdapter contract (Local runtimes use it); its error details must stay
bounded and credential-free.
"""
from __future__ import annotations
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import httpx
from backend.ai.provider_contract import ProbeRequest, ProbeResponse
from backend.ai.providers import compose_providers, cloud_huggingface as hf
from backend.ai.providers.probe_support import openai_chat_probe, response_error, response_error_details

compose_providers()
BASE_URL = 'https://openrouter.ai/api/v1'

class Probe1920(unittest.TestCase):
    def test_probe_route_and_service_are_removed(self):
        root = Path(__file__).resolve().parents[1] / 'api' / 'backend'
        self.assertFalse((root / 'ai' / 'probe.py').exists())
        # 2026.10.16.3: the live probe service stays removed; /ai/probe is a
        # no-cost compatibility stub for the 2026.9.27.26 popup (no provider call).
        import asyncio, inspect
        from backend.api.routes import ai as routes
        stub = [route for route in routes.router.routes if getattr(route, 'path', '') == '/ai/probe']
        self.assertEqual(len(stub), 1)
        self.assertEqual(list(inspect.signature(stub[0].endpoint).parameters), [])  # never reads the key
        self.assertEqual(asyncio.run(stub[0].endpoint()),
                         {'ok': False, 'status': 'not_tested', 'model_capabilities': {}})

    def test_hf_lowest_success_never_calls_optional_low(self):
        efforts = []
        def native(req, effort):
            efforts.append(effort)
            if effort == 'none': return ProbeResponse(True, 200)
            raise httpx.ReadTimeout('optional Low must not run')
        with patch.object(hf, '_probe_effort', side_effect=native):
            response = hf.ADAPTER.probe(ProbeRequest(model='fixture'))
        self.assertEqual(efforts, ['none'])
        self.assertTrue(response.ok)
        self.assertEqual(response.capabilities['reasoning']['supported_efforts'], ['none'])

    def test_hf_retains_scoped_verified_nonzero_options_without_probing_them(self):
        cap = {'reasoning': {'supported': True, 'control': 'levels', 'supported_efforts': ['none', 'low', 'high']}}
        with patch.object(hf, '_probe_effort', return_value=ProbeResponse(True, 200)) as mock:
            response = hf.ADAPTER.probe(ProbeRequest(model='fixture', model_capabilities=cap))
        self.assertEqual(mock.call_count, 1)
        self.assertEqual(response.capabilities['reasoning']['supported_efforts'], ['none', 'low', 'high'])

    def test_hf_actual_lowest_timeout_still_fails(self):
        with patch.object(hf, '_probe_effort', side_effect=httpx.ReadTimeout('lowest unavailable')) as mock:
            with self.assertRaises(httpx.ReadTimeout):
                hf.ADAPTER.probe(ProbeRequest(model='fixture-fail', base_url=hf.DEFAULT_BASE_URL, api_key='hf_fixture'))
        self.assertEqual(mock.call_count, 1)

    def test_structured_details_and_exact_credential_redaction(self):
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
            native = openai_chat_probe(ProbeRequest(model='fixture', api_key=secret, base_url=BASE_URL))
        self.assertFalse(native.ok)
        self.assertEqual(dict(native.error_details), details)
        for bad in [secret, 'sk-very-secret-fixture']:
            self.assertNotIn(bad, native.error)

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
