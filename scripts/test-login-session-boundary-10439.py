"""Regress own-session availability and explicit HTTP protection classification."""
from pathlib import Path
import sys
from unittest.mock import patch
import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
from backend.ai.login import login_provider_chatgpt as chatgpt
from backend.ai.login.endpoint import login_endpoint_http as endpoint
from backend.ai.login.login_provider_contract import LoginError
sys.path.insert(0, str(ROOT / 'scripts'))
from login_relay_fixture import relay_via

real_client = httpx.Client


def rejected(body, headers):
    requests = []
    def handle(request):
        requests.append(request.url.path)
        return httpx.Response(403, content=body, headers=headers)
    with patch.object(endpoint.httpx, 'Client', side_effect=lambda **kw:
            real_client(transport=httpx.MockTransport(handle), **kw)), \
            patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage'), relay_via(handle):
        # .75: claude.ai answers through the browser relay; classification is unchanged.
        try:
            with endpoint.EndpointHTTP('login_claude', {}) as http:
                http.request('/api/bootstrap')
        except LoginError as error:
            assert requests == ['/api/bootstrap'], 'An access failure must not replay'
            assert error.upstream_status == 403
            assert error.endpoint_step == 'claude_identity'
            assert error.requestDispatched is False
            assert 'private-fixture' not in str(error)
            assert 'private-body' not in str(error)
            return error
    raise AssertionError('A rejected session must not be accepted')


# A commercial OAuth integration is an alternative, not the prerequisite for
# the browser-session consumer transport requested by this application.
assert chatgpt.PROVIDER.supported is True
assert callable(chatgpt.endpoint_validate) and callable(chatgpt.endpoint_generate)
assert chatgpt.PROVIDER.channel == 'web_endpoint'

# HTML and a status code alone do not establish that browser proof was requested.
ordinary = rejected(b'<html>Forbidden private-body</html>', {'content-type': 'text/html'})
assert ordinary.code == 'login_provider_access_denied', ordinary.code
explicit = rejected(b'<html>private-body</html>',
    {'content-type': 'text/html', 'cf-mitigated': 'challenge'})
assert explicit.code == 'login_endpoint_challenge_required'
marker = rejected(b'<html><script src="/cdn-cgi/challenge-platform/fixture.js"></script></html>',
    {'content-type': 'text/html'})
assert marker.code == 'login_endpoint_challenge_required'
title = rejected(b'<html><title>Just a moment...</title></html>', {'content-type': 'text/html'})
assert title.code == 'login_endpoint_challenge_required'
print('PASS: own-session reason and explicit challenge/access denial classification')
