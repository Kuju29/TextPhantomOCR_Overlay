"""Failed Login cleanup stays idempotent, private and authorized."""
import hashlib
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
from backend.ai.login import login_native, login_routes as routes, login_session_store as store, login_provider_registry as registry
from backend.ai.login.endpoint import login_endpoint_session as endpoint
from backend.ai.login.login_provider_contract import LoginError
from starlette.requests import Request

OWNER, OTHER = 'fixture-owner', 'another-owner'


def rejected(action, code='login_auth_expired'):
    try:
        action()
    except LoginError as error:
        assert error.code == code, error.code
        return error
    raise AssertionError('An unavailable or foreign flow must not be accepted')


def failed_import():
    flow = endpoint.start(OWNER, 'login_claude')
    def fail(*args):
        raise LoginError('login_endpoint_challenge_required', 'Browser verification required.', 409)
    # Keep the original full-validator cancellation seam; public authentication
    # only has a separate actual-provider regression in 10451.
    with patch.object(registry, 'translation_supported', return_value=True), \
            patch.object(login_native, 'module', return_value=SimpleNamespace(endpoint_validate=fail)):
        rejected(lambda: endpoint.complete(OWNER, 'login_claude', flow['flow_id'], flow['state'],
            'fixture-browser', hashlib.sha256(b'fixture-identity').hexdigest(),
            {'organization': 'fixture-org'}, lambda: OWNER), 'login_endpoint_challenge_required')
    return flow


endpoint.clear()
try:
    # Replay the actual log sequence: a rejected import is followed by cleanup.
    flow = failed_import()
    expected = {'ok': True, 'status': 'cancelled'}
    assert endpoint.cancel(OWNER, 'login_claude', flow['flow_id']) == expected
    assert endpoint.cancel(OWNER, 'login_claude', flow['flow_id']) == expected
    assert flow['flow_id'] not in endpoint._flows, 'Cleanup cannot revive a closed flow'
    rejected(lambda: endpoint.status(OWNER, 'login_claude', flow['flow_id']))
    rejected(lambda: endpoint.cancel(OTHER, 'login_claude', flow['flow_id']))
    rejected(lambda: endpoint.cancel(OWNER, 'login_gemini', flow['flow_id']))
    rejected(lambda: endpoint.cancel(OWNER, 'login_claude', 'lgf_' + '0' * 48))
    with patch.object(login_native, 'module') as module:
        rejected(lambda: endpoint.complete(OWNER, 'login_claude', flow['flow_id'], flow['state'],
            'fixture-browser', hashlib.sha256(b'fixture-identity').hexdigest(),
            {'organization': 'fixture-org'}, lambda: OWNER))
        module.assert_not_called()

    # A foreign live flow gets the same unavailable response and stays intact.
    live = endpoint.start(OWNER, 'login_claude')
    foreign = rejected(lambda: endpoint.cancel(OTHER, 'login_claude', live['flow_id']))
    absent = rejected(lambda: endpoint.cancel(OTHER, 'login_claude', 'lgf_' + '0' * 48))
    assert (foreign.status, str(foreign)) == (absent.status, str(absent))
    assert endpoint.status(OWNER, 'login_claude', live['flow_id'])['status'] == 'pending'
    assert endpoint.cancel(OWNER, 'login_claude', live['flow_id']) == expected
    assert endpoint.cancel(OWNER, 'login_claude', live['flow_id']) == expected

    # Expiration does not prevent the owner from clearing a retained live row.
    expired = endpoint.start(OWNER, 'login_claude')
    endpoint._flows[expired['flow_id']]['expires'] = time.monotonic() - 1
    assert endpoint.cancel(OWNER, 'login_claude', expired['flow_id']) == expected

    # Cancel still revokes a successfully imported session and retained runs.
    connected = endpoint.start(OWNER, 'login_claude')
    identity = 'fixture-identity'
    verified = {'identity': identity, 'credentials': {'organization': 'fixture-org'},
        'models': [{'id': 'web-default', 'name': 'Website default', 'model_capabilities': {}}]}
    with patch.object(registry, 'translation_supported', return_value=True), \
            patch.object(login_native, 'module', return_value=SimpleNamespace(endpoint_validate=lambda *args: verified)):
        result = endpoint.complete(OWNER, 'login_claude', connected['flow_id'], connected['state'],
            'fixture-browser', hashlib.sha256(identity.encode()).hexdigest(),
            {'organization': 'fixture-org'}, lambda: OWNER)
    session_id = result['session']['id']
    with patch.object(endpoint.runs, 'purge') as purge:
        assert endpoint.cancel(OWNER, 'login_claude', connected['flow_id']) == expected
        purge.assert_called_once_with(session_id)
    rejected(lambda: store.get(session_id, OWNER), 'login_session_expired')
    assert endpoint.cancel(OWNER, 'login_claude', connected['flow_id']) == expected

    # Exercise the real route handler without starting an asyncio socketpair.
    async def inline_call(action, *args):
        return action()
    def finish(coroutine):
        try:
            coroutine.send(None)
        except StopIteration as result:
            return result.value
        finally:
            coroutine.close()
        raise AssertionError('The route unexpectedly suspended')
    request = Request({'type': 'http', 'headers': [(b'authorization', b'Bearer fixture-tp-token')]})
    body = routes.CancelInput(flow_id=expired['flow_id'])
    with patch.object(routes, 'call', inline_call), patch.object(routes.diagnostic, 'emit'), \
            patch.object(routes.login_entitlement, 'authorize', return_value=OWNER) as authorize:
        assert finish(routes.cancel('login_claude', body, request)) == expected
        authorize.assert_called_once_with('fixture-tp-token')
    with patch.object(routes, 'call', inline_call), patch.object(routes.diagnostic, 'emit'), \
            patch.object(routes.login_entitlement, 'authorize', side_effect=LoginError('login_entitlement_required', 'Sign in.', 401)), \
            patch.object(endpoint, 'cancel') as cleanup:
        rejected(lambda: finish(routes.cancel('login_claude', body, request)), 'login_entitlement_required')
        cleanup.assert_not_called()

    # The cleanup ledger is bounded, expires and contains no provider secrets.
    for _ in range(endpoint.MAX_CLOSED + 3):
        row = endpoint.start(OWNER, 'login_claude')
        endpoint.cancel(OWNER, 'login_claude', row['flow_id'])
    assert len(endpoint._closed) <= endpoint.MAX_CLOSED
    assert all(set(row) == {'owner', 'provider', 'expires'} for row in endpoint._closed.values())
    last = row['flow_id']
    with patch.object(endpoint.time, 'monotonic', return_value=time.monotonic() + endpoint.CLOSED_TTL + 1):
        rejected(lambda: endpoint.cancel(OWNER, 'login_claude', last))
    assert not endpoint._closed
finally:
    endpoint.clear()
    store.clear()
print('PASS: failed/cancelled Login cleanup is idempotent, owner-bound and authorized')
