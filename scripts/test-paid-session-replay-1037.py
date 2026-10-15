"""Actual API orchestration/replay; only Center HTTP and image OCR/render are mocked."""
import copy
import os
import sys
import unittest
import uuid
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault('TP_CENTER_URL', 'http://127.0.0.1:8787')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import httpx
from fastapi.testclient import TestClient
from backend.main import app
from backend import paid_center
from backend.application import idempotency, translate_service
from backend.ai.providers.cloud_paid import ADAPTER
from backend.ai.clients.provider_error import safe_http_error
from backend.ai.failure_reason import provider_http_failure, is_rate_limited


class ReplayTests(unittest.TestCase):
    def setUp(self):
        idempotency.clear()
        self.state = 'active'
        self.calls = []
        self.generations = 0
        self.images = 0
        self.token = 'qa-customer-session-' + uuid.uuid4().hex
        self.text = {'operationId': 'private-operation', 'units': [{'id': 'P0', 'text': 'HELLO'}],
                     'targetLang': 'th', 'sourceLang': 'en', 'translationMode': 'independent',
                     'provider': {'id': 'paid', 'apiKey': self.token, 'model': 'qa/test', 'thinking': 'off'}}
        self.image = {'mode': 'lens_text', 'source': 'ai', 'lang': 'th',
                      'idempotency_key': 'private-image', 'imageDataUri': 'data:image/png;base64,QA',
                      'ai': {'provider': 'paid', 'api_key': self.token, 'model': 'qa/test',
                             'translation_mode': 'independent'}}
        sync, asynchronous = httpx.Client, httpx.AsyncClient
        self.client = TestClient(app)
        self.patches = [
            patch('httpx.Client', lambda **kw: sync(transport=httpx.MockTransport(self.center), **kw)),
            patch('httpx.AsyncClient', lambda **kw: asynchronous(transport=httpx.MockTransport(self.center), **kw)),
            patch.object(translate_service, '_execute', self.image_pipeline)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.addCleanup(self.client.close)

    def center(self, request):
        self.assertEqual(request.headers['Authorization'], 'Bearer ' + self.token)
        self.calls.append(request.url.path)
        if request.url.path.endswith('/auth/logout'):
            self.state = 'revoked'
            return httpx.Response(200, json={'ok': True})
        if self.state == 'down':
            raise httpx.ConnectError('QA Center offline', request=request)
        if self.state == 'revoked':
            return httpx.Response(401, json={'error': {'code': 'AUTH_REQUIRED'}})
        if self.state == 'invalid':
            return httpx.Response(200, json=[])
        if request.url.path.endswith('/me'):
            if self.state == 'expire_after_models':
                self.state = 'revoked'
            return httpx.Response(200, json={'ok': True, 'models': [{'id': 'qa/test',
                'model_capabilities': {'reasoning': {'supported': False}}}]})
        self.assertTrue(request.url.path.endswith('/chat/completions'))
        self.generations += 1
        return httpx.Response(200, json={'id': 'gen-qa', 'model': 'qa/test',
            'choices': [{'message': {'role': 'assistant', 'content': '<<TP_P0:ข้อมูลส่วนตัว>>'},
                         'finish_reason': 'stop'}],
            'usage': {'cost': '0.001', 'prompt_tokens': 13, 'completion_tokens': 4},
            'charged_tp': '825', 'balance_tp': '9175'})

    async def image_pipeline(self, payload, request):
        await paid_center.authorize_replay(payload['ai']['api_key'])
        self.images += 1
        return {'result': 'private image result', 'meta': {'providerAttempts': 1}}

    def send(self, image=False):
        route = '/v2/engine/runsapi/translate' if image else '/v2/engine/runsextension/ai/translate'
        return self.client.post(route, json=copy.deepcopy(self.image if image else self.text),
                                headers={'Idempotency-Key': 'private-operation'} if not image else {})

    def seed(self):
        for image in (False, True):
            response = self.send(image)
            self.assertEqual(response.status_code, 200, response.text)

    def test_active_replay_authenticates_without_generation(self):
        self.seed()
        for image in (False, True):
            before = len(self.calls)
            response = self.send(image)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()['replayed'])
            self.assertEqual(self.calls[before:], ['/api/customer/me'])
        self.assertEqual((self.generations, self.images), (1, 1))

    def reject_cached(self, state, status):
        self.seed()
        self.state = state
        for image in (False, True):
            with self.subTest(image=image):
                response = self.send(image)
                self.assertEqual(response.status_code, status, response.text)
                self.assertNotIn('ข้อมูลส่วนตัว', response.text)
                self.assertNotIn('private image result', response.text)
        self.assertEqual((self.generations, self.images), (1, 1))

    def test_externally_revoked_session_cannot_read_cache(self):
        self.reject_cached('revoked', 401)

    def test_center_offline_does_not_release_cached_content(self):
        self.reject_cached('down', 503)

    def test_invalid_center_response_does_not_release_cached_content(self):
        self.reject_cached('invalid', 502)

    def test_logout_revokes_both_cached_routes(self):
        self.seed()
        response = self.client.post('/paid/auth/logout', json={},
                                    headers={'Authorization': 'Bearer ' + self.token})
        self.assertEqual(response.status_code, 200)
        for image in (False, True):
            self.assertEqual(self.send(image).status_code, 401)
        self.assertEqual((self.generations, self.images), (1, 1))

    def test_generation_auth_failure_is_customer_session_not_owner_key(self):
        for code, expected_status, expected_code in (
            ('AUTH_REQUIRED', 401, 'paid_login_required'),
            ('PAID_PROVIDER_AUTH', 502, 'paid_provider_auth')):
            error = safe_http_error('paid', httpx.Response(401, json={'error': {'code': code}}), 'qa/test')
            mapped = provider_http_failure(error)
            self.assertEqual((mapped.status, mapped.code), (expected_status, expected_code))
            self.assertFalse(mapped.retryable)
            self.assertFalse(is_rate_limited(error))

    def test_session_expiring_after_preflight_is_reported_as_login_required(self):
        self.state = 'expire_after_models'
        response = self.send()
        self.assertEqual(response.status_code, 401, response.text)
        self.assertIn('paid_login_required', response.text)
        self.assertIn('กรุณาเข้าสู่ระบบอีกครั้ง', response.text)
        self.assertNotIn('provider_auth_failed', response.text)
        self.assertEqual(self.generations, 0)

    def test_model_response_validation(self):
        for body, expected in (([], 'error'), ({'models': 42}, 'error'),
                ({'models': [None]}, 'error'), ({'models': [{'id': ''}]}, 'error'),
                ({'models': []}, 'valid'), ({'models': [{'id': 'qa/test'}]}, 'valid')):
            with self.subTest(body=body):
                # A tiny provider HTTP fixture avoids network and keeps response parsing real.
                class HTTP:
                    def __init__(self, **kw): pass
                    def __enter__(self): return self
                    def __exit__(self, *a): pass
                    def get(self, *a, **kw): return httpx.Response(200, json=body)
                with patch('httpx.Client', HTTP):
                    self.assertEqual(ADAPTER.list_models(api_key=self.token, base_url='').status, expected)

    def test_center_port_validation(self):
        for url in ('http://127.0.0.1:bad', 'http://127.0.0.1:99999', 'http://127.0.0.1:0'):
            with self.subTest(url=url), patch.object(paid_center, 'settings', SimpleNamespace(center_url=url)):
                with self.assertRaisesRegex(RuntimeError, 'valid port'):
                    paid_center.center_base_url()
        for url in ('http://127.0.0.1:8787', 'http://[::1]:7860', 'https://center.example:443'):
            with patch.object(paid_center, 'settings', SimpleNamespace(center_url=url)):
                self.assertEqual(paid_center.center_base_url(), url)


if __name__ == '__main__':
    unittest.main(verbosity=2)
