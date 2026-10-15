"""Replay Login endpoint HTTP failures without accounts, network, or secrets."""
import json
import sys
from pathlib import Path
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'api'))
from backend.ai.login.endpoint import login_endpoint_http as endpoint
from backend.ai.login import login_provider_deepseek as deepseek
from backend.ai.login import login_provider_chatgpt as chatgpt
from backend.ai.login import login_routes as routes, login_observability as diagnostic
from backend.ai.login.login_provider_contract import LoginError
from backend.diagnostics import writer
from starlette.requests import Request

real_client = httpx.Client


def replay(status, payload, content_type='application/json', headers=None, invoke=None):
    calls = []
    def handle(request):
        calls.append(request.url.path)
        return httpx.Response(status, content=payload, headers={'content-type': content_type, **(headers or {})})
    def client(**kwargs):
        return real_client(transport=httpx.MockTransport(handle), **kwargs)
    with patch.object(endpoint.httpx, 'Client', side_effect=client), \
            patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage'):
        try:
            with endpoint.EndpointHTTP('login_deepseek', {'Authorization': 'Bearer private-fixture-token'}) as http:
                (invoke or (lambda h: h.request('/api/v0/chat_session/create', method='POST', body={})))(http)
        except LoginError as error:
            assert len(calls) == 1, 'No automatic replay of a failed provider request'
            assert error.upstream_status == status
            assert not error.requestDispatched
            assert 'private-fixture-token' not in str(error)
            assert 'private-body-secret' not in str(error)
            return error
    raise AssertionError('Expected a typed endpoint failure')


# Current .36 logs show pre-dispatch HTTP200 then an unknown response.
# Malformed JSON is a protocol failure, not a no-response transport failure.
error = replay(200, b'{private-body-secret')
assert error.code == 'login_endpoint_response_invalid', error.code
assert error.endpoint_step == 'deepseek_session_create'
assert error.provider_reason == 'invalid_response'

# Preserve the exact failing protocol step even when JSON parsing succeeded.
error = replay(200, json.dumps({'code': 0, 'data': {'biz_code': 0, 'biz_data': {}}}).encode(),
    invoke=lambda http: deepseek.session_id(deepseek.business(http.request('/api/v0/chat_session/create', method='POST', body={}))))
assert error.code == 'login_endpoint_response_invalid'
assert error.endpoint_step == 'deepseek_session_create'
assert error.provider_reason == 'deepseek_session_id_missing'

# Explicit browser challenges remain actionable and never masquerade as a quota.
error = replay(403, b'<html>Just a moment private-body-secret</html>', 'text/html', {'cf-mitigated': 'challenge'})
assert error.code == 'login_endpoint_challenge_required'
assert error.status == 409
assert error.endpoint_step == 'deepseek_session_create'

# An ordinary access denial is distinct from transient server failure.
error = replay(403, b'{"error":"private-body-secret"}')
assert error.code == 'login_provider_access_denied'
assert error.status == 403

# The current native consumer adapter is implemented independently of OAuth.
# Available here means it can attempt normal Login, not a live generation pass.
assert chatgpt.PROVIDER.supported is True
assert callable(chatgpt.endpoint_validate) and callable(chatgpt.endpoint_generate)

# Exercise the actual generation call site: create failure stops before PoW/send.
calls = []
def failed_create(request):
    calls.append(request.url.path)
    return httpx.Response(200, json={'code': 0, 'data': {'biz_code': 0, 'biz_data': {}}})
with patch.object(endpoint.httpx, 'Client', side_effect=lambda **kw: real_client(transport=httpx.MockTransport(failed_create), **kw)), \
        patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage'):
    try:
        deepseek.endpoint_generate({'token': 'private-fixture-token'}, 'fixture prompt', {}, 'web-default', lambda: None, lambda: calls.append('dispatched'))
    except LoginError as failure:
        assert failure.provider_reason == 'deepseek_session_id_missing'
        assert failure.endpoint_step == 'deepseek_session_create'
        assert calls == ['/api/v0/chat_session/create']
    else:
        raise AssertionError('Unknown create-session payload must fail before dispatch')

