""".75 test helper: run browser-relay jobs against an httpx MockTransport handler.

The real extension sends each job from the website's own tab. Tests replace
that tab with the same fictional upstream handler the HTTPS tests use, so the
protocol, status and error assertions stay identical. Every request is also
checked to carry no credential the API could have added: the browser tab owns
the website session, never the API.
"""
import base64
import json
from contextlib import contextmanager
from unittest.mock import patch

import httpx

from backend.ai.login.endpoint import login_browser_relay as relay
from backend.ai.login.endpoint import login_endpoint_http as endpoint

FORBIDDEN = ('cookie', 'authorization', 'x-api-key')


def to_request(job):
    origin = endpoint.ORIGINS[job['provider']]
    headers = {'accept': job.get('accept', 'application/json')}
    if 'json' in job:
        return httpx.Request(job['method'], origin + job['path'], json=job['json'], headers=headers)
    if 'multipart' in job:
        part = job['multipart']['file']
        return httpx.Request(job['method'], origin + job['path'], data=job['multipart']['fields'], headers=headers,
                             files={part['field']: (part['name'], base64.b64decode(part['base64']), part['mime'])})
    return httpx.Request(job['method'], origin + job['path'], headers=headers)


@contextmanager
def relay_via(handler, jobs=None):
    """Patch relay.submit so each job is answered by `handler(httpx.Request)`."""
    def submit(job, check, **_):
        check()
        json.dumps(job)  # a job must be plain JSON for the extension
        if jobs is not None:
            jobs.append(job)
        request = to_request(job)
        request.read()
        assert not any(name in request.headers for name in FORBIDDEN), 'relay job carried a credential'
        response = handler(request)
        if isinstance(response, dict):
            return response, 0.0
        body = response.read() if hasattr(response, 'read') else response.content
        return {'status': response.status_code, 'content_type': response.headers.get('content-type', ''),
                'headers': {k: v for k, v in response.headers.items() if k.lower() in ('cf-mitigated', 'retry-after')},
                'body': body.decode('utf-8')}, 0.0
    with patch.object(relay, 'submit', side_effect=submit):
        yield
