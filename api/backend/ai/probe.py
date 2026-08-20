"""Lightweight provider/model connectivity probe for the settings UI.

This intentionally performs ONE tiny generation request only when the popup
explicitly asks for it (provider/model/key blur/change). Results are cached so
reopening the popup does not repeatedly consume quota. The probe uses the same
wire protocol as TextPhantom's translation clients, but a tiny prompt/output.
"""

from __future__ import annotations

import hashlib
import time
from typing import Any, TypedDict

import httpx

from backend.ai.clients.openai_compat import _uses_reasoning_safe_parameters
from backend.ai.config import PROVIDER_DEFAULTS, PROVIDER_PROTOCOLS
from backend.ai.providers import (
    canonical_provider,
    detect_provider_from_key,
    is_local_provider,
    provider_key_mismatch,
    resolve_base_url,
    resolve_model,
)
from backend.config import settings
from backend.security import assert_ai_base_url_allowed

PROBE_TIMEOUT_SEC = 15.0
PROBE_CACHE_TTL_SEC = 15 * 60
_PROBE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}


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


def _post(provider: str, api_key: str, base_url: str, model: str) -> httpx.Response:
    if provider == "gemini":
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        payload = {
            "contents": [{"role": "user", "parts": [{"text": "Reply only OK."}]}],
            "generationConfig": {"maxOutputTokens": 8},
        }
        with httpx.Client(timeout=PROBE_TIMEOUT_SEC) as client:
            return client.post(url, json=payload)

    if provider == "anthropic":
        url = "https://api.anthropic.com/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        payload = {
            "model": model,
            "max_tokens": 8,
            "messages": [{"role": "user", "content": "Reply only OK."}],
        }
        with httpx.Client(timeout=PROBE_TIMEOUT_SEC) as client:
            return client.post(url, headers=headers, json=payload)

    url = base_url.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply only OK."}],
    }
    if _uses_reasoning_safe_parameters(base_url, model):
        payload["max_completion_tokens"] = 8
    else:
        payload["max_tokens"] = 8
    with httpx.Client(timeout=PROBE_TIMEOUT_SEC) as client:
        return client.post(url, headers=headers, json=payload)


def probe(payload: dict[str, Any]) -> ProbeResult:
    supplied_key = str(payload.get("api_key") or "").strip()
    server_key = str(settings.ai_api_key or "").strip()
    candidate_key = supplied_key or server_key
    provider = canonical_provider(str(payload.get("provider") or "auto"))
    base_hint = str(payload.get("base_url") or "").strip().lower()
    looks_local = (
        is_local_provider(provider)
        or "localhost" in base_hint
        or "127.0.0.1" in base_hint
        or "0.0.0.0" in base_hint
    )

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
            provider = "ollama"
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

    protocol = str(PROVIDER_PROTOCOLS.get(provider) or "")
    backend_supported = bool(provider in PROVIDER_DEFAULTS and protocol)
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

    local = is_local_provider(provider)
    # A server-owned cloud key must never be sent to a caller-selected local
    # endpoint. Local providers need no real key.
    api_key = supplied_key or ("" if local else server_key)
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
    if local and not api_key:
        api_key = "local"

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
    assert_ai_base_url_allowed(provider, base_url, user_key=not uses_server_key)

    cache_key = _cache_key(provider, model, base_url, api_key)
    now = time.time()
    cached = _PROBE_CACHE.get(cache_key)
    if cached and now - cached[0] < PROBE_CACHE_TTL_SEC:
        out = dict(cached[1])
        out["cached"] = True
        return ProbeResult(**out)

    try:
        response = _post(provider, api_key, base_url, model)
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
        if response.is_success:
            result = ProbeResult(
                ok=True,
                provider=provider,
                model=model,
                backend_supported=True,
                provider_protocol=protocol,
                status="passed",
                http_status=response.status_code,
                cached=False,
            )
        else:
            result = ProbeResult(
                ok=False,
                provider=provider,
                model=model,
                backend_supported=True,
                provider_protocol=protocol,
                status=_classify_status(response.status_code),
                http_status=response.status_code,
                cached=False,
            )

    _PROBE_CACHE[cache_key] = (now, dict(result))
    return result
