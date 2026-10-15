"""Browser relay: website requests leave from the customer's own browser tab.

The API's own HTTPS client gets a Cloudflare challenge, so the API hands one
fixed request to the same owner's extension, which sends it from the website's
own tab (carrying the website's cookies itself) and returns status and body.
Nothing here imitates a browser.

No cookie, token or session key is stored or forwarded by the API. A job is
only visible to the owner scope that created it, is claimed once, and expires.
"""
import contextvars
import secrets
import threading
import time
from contextlib import contextmanager

RELAY_PROVIDERS = frozenset({'login_claude', 'login_chatgpt_official', 'login_chatgpt_web'})
CLAIM_TIMEOUT = 15.0
JOB_TIMEOUT = 230.0
MAX_PENDING = 64
MAX_BODY_CHARS = 8 * 1024 * 1024
JOB_ID = 'lrj_'

scope_var = contextvars.ContextVar('tp_login_relay_scope', default='')
_lock = threading.Condition()
_jobs = {}


class RelayUnavailable(Exception):
    """No extension of this owner claimed the job in time."""


class RelayTimeout(Exception):
    """The extension claimed the job but did not report a result in time."""


@contextmanager
def owner(scope):
    token = scope_var.set(scope if isinstance(scope, str) else '')
    try:
        yield
    finally:
        scope_var.reset(token)


def clear():
    with _lock:
        for job in _jobs.values():
            job['cancelled'] = True
        _jobs.clear()
        _lock.notify_all()


def _prune(now):
    for key, job in list(_jobs.items()):
        if job['expires'] <= now:
            del _jobs[key]


def submit(job, check, *, claim_timeout=CLAIM_TIMEOUT, job_timeout=JOB_TIMEOUT):
    """Queue one request for the current owner's browser and wait for its result.

    `check` raises to cancel (run cancelled, owner changed, deadline). The
    caller turns RelayUnavailable/RelayTimeout into its own LoginError."""
    scope = scope_var.get()
    if not scope:
        raise RelayUnavailable()
    now = time.monotonic()
    job_id = JOB_ID + secrets.token_hex(24)
    row = {'id': job_id, 'scope': scope, 'job': dict(job, id=job_id), 'claimed': False,
           'result': None, 'cancelled': False, 'created': now,
           'claim_by': now + claim_timeout, 'expires': now + job_timeout}
    with _lock:
        _prune(now)
        if sum(1 for item in _jobs.values() if item['scope'] == scope) >= MAX_PENDING:
            raise RelayUnavailable()
        _jobs[job_id] = row
        _lock.notify_all()
    try:
        while True:
            check()
            with _lock:
                if row['result'] is not None:
                    return row['result'], round((time.monotonic() - row['created']) * 1000, 1)
                now = time.monotonic()
                if not row['claimed'] and now >= row['claim_by']:
                    raise RelayUnavailable()
                if now >= row['expires']:
                    raise RelayTimeout()
                _lock.wait(timeout=.1)
    finally:
        with _lock:
            row['cancelled'] = True
            _jobs.pop(job_id, None)
            _lock.notify_all()


def take(scope):
    """Non-blocking claim of the oldest unclaimed job of this owner."""
    now = time.monotonic()
    with _lock:
        _prune(now)
        waiting = [job for job in _jobs.values()
                   if job['scope'] == scope and not job['claimed'] and not job['cancelled']]
        if not waiting:
            return None
        job = min(waiting, key=lambda item: item['created'])
        job['claimed'] = True
        _lock.notify_all()
        # The time this job still has, so the extension answers (even with a
        # timeout reason) before the API stops waiting; late results are dropped.
        return dict(job['job'], expires_in_ms=max(0, int((job['expires'] - now) * 1000)))


def job_provider(scope, job_id):
    """Provider of a pending job of this owner ('' when unknown, late or foreign)."""
    with _lock:
        row = _jobs.get(job_id)
        return row['job'].get('provider', '') if row and row['scope'] == scope else ''


def complete(scope, job_id, result):
    """Accept one result from the owner that claimed the job. Late results are dropped."""
    with _lock:
        row = _jobs.get(job_id)
        if row is None or row['scope'] != scope or not row['claimed'] or row['cancelled'] or row['result'] is not None:
            return False
        row['result'] = result
        _lock.notify_all()
        return True
