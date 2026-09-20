"""Provider-neutral identity, defaults and account-scoped capability cache."""
from __future__ import annotations

from typing import Any
from copy import deepcopy
from functools import wraps
from threading import RLock

import time, re, hashlib

# from backend.ai import providers as _provider_modules  # noqa: F401
from backend.ai.provider_registry import provider_registry

LIST_TIMEOUT_SEC = 10.0
LOCAL_LIST_TIMEOUT_SEC = 3.0
_MODEL_CAPABILITIES: dict[tuple[str, str, str], dict[str, Any]] = {}
_MODEL_CAPABILITIES_TTL_SEC = 300.0
_CAPABILITY_CACHE_LOCK = RLock()

def _capability_cache_transaction(function):
    # Metadata only. No network call or generation is inside this short lock.
    @wraps(function)
    def guarded(*args, **kwargs):
        with _CAPABILITY_CACHE_LOCK:
            return function(*args, **kwargs)
    return guarded

_MODEL_PROMOTIONS: dict[tuple[str, str, str], dict[str, float]] = {}
_MODEL_REJECTIONS: dict[tuple[str, str, str], dict[str, dict[str, Any]]] = {}
MODEL_PROBE_EVIDENCE_TTL_SEC = 15 * 60.0
_MODEL_PROMOTION_TTL_SEC = MODEL_PROBE_EVIDENCE_TTL_SEC
_MODEL_REJECTION_TTL_SEC = MODEL_PROBE_EVIDENCE_TTL_SEC
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
                  ("supported", "mandatory", "default_enabled", "supports_max_tokens", "dynamic", "can_disable")
                  if isinstance(reasoning.get(key), bool)}
    control = reasoning.get("control")
    if isinstance(control, str) and control in {"toggle", "boolean", "levels", "provider"}:
        normalized["control"] = control
    efforts = reasoning.get("supported_efforts")
    if isinstance(efforts, list):
        clean = [x.strip().lower() for x in efforts if isinstance(x, str) and re.fullmatch(r"[a-z0-9_-]{1,32}", x.strip().lower())]
        if clean:
            normalized["supported_efforts"] = list(dict.fromkeys(clean))
    for field in ("default_effort",):
        raw = reasoning.get(field)
        if isinstance(raw, str) and re.fullmatch(r"[a-z0-9_-]{1,32}", raw.strip().lower()):
            normalized[field] = raw.strip().lower()
    if normalized.get("mandatory"):
        normalized["supported"] = True
    result: dict[str, Any] = {"reasoning": normalized} if normalized else {}
    vision = value.get("vision")
    if isinstance(vision, dict) and isinstance(vision.get("supported"), bool):
        normalized_vision: dict[str, Any] = {"supported": vision["supported"]}
        if isinstance(vision.get("source"), str):
            normalized_vision["source"] = vision["source"][:200]
        result["vision"] = normalized_vision
    structured = value.get("structured_output")
    if isinstance(structured, dict) and isinstance(structured.get("supported"), bool):
        result["structured_output"] = {"supported": structured["supported"]}
    routing = value.get("routing")
    if isinstance(routing, dict):
        provider = str(routing.get("preferred_provider") or "").strip().lower()
        if re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", provider):
            result["routing"] = {"preferred_provider": provider,
                "source": str(routing.get("source") or "")[:120]}
    from backend.ai.workload import normalize_limits
    limits = normalize_limits(value.get("limits"))
    if limits:
        result["limits"] = limits
    return result

def effective_model_capabilities(*, discovery_fresh: bool,
                                 server: Any, client: Any) -> dict[str, Any]:
    """Prefer the current account catalogue; use the verified client snapshot only as fallback."""
    return normalize_model_capabilities(server if discovery_fresh else client)

def _capability_scope(provider: str, base_url: str, api_key: str) -> tuple[str, str, str]:
    return (canonical_provider(provider), str(base_url or "").rstrip("/"),
            hashlib.sha256(str(api_key or "").encode()).hexdigest())


