"""Reuse Center TCP connections without sharing per-request headers or cookies."""
from contextlib import contextmanager
from threading import RLock
import atexit
import httpx

_lock = RLock()
_transport = None
_users = 0
_close_requested = False

class _BorrowedTransport(httpx.BaseTransport):
    def __init__(self, transport):
        self.transport = transport
    def handle_request(self, request):
        return self.transport.handle_request(request)
    def close(self):
        pass  # The application owns the connection pool.

@contextmanager
def center_client(timeout):
    global _transport, _users
    with _lock:
        if _transport is None:
            _transport = httpx.HTTPTransport(
                trust_env=False, retries=0,
                limits=httpx.Limits(max_connections=64, max_keepalive_connections=24, keepalive_expiry=30))
        transport = _transport
        _users += 1
    try:
        # A fresh facade owns its cookie jar; only the TCP pool is shared.
        with httpx.Client(transport=_BorrowedTransport(transport), timeout=timeout,
                          follow_redirects=False, trust_env=False) as client:
            yield client
    finally:
        retired = None
        with _lock:
            _users -= 1
            if _close_requested and not _users:
                retired, _transport = _transport, None
        if retired is not None:
            retired.close()

def close():
    global _transport, _close_requested
    retired = None
    with _lock:
        _close_requested = True
        if not _users:
            retired, _transport = _transport, None
    if retired is not None:
        retired.close()

atexit.register(close)
