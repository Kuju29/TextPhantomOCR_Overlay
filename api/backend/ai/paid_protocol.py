"""Check Paid wire compatibility once per Center, without reading customer balances."""
import threading
import time

import httpx
from backend import diagnostics
from backend.ai.center_http import center_client
from backend.ai.clients.provider_error import ProviderHttpError

PROTOCOL = "tp-paid-v2"
MIN_RELEASE = "2026.10.4.62"
# A Center that advertises this relays provider deltas as NDJSON. Older
# Centers reject the extra `stream` field, so it is only sent when advertised.
STREAM_PROTOCOL = "ndjson_v1"
_cache = {}
_locks = {}
_guard = threading.Lock()


def _center_lock(base):
    with _guard:
        return _locks.setdefault(base, threading.RLock())


def compatible(payload):
    if not isinstance(payload, dict) or payload.get("ok") is not True or payload.get("service") != "textphantom-control-center":
        return False
    protocol = payload.get("paid_protocol")
    # Centers predating capability advertisement shipped this exact contract.
    return protocol == PROTOCOL or (protocol is None and payload.get("release") == MIN_RELEASE)


def invalidate(base):
    with _center_lock(base):
        _cache.pop(base, None)


def require_protocol(base, model):
    # The configured Center is shared, but credentials and wallet state never
    # enter this cache. Single-flight only covers this short public health read.
    with _center_lock(base):
        current = _cache.get(base)
        if current and current[0] > time.monotonic():
            code, release = current[1:3]
        else:
            code, release, streams = "PAID_CENTER_UNAVAILABLE", "", False
            try:
                with center_client(httpx.Timeout(8, connect=4)) as client:
                    response = client.get(base + "/healthz", headers=diagnostics.headers())
                payload = response.json() if response.is_success else None
                if isinstance(payload, dict) and payload.get("service") == "textphantom-control-center":
                    value = payload.get("release")
                    release = value[:80] if isinstance(value, str) else ""
                    if payload.get("ok") is True:
                        code = "" if compatible(payload) else "PAID_CENTER_UPGRADE_REQUIRED"
                        streams = payload.get("paid_stream") == STREAM_PROTOCOL
            except (httpx.HTTPError, ValueError, TypeError):
                pass
            _cache[base] = (time.monotonic() + (300 if not code else 5), code, release, streams)
            diagnostics.emit("paid.center.compatibility", outcome="blocked" if code else "ready",
                             center_release=release, required_protocol=PROTOCOL,
                             error_code=code or None, provider_dispatched=False, credit_reserved=False)
    if code:
        error = ProviderHttpError("Paid Center wire contract is unavailable", provider="paid", model=model,
                                  status=503, provider_code=code)
        error.centerAdmissionRejected = True
        error.centerRequestDispatched = False
        error.requestDispatched = False
        error.providerAttempts = error.generationAttempts = 0
        raise error


def stream_supported(base):
    """True only when the last compatible /healthz advertised NDJSON relay."""
    with _center_lock(base):
        current = _cache.get(base)
    return bool(current and len(current) > 3 and not current[1] and current[3])