@_capability_cache_transaction
def remember_model_capabilities(provider: str, base_url: str, api_key: str,
                                capabilities: dict[str, dict[str, Any]], *,
                                models: list[str] | tuple[str, ...] | None = None) -> None:
    """Refresh catalogue facts without erasing unexpired selected-model evidence.

    Missing metadata is unknown, not an explicit negative. A newer conflicting
    fact or a removed model invalidates older probe evidence. Catalogue refreshes
    never extend the probe's own expiry.
    """
    scope, now = _capability_scope(provider, base_url, api_key), time.monotonic()
    known = set(str(model) for model in (models if models is not None else capabilities))
    catalogue = {str(model): normalize_model_capabilities(value)
                 for model, value in capabilities.items() if str(model) in known}
    selected = {}
    for model, entry in (_MODEL_CAPABILITIES.get(scope, {}).get("selected") or {}).items():
        if model not in known or entry.get("expires_at", 0) <= now:
            continue
        evidence = deepcopy(entry.get("capabilities") or {})
        for feature, fresh in catalogue.get(model, {}).items():
            old = evidence.get(feature, {})
            if isinstance(old, dict) and any(key in old and old[key] != value
                                            for key, value in fresh.items()):
                evidence.pop(feature, None)
        if evidence:
            selected[model] = {**entry, "capabilities": evidence}
    _MODEL_CAPABILITIES[scope] = {
        "expires_at": now + _MODEL_CAPABILITIES_TTL_SEC,
        "models": catalogue, "selected": selected, "known_models": known,
    }

@_capability_cache_transaction
def remember_model_promotion(provider: str, base_url: str, api_key: str, model: str) -> None:
    scope = _capability_scope(provider, base_url, api_key)
    now = time.monotonic()
    promoted = {key: expiry for key, expiry in _MODEL_PROMOTIONS.get(scope, {}).items()
                if expiry > now}
    promoted[str(model)] = now + _MODEL_PROMOTION_TTL_SEC
    _MODEL_PROMOTIONS[scope] = promoted
    rejected = {key: value for key, value in _MODEL_REJECTIONS.get(scope, {}).items()
                if key != str(model) and value.get("expires_at", 0) > now}
    if rejected:
        _MODEL_REJECTIONS[scope] = rejected
    else:
        _MODEL_REJECTIONS.pop(scope, None)

@_capability_cache_transaction
def remember_model_rejection(provider: str, base_url: str, api_key: str, model: str,
                             *, status: str, http_status: int = 0, error: str = "") -> None:
    """Remember deterministic selected-model probe failures for this account route.

    This is deliberately account/provider/endpoint/model scoped. Transient
    network/rate-limit failures must never call this function.
    """
    scope = _capability_scope(provider, base_url, api_key)
    now = time.monotonic()
    rejected = {key: value for key, value in _MODEL_REJECTIONS.get(scope, {}).items()
                if value.get("expires_at", 0) > now}
    rejected[str(model)] = {
        "expires_at": now + _MODEL_REJECTION_TTL_SEC,
        "status": str(status or "rejected")[:64],
        "http_status": int(http_status or 0),
        "error": _SECRET_PATTERN.sub("[redacted]", " ".join(str(error or "").split()))[:200],
    }
    _MODEL_REJECTIONS[scope] = rejected
    promoted = {key: expiry for key, expiry in _MODEL_PROMOTIONS.get(scope, {}).items()
                if key != str(model) and expiry > now}
    if promoted:
        _MODEL_PROMOTIONS[scope] = promoted
    else:
        _MODEL_PROMOTIONS.pop(scope, None)

@_capability_cache_transaction
def model_rejection(provider: str, base_url: str, api_key: str, model: str) -> dict[str, Any] | None:
    scope = _capability_scope(provider, base_url, api_key)
    now = time.monotonic()
    rejected = {key: value for key, value in _MODEL_REJECTIONS.get(scope, {}).items()
                if value.get("expires_at", 0) > now}
    if rejected:
        _MODEL_REJECTIONS[scope] = rejected
    else:
        _MODEL_REJECTIONS.pop(scope, None)
    value = rejected.get(str(model))
    return deepcopy(value) if value else None

@_capability_cache_transaction
def model_is_promoted(provider: str, base_url: str, api_key: str, model: str) -> bool:
    scope = _capability_scope(provider, base_url, api_key)
    now = time.monotonic()
    promoted = {key: expiry for key, expiry in _MODEL_PROMOTIONS.get(scope, {}).items()
                if expiry > now}
    if promoted:
        _MODEL_PROMOTIONS[scope] = promoted
    else:
        _MODEL_PROMOTIONS.pop(scope, None)
    return promoted.get(str(model), 0) > now

@_capability_cache_transaction
def retain_model_promotions(provider: str, base_url: str, api_key: str,
                            models: list[str] | tuple[str, ...]) -> None:
    """Invalidate probe evidence for models no longer in this account catalogue."""
    scope = _capability_scope(provider, base_url, api_key)
    allowed, now = {str(model) for model in models}, time.monotonic()
    retained = {model: expiry for model, expiry in _MODEL_PROMOTIONS.get(scope, {}).items()
                if model in allowed and expiry > now}
    if retained:
        _MODEL_PROMOTIONS[scope] = retained
    else:
        _MODEL_PROMOTIONS.pop(scope, None)
    rejected = {model: value for model, value in _MODEL_REJECTIONS.get(scope, {}).items()
                if model in allowed and value.get("expires_at", 0) > now}
    if rejected:
        _MODEL_REJECTIONS[scope] = rejected
    else:
        _MODEL_REJECTIONS.pop(scope, None)

