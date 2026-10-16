"""Shared test fake for the Center's public /healthz Paid protocol check.

Since the Paid adapter checks wire compatibility (GET {center}/healthz,
backend/ai/paid_protocol.require_protocol) before every first Paid call to a
Center, a synthetic Center must answer that read too. Use one of:

- ``HealthzClient``: base class for duck-typed ``httpx.Client`` fakes. It answers
  GET /healthz with the current protocol and hands every other GET to
  ``get_other()`` (which fails loudly unless the fake overrides it).
- ``with_healthz(handler)``: wraps an ``httpx.MockTransport`` handler.
- ``healthz_response(url)``: the response itself, for hand-written fakes.

``reset_protocol_cache()`` forgets earlier answers (the product caches them per
Center for 300 s), so each test sees its own fake Center.

backend modules are imported lazily: tests set TP_* variables before the API
configuration is first imported.
"""
import httpx


def _protocol():
    from backend.ai import paid_protocol
    return paid_protocol


def healthz_payload(*, stream=False):
    """The body a current Center returns (no customer data)."""
    protocol = _protocol()
    payload = {"ok": True, "service": "textphantom-control-center",
               "paid_protocol": protocol.PROTOCOL, "release": "qa-fixture"}
    if stream:
        payload["paid_stream"] = protocol.STREAM_PROTOCOL
    return payload


def is_healthz(url):
    return httpx.URL(str(url)).path.rstrip("/").endswith("/healthz")


def healthz_response(url="https://center.invalid/healthz", *, stream=False):
    return httpx.Response(200, json=healthz_payload(stream=stream),
                          request=httpx.Request("GET", str(url)))


def reset_protocol_cache():
    protocol = _protocol()
    with protocol._guard:
        protocol._cache.clear()


class HealthzClient:
    """Duck-typed httpx.Client fake that knows the Center health read."""
    healthz_stream = False
    healthz_calls = 0

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def close(self):
        pass

    def get(self, url, *args, **kwargs):
        if is_healthz(url):
            type(self).healthz_calls += 1
            return healthz_response(url, stream=self.healthz_stream)
        return self.get_other(url, *args, **kwargs)

    def get_other(self, url, *args, **kwargs):
        raise AssertionError(f"unexpected GET {url}")


def with_healthz(handler, *, stream=False):
    """MockTransport handler that answers GET /healthz, else calls ``handler``."""
    def wrapped(request):
        if request.method == "GET" and is_healthz(request.url):
            return healthz_response(request.url, stream=stream)
        return handler(request)
    return wrapped
