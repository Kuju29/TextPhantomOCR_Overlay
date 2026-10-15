"""Offline ASGI tests for the .78 public long-poll passthrough /paid/support/wait."""
import asyncio, json, os, sys, time
from pathlib import Path
os.environ['TP_CENTER_URL'] = 'https://center.example'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.api.routes import paid

ORIGINAL = httpx.AsyncClient
requests = []; cases = []; delay = {'seconds': 0}


async def upstream(request):
    requests.append({'url': str(request.url), 'headers': dict(request.headers), 'timeout': request.extensions.get('timeout')})
    if request.url.path == '/api/customer/support/wait':
        if delay['seconds'] == 'hang':
            raise httpx.ReadTimeout('upstream silent', request=request)
        await asyncio.sleep(delay['seconds'])
        return httpx.Response(200, json={'changed': True, 'last_seq': 7, 'version': 1, 'state': {'thread': None}, 'items': []}, request=request)
    return httpx.Response(200, json={'enabled': True, 'max_file_mb': 5}, request=request)


def transport_client(*args, **kwargs):
    kwargs['transport'] = httpx.MockTransport(upstream)
    return ORIGINAL(*args, **kwargs)


paid.httpx.AsyncClient = transport_client
import backend.paid_center as center
center.httpx.AsyncClient = transport_client
app = FastAPI(); app.include_router(paid.router)
client = TestClient(app, raise_server_exceptions=False)
TOKEN = 'Bearer ' + 'a' * 64


def check(name, fn):
    try: fn(); cases.append({'name': name, 'passed': True})
    except Exception as exc: cases.append({'name': name, 'passed': False, 'error': repr(exc)})


def forwards_bounded_query():
    delay['seconds'] = 0
    r = client.get('/paid/support/wait?after=5&version=1700000000000&timeout=20', headers={'Authorization': TOKEN})
    assert r.status_code == 200 and r.json()['changed'] is True
    last = requests[-1]
    assert last['url'] == 'https://center.example/api/customer/support/wait?after=5&version=1700000000000&timeout=20'
    assert last['headers']['authorization'] == TOKEN
    assert last['timeout']['read'] >= 30, last['timeout']
    assert r.headers['cache-control'] == 'no-store'
check('Wait forwards only bounded cursors with the customer bearer and a long upstream timeout', forwards_bounded_query)


def rejects_out_of_bounds():
    count = len(requests)
    for query in ('timeout=26', 'after=-1', 'version=x'):
        assert client.get('/paid/support/wait?' + query, headers={'Authorization': TOKEN}).status_code == 422, query
    assert len(requests) == count
check('Out-of-bound wait parameters are rejected before Center', rejects_out_of_bounds)


def other_requests_not_blocked():
    async def run():
        delay['seconds'] = 1.5
        async with ORIGINAL(transport=httpx.ASGITransport(app=app), base_url='http://api.test') as local:
            waiting = asyncio.create_task(local.get('/paid/support/wait?timeout=25', headers={'Authorization': TOKEN}))
            await asyncio.sleep(0.2)
            started = time.monotonic()
            status = await local.get('/paid/support/status', headers={'Authorization': TOKEN})
            quick = time.monotonic() - started
            result = await waiting
        delay['seconds'] = 0
        return status.status_code, quick, result.status_code
    status, quick, waited = asyncio.run(run())
    assert status == 200 and waited == 200 and quick < 0.5, (status, quick, waited)
check('A pending wait never blocks other API requests on the same event loop', other_requests_not_blocked)


def saturated_slots():
    count = len(requests); taken = 0
    while paid._support_wait_slots.acquire(blocking=False): taken += 1
    try:
        r = client.get('/paid/support/wait', headers={'Authorization': TOKEN})
        assert r.status_code == 429 and r.json()['error']['code'] == 'SUPPORT_WAIT_BUSY' and r.headers['retry-after'] == '5'
        assert len(requests) == count
    finally:
        for _ in range(taken): paid._support_wait_slots.release()
    assert taken == 256
check('Saturated wait slots answer 429 immediately without Center work', saturated_slots)


def upstream_timeout():
    delay['seconds'] = 'hang'
    try:
        r = client.get('/paid/support/wait', headers={'Authorization': TOKEN})
        assert r.status_code == 503 and r.json()['error']['code'] == 'CENTER_UNAVAILABLE'
    finally:
        delay['seconds'] = 0
check('A silent Center becomes an explicit availability error', upstream_timeout)


def default_timeout_unchanged():
    client.get('/paid/support', headers={'Authorization': TOKEN})
    assert requests[-1]['timeout']['read'] == 15
check('Ordinary support reads keep the 15 s upstream timeout', default_timeout_unchanged)

summary = {'checks': len(cases), 'passed': sum(x['passed'] for x in cases), 'results': cases}
print(json.dumps(summary, indent=2)); raise SystemExit(0 if summary['passed'] == summary['checks'] else 1)
