"""Public diagnostic/customer boundaries; no provider or financial network I/O."""
import json
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.api.routes import logs, meta, paid, local_wire_trace
from backend.ai import local_wire_relay, wire_trace
from backend.ai.clients.provider_error import ProviderHttpError
from backend.ai.failure_reason import provider_http_failure
from backend import diagnostics
from backend.release import RELEASE


@pytest.fixture
def public(monkeypatch, tmp_path):
    app = FastAPI()
    for module in (logs, meta, paid, local_wire_trace):
        app.include_router(module.router)
    @app.get('/fixture-progress')
    async def progress():
        return {'ok': True}
    monkeypatch.setattr(logs.trace, 'enabled', lambda: True)
    monkeypatch.setattr(logs.trace, 'session_id', lambda: 'fixture-session')
    monkeypatch.setattr(logs.trace, 'client', lambda records: len(records))
    monkeypatch.setattr(logs.trace, 'write', lambda *a, **k: None)
    monkeypatch.setattr(logs, '_trace_budget', [time.monotonic(), 0, 0])
    monkeypatch.setattr(local_wire_relay, '_ingress_budget', [time.monotonic(), 0, 0])
    monkeypatch.setattr(wire_trace, 'root_dir', lambda: tmp_path / 'wire')
    monkeypatch.setattr(wire_trace, 'enabled', lambda: True)
    monkeypatch.setattr(logs.logfile, 'log_dir', lambda: tmp_path / 'PRIVATE-SERVER-DIRECTORY')
    monkeypatch.setattr(paid, 'center_base_url', lambda: 'http://127.0.0.1:8787')
    with TestClient(app) as client:
        yield client


def test_public_log_health_excludes_directory_and_inventory(public, tmp_path):
    directory = tmp_path / 'PRIVATE-SERVER-DIRECTORY'
    directory.mkdir()
    (directory / 'PRIVATE-CUSTOMER-FILE.jsonl').write_text('private')
    response = public.get('/v1/logs/where')
    assert response.status_code == 200
    assert response.json()['dir'] == '' and response.json()['files'] == []
    assert 'PRIVATE-' not in response.text
    assert 'write_failures' in response.json()['health']


def test_gateway_status_keeps_readiness_without_setup_instructions(public, monkeypatch):
    async def request(*args, **kwargs):
        return 200, {'available': False, 'code': 'EMAIL_NOT_CONFIGURED',
                     'message': 'PRIVATE-SETUP-STEP',
                     'client_identity': {'verified_gateway': False}}
    monkeypatch.setattr(paid, 'customer_request', request)
    response = public.get('/paid/auth/status')
    assert response.status_code == 200 and not response.json()['available']
    assert not response.json()['client_identity']['ready']
    assert 'PRIVATE-SETUP-STEP' not in response.text
    assert 'TP_CENTER_' not in response.text and 'gateway.key' not in response.text
    assert response.headers['cache-control'] == 'no-store'


@pytest.mark.parametrize('code,status', [('REFUND_NOT_CONFIGURED', 409),
    ('AI_NOT_CONFIGURED', 503), ('GATEWAY_IDENTITY_INVALID', 403), ('UNKNOWN_FAILURE', 502)])
def test_operator_errors_keep_code_without_private_details(public, monkeypatch, code, status):
    async def request(*args, **kwargs):
        return status, {'error': {'code': code, 'message': 'PRIVATE-SETUP-STEP',
                                 'request_id': 'reference-safe',
                                 'details': {'directory': '/PRIVATE-SERVER',
                                             'next_action': 'PRIVATE-ADMIN-STEP'}}}
    monkeypatch.setattr(paid, 'customer_request', request)
    response = public.post('/paid/refunds', json={'payment_id': 'pay_qa'})
    assert response.status_code == status
    assert response.json()['error']['code'] == code
    assert response.json()['error']['request_id'] == 'reference-safe'
    assert 'PRIVATE-' not in response.text and 'details' not in response.json()['error']


def test_authentication_is_still_decided_by_center(public, monkeypatch):
    observed = []
    async def request(path, **kwargs):
        observed.append((path, kwargs['bearer']))
        return 401, {'error': {'code': 'AUTH_REQUIRED', 'message': 'Sign in again.'}}
    monkeypatch.setattr(paid, 'customer_request', request)
    response = public.get('/paid/me', headers={'Authorization': 'Bearer expired-fixture'})
    assert response.status_code == 401 and response.json()['error']['code'] == 'AUTH_REQUIRED'
    assert observed == [('/api/customer/me', 'expired-fixture')]


@pytest.mark.parametrize('chunks', [[b' ' * (512 * 1024 + 1)],
    [b'{"records":', b' ' * (512 * 1024), b'[]}']])
