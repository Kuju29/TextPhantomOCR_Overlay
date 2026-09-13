"""Real httpx response vs transport timeout regression; no network requests."""
from pathlib import Path
import json
import sys
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
from backend.ai.clients.provider_error import safe_http_error, upstream_http_status
from backend.ai.failure_reason import classify, provider_http_failure
from backend.api.errors import provider_status
from backend.application.ai_translation import provider_errors

request = httpx.Request('POST', 'https://provider.invalid/generate?key=private-url-token',
                        headers={'Authorization': 'Bearer private-request-secret'})
response = httpx.Response(504, request=request,
                         headers={'X-Private': 'private-response-secret'},
                         text='<html>Gateway Timeout private-body-secret</html>')
try:
    response.raise_for_status()
except httpx.HTTPStatusError as error:
    gateway = error
else:
    raise AssertionError('Expected actual httpx HTTPStatusError')

ctx = SimpleNamespace(
    unit_count=1, char_count=20, trace_id='fixture-trace', correlation={},
    route_identity={}, requested_route='/fixture',
    config=SimpleNamespace(provider='publicai', model='fixture-model', api_key='', image_b64=''),
    rate={'enabled': False}, unlimited=False,
    resolved_provider='publicai', resolved_model='fixture-model',
)


def mapped_detail(error):
    with patch.object(provider_errors.trace, 'write') as trace_write, \
            patch.object(provider_errors, 'failure_event'):
        try:
            provider_errors.raise_execution_error(
                ctx, error, rate_wait_ms=0, admission_wait_ms=0, provider_ms=1)
        except HTTPException as mapped:
            assert mapped.status_code == 502
            assert mapped.headers is None
            return mapped.detail, trace_write.call_args.args[4]
        raise AssertionError('Expected mapped HTTPException')


for error in (gateway, safe_http_error('publicai', response, 'fixture-model')):
    assert upstream_http_status(error) == provider_status(error) == 504
    assert classify(error) == 'provider_timeout'
    semantics = provider_http_failure(error)
    assert semantics.code == 'provider_timeout' and semantics.retryable is True
    assert 'HTTP 504' in semantics.message and 'gateway timeout' in semantics.message
    detail, trace = mapped_detail(error)
    assert detail['upstreamStatus'] == 504 and detail['httpStatus'] == 502
    assert detail['providerFailureKind'] == 'http_status' and detail['requestDispatched'] is True
    assert detail['code'] == 'provider_timeout'
    assert 'HTTP 504' in detail['providerReason']
    assert trace['providerHttpStatuses'] == [504] and trace['upstreamStatus'] == 504
    assert detail['automaticTransportRetry'] is False
    assert detail['automaticContentRetry'] is False
    public = json.dumps(detail)
    for private in ('private-url-token', 'private-request-secret', 'private-response-secret',
                    'private-body-secret', '<html>', 'Authorization', 'X-Private'):
        assert private not in public, private

# An actual no-response timeout must stay distinct, including misleading text.
for message in ('provider timed out', 'provider timed out; HTTP 504 mentioned by caller'):
    error = httpx.ReadTimeout(message, request=request)
    assert upstream_http_status(error) is None
    detail, trace = mapped_detail(error)
    assert detail.get('upstreamStatus') is None
    assert 'providerFailureKind' not in detail
    assert detail['code'] == 'provider_timeout'
    assert 'HTTP 504' not in detail['providerReason']
    assert trace['providerHttpStatuses'] == [] and trace['upstreamStatus'] is None

# SDKs may expose a direct numeric status without a response object.
sdk_error = RuntimeError('upstream request failed')
sdk_error.status_code = 503
assert upstream_http_status(sdk_error) == 503
assert provider_http_failure(sdk_error).code == 'provider_http'
assert provider_http_failure(sdk_error).retryable is True
sdk_error.response = response
sdk_error.status = 400
assert upstream_http_status(sdk_error) == 504, 'actual response takes precedence'
assert upstream_http_status(RuntimeError('legacy HTTP 413')) == 413
assert provider_http_failure(RuntimeError('legacy HTTP 413')).retryable is False
assert upstream_http_status(RuntimeError('legacy HTTP 999')) is None
legacy_detail, _ = mapped_detail(RuntimeError('legacy HTTP 504'))
assert 'providerFailureKind' not in legacy_detail and 'requestDispatched' not in legacy_detail
print('PASS: real httpx HTML 504 preserves status, safe public diagnostics, no-response timeout stays distinct')
