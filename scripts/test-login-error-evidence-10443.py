"""Actual public Login and translation error boundaries retain safe facts only."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.login.login_provider_contract import LoginError
from backend.ai.login.login_routes import failure_response
from backend.application.ai_translation.provider_errors import raise_execution_error
from fastapi import HTTPException

def fixture(*, reason='browser_challenge_header', verified=True, dispatched=False):
    error = LoginError('login_endpoint_challenge_required', 'Fixture provider connection failed.', 409)
    error.provider_reason = reason
    error.identity_verified = verified
    error.upstream_status = 403
    error.endpoint_step = 'chatgpt_catalogue'
    error.requestDispatched = dispatched
    error.diagnostic_logged = True
    error.credentials = 'fixture-private-value'
    return error

def translate_error(error):
    ctx = SimpleNamespace(unit_count=1, trace_id='fixture-trace', correlation={},
                          requested_route='fixture', route_identity={})
    with patch('backend.application.ai_translation.provider_errors.trace_failure'), \
         patch('backend.application.ai_translation.provider_errors.failure_event'):
        try:
            raise_execution_error(ctx, error, rate_wait_ms=0, admission_wait_ms=0, provider_ms=0)
        except HTTPException as value:
            return value.detail
    raise AssertionError('Expected public translation failure')

class ErrorEvidence(unittest.TestCase):
    def test_login_route_preserves_verified_identity_and_challenged_endpoint(self):
        response = failure_response(fixture())
        value = json.loads(response.body)['error']
        self.assertIs(value.get('identityVerified'), True)
        self.assertEqual(value['provider_reason'], 'browser_challenge_header')
        self.assertEqual(value['endpoint_step'], 'chatgpt_catalogue')
        self.assertEqual(value['upstream_status'], 403)
        self.assertNotIn('fixture-private-value', response.body.decode())

    def test_translation_route_preserves_safe_reason_and_verified_identity(self):
        value = translate_error(fixture(dispatched=True))
        self.assertIs(value.get('identityVerified'), True)
        self.assertEqual(value.get('providerReason'), 'browser_challenge_header')
        self.assertEqual(value['endpointStep'], 'chatgpt_catalogue')
        self.assertEqual(value['upstreamStatus'], 403)
        self.assertFalse(value['automaticTransportRetry'])

    def test_provider_service_reply_keeps_actual_http200_and_no_retry(self):
        error = fixture(reason='provider_error_reply', verified=False, dispatched=True)
        error.code = 'login_provider_reply_failed'
        error.status = 502
        error.upstream_status = 200
        error.endpoint_step = 'gemini_completion'
        value = translate_error(error)
        self.assertEqual(value.get('providerReason'), 'provider_error_reply')
        self.assertEqual(value['upstreamStatus'], 200)
        self.assertNotIn('identityVerified', value)
        self.assertFalse(value['automaticContentRetry'])

    def test_arbitrary_reason_and_nonboolean_identity_are_not_exposed(self):
        for verified in [False, 'true', 1, {'token': 'fixture-private-value'}]:
            error = fixture(reason='fixture-private-value', verified=verified)
            login = json.loads(failure_response(error).body)['error']
            translated = translate_error(error)
            for value in [login, translated]:
                self.assertNotIn('identityVerified', value)
                self.assertNotIn('fixture-private-value', json.dumps(value))

if __name__ == '__main__':
    unittest.main()
