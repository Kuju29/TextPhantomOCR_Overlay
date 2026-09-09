"""Provider-neutral identity, defaults and account-scoped capability cache."""
from __future__ import annotations

from typing import Any

import time, re, hashlib

# from backend.ai import providers as _provider_modules  # noqa: F401
from backend.ai.provider_registry import provider_registry

LIST_TIMEOUT_SEC = 10.0
LOCAL_LIST_TIMEOUT_SEC = 3.0
_MODEL_CAPABILITIES: dict[tuple[str, str, str], dict[str, Any]] = {}
_MODEL_CAPABILITIES_TTL_SEC = 300.0
_SECRET_PATTERN = re.compile(r"Bearer\s+[A-Za-z0-9._\-]{8,}|(?:key=|sk-|hf_|gsk_)[A-Za-z0-9._\-]{8,}")

def canonical_provider(provider: str) -> str:
    value = str(provider or "").strip().lower()
    return provider_registry.resolve_id(value) or value

def detect_provider_from_key(api_key: str) -> str:
    key = str(api_key or "").strip()
    matches = [spec.provider_id for spec in provider_registry
               if any(key.startswith(prefix) for prefix in spec.key_prefixes)]
    return matches[0] if len(matches) == 1 else ""

def provider_key_mismatch(provider: str, api_key: str) -> str:
    selected = canonical_provider(provider)
    detected = detect_provider_from_key(api_key)
    return detected if detected and selected and selected not in ("auto", detected) else ""

def is_local_provider(provider: str) -> bool:
    spec = provider_registry.get(provider)
    return bool(spec and spec.local)

def default_local_provider() -> str:
    defaults = [spec.provider_id for spec in provider_registry if spec.local and spec.default_local]
    if len(defaults) != 1:
        raise RuntimeError("provider registry requires exactly one default local provider")
    return defaults[0]

def resolve_provider(provider: str, api_key: str) -> str:
    resolved = canonical_provider(provider or "auto")
    return detect_provider_from_key(api_key) if resolved in ("", "auto") else resolved

def resolve_model(provider: str, model: str) -> str:
    spec = provider_registry.get(provider)
    requested = str(model or "").strip()
    if not requested or requested.lower() == "auto":
        fallback = provider_registry.get("openai")
        return spec.default_model if spec else (fallback.default_model if fallback else "")
    return str((spec.model_aliases if spec else {}).get(requested.lower(), requested))

def resolve_base_url(provider: str, base_url: str) -> str:
    spec = provider_registry.get(provider)
    requested = str(base_url or "").strip()
    # Named cloud providers are endpoint-bound. A leftover URL from another
    # provider must never redirect this provider's API key to the wrong host.
    # Local/self-hosted providers retain their explicit endpoint contract.
    if spec and not spec.local:
        return spec.default_base_url
    if requested and requested != "auto":
        return requested
    if spec:
        return spec.default_base_url
    fallback = provider_registry.get("openai")
    return fallback.default_base_url if fallback else ""

def normalize_model_capabilities(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    reasoning = value.get("reasoning") if isinstance(value.get("reasoning"), dict) else {}
    normalized = {key: reasoning[key] for key in
                  ("supported", "mandatory", "default_enabled", "supports_max_tokens", "dynamic")
                  if isinstance(reasoning.get(key), bool)}
    control = reasoning.get("control")
    if isinstance(control, str) and control in {"toggle", "boolean", "levels", "provider"}:
        normalized["control"] = control
    efforts = reasoning.get("supported_efforts")
    if isinstance(efforts, list):
        clean = [x.strip().lower() for x in efforts if isinstance(x, str) and re.fullmatch(r"[a-z0-9_-]{1,32}", x.strip().lower())]
        if clean:
            normalized["supported_efforts"] = list(dict.fromkeys(clean))
    if normalized.get("mandatory"):
        normalized["supported"] = True
    result: dict[str, Any] = {"reasoning": normalized} if normalized else {}
    structured = value.get("structured_output")
    if isinstance(structured, dict) and isinstance(structured.get("supported"), bool):
        result["structured_output"] = {"supported": structured["supported"]}
    from backend.ai.workload import normalize_limits
    limits = normalize_limits(value.get("limits"))
    if limits:
        result["limits"] = limits
    return result

def remember_model_capabilities(provider: str, base_url: str, api_key: str,
                                capabilities: dict[str, dict[str, Any]]) -> None:
    scope = (canonical_provider(provider), str(base_url or "").rstrip("/"),
             hashlib.sha256(str(api_key or "").encode()).hexdigest())
    _MODEL_CAPABILITIES[scope] = {"expires_at": time.monotonic() + _MODEL_CAPABILITIES_TTL_SEC,
                                  "models": dict(capabilities or {})}

def remember_selected_model_capability(provider: str, base_url: str, api_key: str,
                                      model: str, capability: dict[str, Any]) -> None:
    scope = (canonical_provider(provider), str(base_url or "").rstrip("/"),
             hashlib.sha256(str(api_key or "").encode()).hexdigest())
    now = time.monotonic()
    cached = _MODEL_CAPABILITIES.get(scope)
    models = dict(cached.get("models") or {}) if cached and cached.get("expires_at", 0) > now else {}
    normalized = normalize_model_capabilities(capability)
    if normalized:
        models[str(model)] = normalized
    _MODEL_CAPABILITIES[scope] = {
        "expires_at": now + _MODEL_CAPABILITIES_TTL_SEC,
        "models": models,
    }

def forget_model_capabilities(provider: str, base_url: str, api_key: str) -> None:
    scope = (canonical_provider(provider), str(base_url or "").rstrip("/"),
             hashlib.sha256(str(api_key or "").encode()).hexdigest())
    _MODEL_CAPABILITIES.pop(scope, None)

def discovered_model_capabilities(provider: str, base_url: str, model: str,
                                  api_key: str = "") -> tuple[bool, dict[str, Any]]:
    scope = (canonical_provider(provider), str(base_url or "").rstrip("/"),
             hashlib.sha256(str(api_key or "").encode()).hexdigest())
    cached = _MODEL_CAPABILITIES.get(scope)
    if not cached or cached["expires_at"] <= time.monotonic():
        _MODEL_CAPABILITIES.pop(scope, None)
        return False, {}
    return True, dict(cached["models"].get(model) or {"reasoning": {}})

def model_capabilities(provider: str, base_url: str, model: str, api_key: str = "") -> dict[str, Any]:
    return discovered_model_capabilities(provider, base_url, model, api_key)[1]

def openai_compat_models_status(api_key: str, base_url: str, *, provider: str,
                                timeout_sec: float = LIST_TIMEOUT_SEC) -> dict[str, Any]:
    """Compatibility-free registry model discovery retained as a public API."""
    del timeout_sec
    spec = provider_registry.require(provider)
    result = spec.adapter.list_models(api_key=api_key, base_url=base_url)
    capabilities = dict(result.capabilities)
    if result.status == "valid":
        remember_model_capabilities(spec.provider_id, base_url, api_key, capabilities)
    else:
        forget_model_capabilities(spec.provider_id, base_url, api_key)
    return {"models": list(result.models), "status": result.status,
            "http_status": result.http_status, "error": result.error,
            "capabilities": capabilities}

# def _safe_error_text(response) -> str:
#     try:
#         text = response.text or ""
#     except Exception:
#         return "<error body could not be read>"
#     return _SECRET_PATTERN.sub("[redacted]", " ".join(text.split()))[:240]