# The existing adapter's supported fixture pattern still reaches a terminal reply.
session = 'fixture_conversation'
# Both consumer response variants are documented by original client maintainers:
# https://github.com/ForgetMeAI/FreeDeepseekAPI/blob/main/docs/api-documentation.md
# https://github.com/snake-aabb-wtf/deepseek-web2api-free/blob/main/adapter.py
assert deepseek.session_id({'id': session}) == session
assert deepseek.session_id({'chat_session': {'id': session}}) == session
assert deepseek.session_id({'id': session, 'chat_session': {'id': session}}) == session
for value in ({'id': 1}, {'id': 'https://private-body-secret.invalid/'},
        {'id': session, 'chat_session': {'id': 'another_conversation'}},
        {'id': session, 'chat_session': None}, {'id': None, 'chat_session': {'id': session}}):
    try:
        deepseek.session_id(value)
    except LoginError as failure:
        assert failure.code == 'login_endpoint_response_invalid'
        assert 'private-body-secret' not in str(failure)
    else:
        raise AssertionError('Malformed or conflicting conversation identity must be rejected')

# The documented legacy stream has bare readiness metadata and a FINISHED
# patch followed by a clean, fully framed EOF, rather than event: close.
def frame(value, event=''):
    return ((('event: ' + event + '\n') if event else '') + 'data: ' + json.dumps(value) + '\n\n').encode()
ready = frame({'request_message_id': 1, 'response_message_id': 2})
initial = frame({'v': {'response': {'message_id': 2, 'chat_session_id': session,
    'role': 'ASSISTANT', 'fragments': [], 'status': 'WIP'}}})
answer = frame({'p': 'response/fragments', 'o': 'APPEND', 'v': [{'type': 'RESPONSE', 'content': 'fixture '}]})
append = frame({'p': 'response/fragments/-1/content', 'o': 'APPEND', 'v': 'answer'})
finished = frame({'p': 'response/status', 'o': 'SET', 'v': 'FINISHED'})
legacy = ready + initial + answer + append + finished
assert deepseek.parse_reply(legacy, session) == ('fixture answer', 2)
# Some documented clients get the parent ID in the initial response object.
assert deepseek.parse_reply(initial + answer + append + finished, session) == ('fixture answer', 2)
for malformed in (legacy[:-1], ready + initial + answer + append,
        ready + initial + finished, ready + ready + initial + answer + finished,
        ready + initial.replace(b'"message_id": 2', b'"message_id": 3') + answer + finished,
        ready + initial.replace(session.encode(), b'another_conversation') + answer + finished,
        frame({'response_message_id': True}) + initial + answer + finished,
        frame({'response_message_id': 1}) + initial.replace(b'"message_id": 2', b'"message_id": true') + answer + finished,
        legacy + append, legacy + frame({'v': 'private-body-secret'}, 'unknown')):
    try:
        deepseek.parse_reply(malformed, session)
    except LoginError as failure:
        assert failure.code == 'login_endpoint_response_invalid'
        assert 'private-body-secret' not in str(failure)
    else:
        raise AssertionError('Incomplete, conflicting, or post-terminal stream must be rejected')
raw = ('event: ready\ndata: {"response_message_id":1}\n\n'
       'data: ' + json.dumps({'p': '', 'v': {'response': {'chat_session_id': session, 'message_id': 1,
           'role': 'ASSISTANT', 'status': 'FINISHED', 'fragments': [{'type': 'RESPONSE', 'content': 'fixture answer'}]}}}) + '\n\n'
       'event: close\ndata: {}\n\n').encode()
def success(request):
    calls.append(request.url.path)
    if request.url.path == '/api/v0/chat_session/create':
        return httpx.Response(200, json={'code': 0, 'data': {'biz_code': 0, 'biz_data': creation}})
    if request.url.path == '/api/v0/chat/create_pow_challenge':
        return httpx.Response(200, json={'code': 0, 'data': {'biz_code': 0, 'biz_data': {'challenge': {'fixture': True}}}})
    assert request.url.path == '/api/v0/chat/completion'
    return httpx.Response(200, content=sse_raw, headers={'content-type': 'text/event-stream'})
