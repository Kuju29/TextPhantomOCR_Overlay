"""Lightweight provider/model connectivity probe for the settings UI.

Cloud providers may perform one tiny generation only when the popup explicitly
asks for selected-model verification. Local providers should prefer metadata-only
availability/capability checks so opening settings never loads a model into RAM.
Results are cached so reopening the popup does not repeatedly consume quota.
"""

from __future__ import annotations

from typing import Any, TypedDict

import httpx, time, hashlib, json
from concurrent.futures import Future, TimeoutError as FutureTimeout
from copy import deepcopy
from threading import Lock
from uuid import uuid4

# from backend.ai import providers as _provider_modules  # noqa: F401
from backend.ai.provider_contract import ProbeRequest
from backend.ai.provider_registry import provider_registry
from backend.ai.provider_resolution import (
    canonical_provider,
    detect_provider_from_key,
    provider_key_mismatch,
    resolve_base_url,
    resolve_model,
    discovered_model_capabilities,
    normalize_model_capabilities,
    remember_selected_model_capability,
    remember_model_promotion,
    remember_model_rejection,
    model_is_promoted,
    MODEL_PROBE_EVIDENCE_TTL_SEC,
)
from backend.ai.rate_policy import is_local_target
from backend.security import assert_ai_base_url_allowed

PROBE_TIMEOUT_SEC = 15.0
PROBE_CACHE_TTL_SEC = MODEL_PROBE_EVIDENCE_TTL_SEC
# A pass is a durable fact about this key and model. A failure is usually a
# snapshot of one bad moment - a 429, a dropped socket, a plan the user is
# fixing right now. Remembering both for fifteen minutes meant somebody who
# corrected the real problem kept being shown the stale failure and concluded
# the correction had not worked. The cache key is provider+model+base_url+key
# hash, so that stale answer also crossed browsers and machines.
PROBE_FAILURE_CACHE_TTL_SEC = 30
_PROBE_CACHE: dict[str, tuple[float, dict[str, Any], float]] = {}
_PROBE_INFLIGHT: dict[str, Future] = {}
_PROBE_LOCK = Lock()
PROBE_MAX_INFLIGHT = 256
PROBE_MAX_CACHE = 1024
# A follower cannot cancel/replace its owner. Its bounded wait covers the
# existing worst-case two native checks; it never starts a duplicate probe.
PROBE_FOLLOWER_WAIT_SEC = PROBE_TIMEOUT_SEC * 2 + 5

class ProbeResult(TypedDict, total=False):
    ok: bool
    provider: str
    model: str
    backend_supported: bool
    provider_protocol: str
    status: str
    http_status: int
    cached: bool
    error: str
    model_capabilities: dict[str, Any]
    error_details: dict[str, Any]
    probeId: str
    shared: bool

