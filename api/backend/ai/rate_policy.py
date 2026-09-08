"""Shared request policy for optional manual AI request pacing.

TextPhantom does not guess a provider's quota.  Pacing is active only when a
caller explicitly enables a positive RPM cap.  Local runtimes always bypass
the time/RPM gate; admission control still limits server resource usage.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

import ipaddress

from backend.ai.provider_bootstrap import ensure_provider_registry
from backend.ai.provider_registry import provider_registry

def _explicit_true(value: Any) -> bool:
    if value is True:
        return True
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False

def _number(value: Any) -> float:
    try:
        return max(0.0, float(value or 0.0))
    except (TypeError, ValueError):
        return 0.0

def is_local_target(provider: str, base_url: str = "") -> bool:
    """Recognise named local providers and explicit loopback endpoints.

    ``0.0.0.0`` and ``::`` are bind addresses, not loopback destinations, so
    URL-based detection deliberately rejects them.  A named local provider is
    still local regardless of its configured URL.
    """
    normalized_provider = str(provider or "").strip().lower()
    spec = provider_registry.get(normalized_provider)
    if spec is None:
        # Classification is also used by lightweight consumers that do not
        # pass through the application composition root (queue timeout policy,
        # failure metadata, probes, and standalone tests).  Populate a missing
        # declaration here so correctness never depends on import order, while
        # leaving already-resolved or injected registry entries untouched.
        ensure_provider_registry(provider_registry)
        spec = provider_registry.get(normalized_provider)
    if spec is not None and spec.local:
        return True
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

def manual_rate_policy(
    payload: dict[str, Any], *, provider: str, base_url: str = ""
) -> dict[str, Any]:
    """Return the one pacing policy shared by both Python AI entry paths."""
    raw = payload.get("rate") if isinstance(payload.get("rate"), dict) else {}
    rpm = _number(raw.get("rpm"))
    burst = int(_number(raw.get("burst")))
    local = is_local_target(provider, base_url)
    requested = _explicit_true(raw.get("enabled")) and rpm > 0
    enabled = requested and not local
    if local:
        reason = "local_provider_bypass"
    elif enabled:
        reason = "manual_cap"
    elif _explicit_true(raw.get("enabled")):
        reason = "manual_cap_requires_positive_rpm"
    else:
        reason = "provider_managed"
    return {
        "enabled": enabled,
        "rpm": rpm,
        "burst": burst,
        "local": local,
        "mode": reason,
    }