for creation, sse_raw, expected_parent in (
        ({'id': session}, raw, 1), ({'chat_session': {'id': session}}, raw, 1),
        ({'id': session}, legacy, 2), ({'chat_session': {'id': session}}, legacy, 2)):
    calls = []
    with patch.object(endpoint.httpx, 'Client', side_effect=lambda **kw: real_client(transport=httpx.MockTransport(success), **kw)), \
            patch.object(endpoint.diagnostic, 'emit'), patch.object(endpoint.diagnostic, 'stage'), patch.object(deepseek, 'proof', return_value='fixture-proof'):
        remote = {}
        result = deepseek.endpoint_generate({'token': 'private-fixture-token'}, 'fixture prompt', remote, 'web-default', lambda: None, lambda: calls.append('dispatched'))
        assert result['text'] == 'fixture answer' and result['completed'] is True
        assert remote == {'conversation': session, 'parent': expected_parent}
        assert calls == ['/api/v0/chat_session/create', '/api/v0/chat/create_pow_challenge', 'dispatched', '/api/v0/chat/completion']

# Only static route labels and allowlisted enums reach diagnostics or clients.
with patch.object(diagnostic.trace, 'write'), patch.object(writer, 'emit'), patch.object(diagnostic, 'log_event'):
    safe = diagnostic.emit('failed', error)
    assert safe['endpointStep'] == 'deepseek_session_create'
    error.endpoint_step = 'private-body-secret'
    error.provider_reason = 'private-body-secret'
    safe = diagnostic.emit('failed', error, endpointStep='private-fixture-token')
    assert 'private' not in json.dumps(safe)
    assert 'endpointStep' not in safe
    response = routes.failure_response(error)
    assert 'endpoint_step' not in json.loads(response.body)['error']
    assert 'private' not in response.body.decode()

for payload, reason in (({'code': 123, 'data': None}, 'deepseek_endpoint_rejected'),
        ({'code': 0, 'data': {'biz_code': 123, 'biz_data': None}}, 'deepseek_business_rejected')):
    rejected = replay(200, json.dumps(payload).encode(), invoke=lambda http: deepseek.business(http.request('/api/v0/chat_session/create', method='POST', body={})))
    assert rejected.code == 'login_endpoint_rejected' and rejected.status == 409
    assert rejected.provider_reason == reason

async def immediate(action):
    return action()

def resolve(coroutine):
    # This sandbox blocks Windows asyncio's local socketpair. Keep the route's
    # real coroutine/error logic but replace only worker dispatch with inline work.
    try:
        coroutine.send(None)
    except StopIteration as finished:
        return finished.value
    finally:
        coroutine.close()
    raise AssertionError('Fixture route unexpectedly needs asynchronous I/O')

with patch.object(routes.login_entitlement, 'authorize', return_value='fixture-owner'), patch.object(routes.store, 'owned', return_value=[]), patch.dict(routes.os.environ, {'TP_LOGIN_ENABLED_PROVIDERS': 'login_chatgpt'}), \
        patch.object(routes.asyncio, 'to_thread', immediate), patch.object(writer, 'emit'), patch.object(diagnostic.trace, 'write'), patch.object(diagnostic, 'log_event'):
    request = Request({'type': 'http', 'headers': []})
    catalogue = json.loads(resolve(routes.providers(request)).body)
    registered = next(row for row in catalogue['providers'] if row['id'] == 'login_chatgpt')
    assert registered['available'] is True and registered['reason'] is None
    assert 'setup_url' not in registered
    start = resolve(routes.start('login_chatgpt', request))
    assert start.status_code == 200
    started = json.loads(start.body)
    assert started['status'] == 'pending' and started['transport'] == 'web_endpoint'
    assert started['url'] == 'https://chatgpt.com/'
    assert 'client_id' not in started
    routes.web_session.clear()

assert endpoint.retry_after_ms('2.5') == 2500
assert endpoint.retry_after_ms('NaN') == 0
assert endpoint.retry_after_ms('99999999999') == 86400000
assert endpoint.retry_after_ms('1e308') == 86400000
assert endpoint.retry_after_ms('nonsense') == 0

print('PASS: Login HTTP200 failure replay, actual DeepSeek preflight/generation call paths, safe endpoint diagnostics, challenge/access denial, ChatGPT consumer transport availability')
