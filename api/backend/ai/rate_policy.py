"""Shared request policy for optional manual AI request pacing.

TextPhantom does not guess a provider's quota. Pacing is active only when a
caller explicitly enables a positive RPM cap. Local capacity remains separate
from this optional request pacing.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

import ipaddress
import math

from backend.ai.provider_bootstrap import ensure_provider_registry
from backend.ai.provider_registry import provider_registry

class InvalidManualRatePolicy(ValueError):
    code = "invalid_manual_rate_cap"

def _explicit_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    raise InvalidManualRatePolicy("Manual AI request cap enabled must be a boolean")

def _number(value: Any) -> float:
    try:
        number = float(value or 0.0)
        return number if math.isfinite(number) and number > 0.0 else 0.0
    except (TypeError, ValueError):
        return 0.0

def is_local_target(provider: str, base_url: str = "") -> bool:
    """Recognise named local providers and explicit loopback endpoints.

    ``0.0.0.0`` and ``::`` are bind addresses, not loopback destinations, so
    URL-based detection deliberately rejects them.  A named local provider is
    still local regardless of its configured URL.
    """
    normalized_provider = str(provider or "").strip().lower()
    if normalized_provider == "paid":
        return False  # The Center may be loopback; the AI still runs in the cloud.
    spec = provider_registry.get(normalized_provider)
    if spec is None:
        # Classification is also used by lightweight consumers that do not
        # pass through the application composition root (queue timeout policy,
        # failure metadata, probes, and standalone tests).  Populate a missing
        # declaration here so correctness never depends on import order, while
        # leaving already-resolved or injected registry entries untouched.
        ensure_provider_registry(provider_registry)
        spec = provider_registry.get(normalized_provider)
    if spec is not None:
        # A selected provider is authoritative.  A stale localhost URL must
        # never turn a named Cloud provider into an unauthenticated Local run.
        return bool(spec.local)
    raw_url = str(base_url or "").strip()
    if not raw_url:
        return False
    try:
        hostname = (urlsplit(raw_url).hostname or "").rstrip(".").lower()
    except ValueError:
        return False
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False

def cloud_local_endpoint_conflict(provider: str, base_url: str = "") -> bool:
    """Flag a named Cloud provider paired with a Local URL before routing it."""
    normalized = str(provider or "").strip().lower()
    ensure_provider_registry(provider_registry)
    spec = provider_registry.get(normalized)
    return bool(spec and not spec.local and normalized != "paid"
                and is_local_target("auto", base_url))

def manual_rate_policy(
    payload: dict[str, Any], *, provider: str, base_url: str = ""
) -> dict[str, Any]:
    """Return the one pacing policy shared by both Python AI entry paths."""
    rate_value = payload.get("rate")
    if rate_value is not None and not isinstance(rate_value, dict):
        raise InvalidManualRatePolicy("Manual AI request cap must be an object")
    raw = rate_value or {}
    if raw and "enabled" not in raw:
        raise InvalidManualRatePolicy("Manual AI request cap enabled is required")
    rpm = _number(raw.get("rpm"))
    burst = int(_number(raw.get("burst")))
    local = is_local_target(provider, base_url)
    selected = _explicit_bool(raw["enabled"]) if "enabled" in raw else False
    if selected and (rpm <= 0 or burst <= 0):
        raise InvalidManualRatePolicy("Manual AI request cap requires a positive RPM and burst")
    requested = selected
    enabled = requested
    if enabled:
        reason = "manual_local_cap" if local else "manual_cap"
    else:
        reason = "provider_managed"
    return {
        "enabled": enabled,
        "rpm": rpm,
        "burst": burst,
        "local": local,
        "mode": reason,
    }

def rate_bucket_identity(rate: dict[str, Any], *, base_url: str = "", api_key: str = "") -> str:
    """Keep Local manual policies distinct for separate endpoints and settings.

    Cloud budgets are still keyed by the actual API key. A Local runtime has
    no key, so sharing only (provider, model, empty key) would let one user's
    RPM setting silently overwrite another's on a shared API server.
    """
    if rate.get("local"):
        endpoint = str(base_url or "").strip().rstrip("/").lower()
        return f"endpoint:{endpoint}|rpm:{float(rate.get('rpm') or 0):g}|burst:{int(rate.get('burst') or 0)}"
    return api_key