# Semantic alias used by callers that make the negative evidence explicit.
retain_model_rejections = retain_model_promotions

@_capability_cache_transaction
def remember_selected_model_capability(provider: str, base_url: str, api_key: str,
                                      model: str, capability: dict[str, Any]) -> None:
    scope, now = _capability_scope(provider, base_url, api_key), time.monotonic()
    cached = _MODEL_CAPABILITIES.setdefault(scope, {
        "expires_at": 0.0, "models": {}, "selected": {},
    })
    selected = {name: entry for name, entry in cached.get("selected", {}).items()
                if entry.get("expires_at", 0) > now}
    normalized = normalize_model_capabilities(capability)
    if normalized:
        selected[str(model)] = {
            "expires_at": now + MODEL_PROBE_EVIDENCE_TTL_SEC,
            "capabilities": deepcopy(normalized),
        }
    cached["selected"] = selected

@_capability_cache_transaction
def capture_capability_cache_revision(provider: str, base_url: str, api_key: str):
    """Opaque dispatch guard. Removal/refresh replaces it, rejecting late evidence."""
    scope = _capability_scope(provider, base_url, api_key)
    return _MODEL_CAPABILITIES.setdefault(scope, {"expires_at": 0.0, "models": {}, "selected": {}})


@_capability_cache_transaction
def retain_observed_off_control(provider: str, base_url: str, api_key: str,
                                model: str, *, dispatch_revision: Any) -> bool:
    """Bootstrap only native Off actually accepted with reported zero reasoning.

    Called after a successful generation by the adapter, not from a user hint.
    Keeps existing probe TTL/negative evidence intact; no On level is inferred.
    """
    scope = _capability_scope(provider, base_url, api_key)
    cached = _MODEL_CAPABILITIES.get(scope)
    if cached is not dispatch_revision or cached is None:
        return False
    now = time.monotonic()
    if cached.get("expires_at", 0) > now:
        known = cached.get("known_models")
        if known is not None and model not in known:
            return False
    selected = cached.get("selected", {}).get(model, {})
    capabilities = deepcopy(selected.get("capabilities", {})) if selected.get("expires_at", 0) > now else {}
    if cached.get("expires_at", 0) > now:
        for feature, details in normalize_model_capabilities(cached.get("models", {}).get(model)).items():
            capabilities[feature] = {**capabilities.get(feature, {}), **details}
    if capabilities.get("reasoning"):
        return False  # Explicit facts and existing proof, including negatives, win.
    capabilities["reasoning"] = {"supported": True, "mandatory": False,
        "control": "levels", "supported_efforts": ["none"]}
    remember_selected_model_capability(provider, base_url, api_key, model, capabilities)
    cached["selected"][model]["source"] = "accepted_generation_zero_reasoning"
    return True


@_capability_cache_transaction
def forget_model_capabilities(provider: str, base_url: str, api_key: str) -> None:
    scope = (canonical_provider(provider), str(base_url or "").rstrip("/"),
             hashlib.sha256(str(api_key or "").encode()).hexdigest())
    _MODEL_CAPABILITIES.pop(scope, None)
    _MODEL_PROMOTIONS.pop(scope, None)
    _MODEL_REJECTIONS.pop(scope, None)

@_capability_cache_transaction
def discovered_model_capabilities(provider: str, base_url: str, model: str,
                                  api_key: str = "") -> tuple[bool, dict[str, Any]]:
    scope, now = _capability_scope(provider, base_url, api_key), time.monotonic()
    cached = _MODEL_CAPABILITIES.get(scope)
    if not cached:
        return False, {}
    catalogue_fresh = cached.get("expires_at", 0) > now
    selected = {name: entry for name, entry in cached.get("selected", {}).items()
                if entry.get("expires_at", 0) > now}
    cached["selected"] = selected
    if not catalogue_fresh and not selected:
        _MODEL_CAPABILITIES.pop(scope, None)
        return False, {}
    result = deepcopy(selected.get(model, {}).get("capabilities") or {})
    if catalogue_fresh:
        for feature, details in normalize_model_capabilities(cached.get("models", {}).get(model)).items():
            result[feature] = {**result.get(feature, {}), **details}
    return catalogue_fresh or bool(result), result

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
        remember_model_capabilities(spec.provider_id, base_url, api_key, capabilities, models=result.models)
        capabilities = {model: model_capabilities(spec.provider_id, base_url, model, api_key)
                        for model in result.models}
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