def test_trace_raw_body_limit_precedes_json_parsing(public, monkeypatch, chunks):
    called = []
    original = logs.json.loads
    def parsing(value):
        called.append(True)
        return original(value)
    with monkeypatch.context() as patch:
        patch.setattr(logs.json, 'loads', parsing)
        response = public.post('/v1/trace', content=iter(chunks))
    assert response.status_code == 413 and called == []


def test_trace_invalid_json_is_controlled(public):
    assert public.post('/v1/trace', content=b'{bad').status_code == 400
    assert public.post('/v1/trace', json=[]).status_code == 400


@pytest.mark.parametrize('dimension', ['records', 'bytes'])
def test_trace_budget_cannot_be_bypassed_with_fresh_identity(public, monkeypatch, dimension):
    budget = [time.monotonic(),
              logs.MAX_TRACE_RECORDS_PER_MINUTE if dimension == 'records' else 0,
              logs.MAX_TRACE_BYTES_PER_MINUTE if dimension == 'bytes' else 0]
    monkeypatch.setattr(logs, '_trace_budget', budget)
    response = public.post('/v1/trace', json={'producerId': 'fresh-id',
                                           'records': [{'fn': 'synthetic', 'n': 1}]})
    assert response.status_code == 429 and response.headers['retry-after'] == '60'
    assert public.get('/fixture-progress').json()['ok']


def test_trace_budget_recovers_after_window(public, monkeypatch):
    monkeypatch.setattr(logs, '_trace_budget', [time.monotonic() - 61, 999999, 99999999])
    response = public.post('/v1/trace', json={'records': [{'fn': 'synthetic', 'n': 2}]})
    assert response.status_code == 200 and response.json()['written'] == 1


def relay_payload(operation):
    identity = {'executionKey': operation, 'traceId': 'trace-fixture',
                'operationId': operation, 'jobId': '', 'batchId': '', 'imageId': ''}
    return {'stage': 'trace_started', 'identity': identity}, {
        'X-TP-AI-Wire-Capability': local_wire_relay.CAPABILITY_TOKEN,
        'X-TP-Trace-Id': 'trace-fixture', 'X-TP-Request-Id': operation,
        'X-TP-Job-Id': '', 'X-TP-Batch-Id': '', 'X-TP-Image-Id': ''}


def test_wire_relay_budget_is_shared_across_operations(public, monkeypatch, tmp_path):
    monkeypatch.setattr(local_wire_relay, 'MAX_RELAY_EVENTS_PER_MINUTE', 1)
    payload, headers = relay_payload('first-operation')
    first = public.post('/v2/engine/runsextension/ai/local-wire-trace', json=payload, headers=headers)
    assert first.status_code == 202
    payload, headers = relay_payload('fresh-operation')
    second = public.post('/v2/engine/runsextension/ai/local-wire-trace', json=payload, headers=headers)
    assert second.status_code == 429 and second.headers['retry-after'] == '60'
    assert len(list((tmp_path / 'wire').glob('img-*'))) == 1
    assert public.get('/fixture-progress').json()['ok']


def test_wire_relay_rejects_missing_process_capability(public):
    payload, headers = relay_payload('missing-capability')
    headers.pop('X-TP-AI-Wire-Capability')
    assert public.post('/v2/engine/runsextension/ai/local-wire-trace',
                       json=payload, headers=headers).status_code == 404


@pytest.mark.parametrize('code', ['PAID_PROVIDER_ROUTE', 'PAID_PROVIDER_REQUEST',
    'AI_NOT_CONFIGURED', 'PAID_THINKING_UNVERIFIED', 'MODEL_PRICE_UNVERIFIED'])
def test_paid_public_failure_messages_do_not_describe_admin_setup(code):
    error = ProviderHttpError('private fixture', provider='paid', model='qa/model',
                              status=503, provider_code=code)
    public = provider_http_failure(error)
    assert public.code.startswith('paid_') and not public.retryable
    assert all(word not in public.message for word in
               ('Control Center', 'OpenRouter', 'owner AI key', 'Center trace'))


def test_meta_advertises_current_release_without_credentials(public):
    response = public.get('/meta')
    assert response.json()['diagnostics']['release'] == RELEASE
    assert response.json()['has_env_ai_key'] is False


def test_diagnostic_version_preserves_client_and_uses_current_api_fallback():
    assert diagnostics.writer.release == RELEASE
    with diagnostics.scope(client_version='2026.10.4.13'):
        assert diagnostics.headers()['X-TP-Client-Version'] == '2026.10.4.13'
    with diagnostics.scope(client_version='private invalid version'):
        assert diagnostics.headers()['X-TP-Client-Version'] == RELEASE