def _cache_key(provider: str, model: str, base_url: str, api_key: str) -> str:
    raw = json.dumps([provider, model, base_url, hashlib.sha256(api_key.encode()).hexdigest()],
                     ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()

def _classify_status(code: int, details: dict[str, Any] | None = None) -> str:
    if code == 402:
        return "billing_required"
    if code == 401:
        return "invalid_key"
    if code == 403:
        return "model_access_denied"
    if code == 404:
        return "model_unavailable"
    if code == 429:
        return "rate_limited"
    if code in {400, 422}:
        evidence = details or {}
        if any(str(evidence.get(key) or "").lower() in {
            "model_not_found", "model_unavailable", "unsupported_model",
        } for key in ("code", "type", "error_type", "provider_code", "provider_type")):
            return "model_unavailable"
        # A bad test parameter is not evidence that the catalogue model is gone.
        # Translation stays gated until a successful test, without demotion.
        return "request_rejected"
    if 400 <= code < 500:
        return "rejected"
    return "provider_error"

def probe(payload: dict[str, Any]) -> ProbeResult:
    supplied_key = str(payload.get("api_key") or "").strip()
    candidate_key = supplied_key
    provider = canonical_provider(str(payload.get("provider") or "auto"))
    base_hint = str(payload.get("base_url") or "").strip()
    looks_local = is_local_target(provider, base_hint)

    if provider in ("", "auto"):
        if candidate_key:
            provider = detect_provider_from_key(candidate_key)
            if not provider:
                return ProbeResult(
                    ok=False, provider="", model="", backend_supported=False,
                    provider_protocol="", status="ambiguous_provider",
                    http_status=0, cached=False,
                )
        elif looks_local:
            default_local = next((item for item in provider_registry if item.default_local), None)
            provider = default_local.provider_id if default_local else ""
        else:
            return ProbeResult(
                ok=False,
                provider="",
                model="",
                backend_supported=False,
                provider_protocol="",
                status="missing_api_key",
                http_status=0,
                cached=False,
            )

    spec = provider_registry.get(provider)
    protocol = spec.protocol if spec else ""
    backend_supported = bool(spec and spec.adapter and protocol)
    if not backend_supported:
        return ProbeResult(
            ok=False,
            provider=provider,
            model="",
            backend_supported=False,
            provider_protocol="",
            status="unsupported_provider",
            http_status=0,
            cached=False,
        )

    local = is_local_target(provider, base_hint)
    # Local providers never receive a cloud key.
    api_key = "" if local else supplied_key
    if not api_key and not local:
        return ProbeResult(
            ok=False,
            provider=provider,
            model="",
            backend_supported=True,
            provider_protocol=protocol,
            status="missing_api_key",
            http_status=0,
            cached=False,
        )
    mismatched_provider = provider_key_mismatch(provider, api_key) if not local else ""
    if mismatched_provider:
        return ProbeResult(
            ok=False, provider=provider, model="", backend_supported=True,
            provider_protocol=protocol, status="provider_key_mismatch",
            http_status=0, cached=False, error=f"key belongs to {mismatched_provider}",
        )

    model = resolve_model(provider, str(payload.get("model") or "auto"))
    base_url = resolve_base_url(provider, str(payload.get("base_url") or "auto"))
    assert_ai_base_url_allowed(provider, base_url, user_key=bool(api_key), key_present=bool(api_key))

    cache_key = _cache_key(provider, model, base_url, api_key)
    now = time.time()
    with _PROBE_LOCK:
        cached = _PROBE_CACHE.get(cache_key)
        if cached and now - cached[0] < cached[2] and (
            not cached[1].get("ok") or model_is_promoted(provider, base_url, api_key, model)
        ):
            out = deepcopy(cached[1])
            out["cached"] = True
            fresh, current = discovered_model_capabilities(provider, base_url, model, api_key)
            if out.get("ok") and fresh:
                out["model_capabilities"] = current
            return ProbeResult(**out)
        pending = _PROBE_INFLIGHT.get(cache_key)
        owner = pending is None
        if owner:
            if len(_PROBE_INFLIGHT) >= PROBE_MAX_INFLIGHT:
                return ProbeResult(ok=False, provider=provider, model=model,
                    backend_supported=True, provider_protocol=protocol,
                    status="probe_busy", http_status=0, cached=False)
            pending = Future()
            _PROBE_INFLIGHT[cache_key] = pending
    if not owner:
        try:
            out = deepcopy(pending.result(timeout=PROBE_FOLLOWER_WAIT_SEC))
        except FutureTimeout:
            return ProbeResult(ok=False, provider=provider, model=model,
                backend_supported=True, provider_protocol=protocol,
                status="probe_pending", http_status=0, cached=False, shared=True)
        out["shared"] = True
        return ProbeResult(**out)
    try:
        result = _execute_probe(spec, provider, protocol, model, base_url, api_key)
        ttl = PROBE_CACHE_TTL_SEC if result["ok"] else PROBE_FAILURE_CACHE_TTL_SEC
        with _PROBE_LOCK:
            completed = time.time()
            expired = [key for key, entry in _PROBE_CACHE.items() if completed - entry[0] >= entry[2]]
            for key in expired:
                del _PROBE_CACHE[key]
            if cache_key not in _PROBE_CACHE and len(_PROBE_CACHE) >= PROBE_MAX_CACHE:
                oldest = min(_PROBE_CACHE, key=lambda key: _PROBE_CACHE[key][0])
                del _PROBE_CACHE[oldest]
            _PROBE_CACHE[cache_key] = (completed, deepcopy(result), ttl)
        pending.set_result(deepcopy(result))
        return result
    except BaseException as exc:
        # All waiters see the same failure. Do not poison the identity forever
        # or turn a failed owner into an automatic retry by each follower.
        pending.set_exception(exc)
        raise
    finally:
        with _PROBE_LOCK:
            if _PROBE_INFLIGHT.get(cache_key) is pending:
                del _PROBE_INFLIGHT[cache_key]


def _execute_probe(spec, provider: str, protocol: str, model: str,
                   base_url: str, api_key: str) -> ProbeResult:
    probe_id = uuid4().hex
    # Reuse only capabilities learned from this exact provider/base/account
    # catalogue. This lets provider-owned probes suppress optional hidden
    # reasoning without guessing from model names.
    _, probe_capabilities = discovered_model_capabilities(
        provider, base_url, model, api_key
    )

    try:
        response = spec.adapter.probe(ProbeRequest(
            api_key=api_key, base_url=base_url, model=model,
            timeout_sec=PROBE_TIMEOUT_SEC,
            model_capabilities=probe_capabilities,
        ))
    except httpx.RequestError as exc:
        result = ProbeResult(
            ok=False,
            provider=provider,
            model=model,
            backend_supported=True,
            provider_protocol=protocol,
            status="unreachable",
            http_status=0,
            cached=False,
            error=type(exc).__name__,
        )
    else:
        verified_capabilities = normalize_model_capabilities(dict(response.capabilities or {}))
        effective_capabilities = verified_capabilities or normalize_model_capabilities(probe_capabilities)
        if verified_capabilities:
            remember_selected_model_capability(
                provider, base_url, api_key, model, verified_capabilities
            )
            effective_capabilities = discovered_model_capabilities(provider, base_url, model, api_key)[1]
        if response.ok:
            remember_model_promotion(provider, base_url, api_key, model)
            result = ProbeResult(
                ok=True,
                provider=provider,
                model=model,
                backend_supported=True,
                provider_protocol=protocol,
                status="passed",
                http_status=response.http_status,
                cached=False,
                **({"model_capabilities": effective_capabilities} if effective_capabilities else {}),
            )
        elif response.status:
            status = response.status
            if response.http_status == 402 or (status == "rejected" and response.http_status in {400, 422}):
                status = _classify_status(response.http_status, dict(response.error_details))
            result = ProbeResult(
                ok=False,
                provider=provider,
                model=model,
                backend_supported=True,
                provider_protocol=protocol,
                status=status,
                http_status=response.http_status,
                cached=False,
                error=response.error,
                **({"error_details": dict(response.error_details)} if response.error_details else {}),
            )
        else:
            result = ProbeResult(
                ok=False,
                provider=provider,
                model=model,
                backend_supported=True,
                provider_protocol=protocol,
                status=_classify_status(response.http_status, dict(response.error_details)),
                http_status=response.http_status,
                cached=False,
                # The provider said why. Dropping it left the settings panel
                # with a bare number and no way to act on it.
                error=response.error,
                **({"error_details": dict(response.error_details)} if response.error_details else {}),
            )

    if not result.get("ok") and str(result.get("status") or "") in {
        "rejected", "model_unavailable", "model_access_denied", "invalid_model_output", "unsupported_model",
    }:
        remember_model_rejection(
            provider, base_url, api_key, model,
            status=str(result.get("status") or "rejected"),
            http_status=int(result.get("http_status") or 0),
            error=str(result.get("error") or ""),
        )

    result["probeId"] = probe_id
    from backend import trace
    trace.note("model_probe_completed", {
        "provider": provider, "model": model, "probeId": probe_id,
        "endpointScope": hashlib.sha256(base_url.encode()).hexdigest()[:12],
        "status": result.get("status", "unknown"),
        **({"errorDetails": result["error_details"]} if result.get("error_details") else {}),
        "httpStatus": result.get("http_status", 0), "promoted": result.get("ok") is True,
        "demoted": (not result.get("ok") and str(result.get("status") or "") in {
            "rejected", "model_unavailable", "model_access_denied", "invalid_model_output", "unsupported_model"}),
        "capabilityReported": bool(result.get("model_capabilities")),
        "accountScope": hashlib.sha256(api_key.encode()).hexdigest()[:12],
    }, file="ai/probe.py")
    return result
