"""Lightweight provider/model connectivity probe for the settings UI.

This intentionally performs ONE tiny generation request only when the popup
explicitly asks for it (provider/model/key blur/change). Results are cached so
reopening the popup does not repeatedly consume quota. The probe uses the same
wire protocol as TextPhantom's translation clients, but a tiny prompt/output.
"""

from __future__ import annotations

from typing import Any, TypedDict

import httpx, time, hashlib

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
)
from backend.ai.rate_policy import is_local_target
from backend.config import settings
from backend.security import assert_ai_base_url_allowed

PROBE_TIMEOUT_SEC = 15.0
PROBE_CACHE_TTL_SEC = 15 * 60
# A pass is a durable fact about this key and model. A failure is usually a
# snapshot of one bad moment - a 429, a dropped socket, a plan the user is
# fixing right now. Remembering both for fifteen minutes meant somebody who
# corrected the real problem kept being shown the stale failure and concluded
# the correction had not worked. The cache key is provider+model+base_url+key
# hash, so that stale answer also crossed browsers and machines.
PROBE_FAILURE_CACHE_TTL_SEC = 30
_PROBE_CACHE: dict[str, tuple[float, dict[str, Any], float]] = {}

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

def _cache_key(provider: str, model: str, base_url: str, api_key: str) -> str:
    raw = f"{provider}|{model}|{base_url}|{hashlib.sha256(api_key.encode()).hexdigest()}"
    return hashlib.sha256(raw.encode()).hexdigest()

def _classify_status(code: int) -> str:
    if code == 401:
        return "invalid_key"
    if code == 403:
        return "model_access_denied"
    if code == 404:
        return "model_unavailable"
    if code == 429:
        return "rate_limited"
    if 400 <= code < 500:
        return "rejected"
    return "provider_error"

def probe(payload: dict[str, Any]) -> ProbeResult:
    supplied_key = str(payload.get("api_key") or "").strip()
    server_key = str(settings.ai_api_key or "").strip()
    candidate_key = supplied_key or server_key
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
    # A server-owned cloud key must never be sent to a caller-selected local
    # endpoint. Local providers need no real key.
    api_key = "" if local else (supplied_key or server_key)
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
    # Same rule as resolve(): guard the endpoint only when the SERVER-OWNED key
    # is the credential that would actually leave this process.
    uses_server_key = bool(server_key) and not supplied_key and not local
    assert_ai_base_url_allowed(
        provider, base_url,
        user_key=not uses_server_key,
        key_present=bool(api_key),
    )

    cache_key = _cache_key(provider, model, base_url, api_key)
    now = time.time()
    cached = _PROBE_CACHE.get(cache_key)
    if cached and now - cached[0] < cached[2]:
        out = dict(cached[1])
        out["cached"] = True
        return ProbeResult(**out)

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
            result = ProbeResult(
                ok=False,
                provider=provider,
                model=model,
                backend_supported=True,
                provider_protocol=protocol,
                status=response.status,
                http_status=response.http_status,
                cached=False,
                error=response.error,
            )
        else:
            result = ProbeResult(
                ok=False,
                provider=provider,
                model=model,
                backend_supported=True,
                provider_protocol=protocol,
                status=_classify_status(response.http_status),
                http_status=response.http_status,
                cached=False,
                # The provider said why. Dropping it left the settings panel
                # with a bare number and no way to act on it.
                error=response.error,
            )

    ttl = PROBE_CACHE_TTL_SEC if result["ok"] else PROBE_FAILURE_CACHE_TTL_SEC
    _PROBE_CACHE[cache_key] = (now, dict(result), ttl)
    from backend import trace
    trace.note("model_probe_completed", {
        "provider": provider, "status": result.get("status", "unknown"),
        "httpStatus": result.get("http_status", 0), "promoted": result.get("ok") is True,
        "capabilityReported": bool(result.get("model_capabilities")),
        "accountScope": hashlib.sha256(api_key.encode()).hexdigest()[:12],
    }, file="ai/probe.py")
    return result
