"""Manual OpenRouter: candidates from the model's endpoint list, wire and attempts."""
from __future__ import annotations

import time
from decimal import Decimal
from typing import Any
from urllib.parse import urlsplit

from .settings import host_label

FAMILY = "openrouter"


def _float(value: Any) -> float | None:
    if isinstance(value, Decimal):
        return float(value)
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _required_parameters(payload: dict[str, Any]) -> set[str]:
    needed = set()
    if "reasoning" in payload:
        needed.add("reasoning")
    if "response_format" in payload:
        needed.add("response_format")
    return needed


def candidates(endpoints: list[dict[str, Any]], payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Available endpoints that support the request parameters and price caps."""
    needed = _required_parameters(payload)
    provider = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
    caps = provider.get("max_price") if isinstance(provider.get("max_price"), dict) else {}
    rows = []
    for row in endpoints:
        host = host_label(row.get("tag"))
        if not host or row.get("status") != 0:
            continue
        params = row.get("supported_parameters")
        if params is not None:
            supported = set(params)
            if "structured_outputs" in supported:
                supported.add("response_format")
            if not needed <= supported:
                continue
        prices = {"prompt": _float(row.get("prompt")), "completion": _float(row.get("completion")),
                  "cache_read": _float(row.get("cache_read"))}
        over = False
        for name, field in (("prompt", "prompt"), ("completion", "completion")):
            cap = caps.get(name)
            if isinstance(cap, (int, float)) and not isinstance(cap, bool) and prices[field] is not None \
                    and prices[field] * 1_000_000 > cap:
                over = True
        if over:
            continue
        rows.append({"host": host, "quant": row.get("quantization") or "unknown", "prices": prices,
                     "provider_name": row.get("provider_name") or ""})
    return rows


def wire(payload: dict[str, Any], decision: dict[str, Any] | None) -> dict[str, Any]:
    """provider {order, ignore?, only? (manual without fallback), allow_fallbacks};
    never `sort` together with `order`; caller-chosen order/only stay untouched."""
    if not decision:
        return payload
    provider = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
    if provider.get("order") or provider.get("only"):
        return payload
    order, ignore = list(decision.get("order") or []), list(decision.get("ignore") or [])
    if not order and not ignore:
        return payload
    routed = dict(provider)
    if order:
        routed = {k: v for k, v in routed.items() if k not in ("sort", "preferred_max_latency")}
        routed["order"] = order
        routed.setdefault("allow_fallbacks", True)
        if decision.get("only"):
            routed["only"] = list(order)
    if ignore:
        routed["ignore"] = ignore
    return {**payload, "provider": routed}


def host_for(upstream: Any, endpoints: list[dict[str, Any]], decision: dict[str, Any] | None) -> tuple[str, str]:
    """(endpoint tag, quant) for the response `provider` display name."""
    name = str(upstream or "").strip().lower()
    order = list((decision or {}).get("order") or [])
    if name:
        matches = [row for row in endpoints if str(row.get("provider_name") or "").strip().lower() == name
                   and host_label(row.get("tag"))]
        if matches:
            matches.sort(key=lambda row: order.index(host_label(row["tag"])) if host_label(row["tag"]) in order
                         else len(order))
            return host_label(matches[0]["tag"]), matches[0].get("quantization") or "unknown"
        direct = host_label(name)
        tagged = [row for row in endpoints if host_label(row.get("tag")) == direct]
        return direct, (tagged[0].get("quantization") if tagged else "unknown") or "unknown"
    chosen = (decision or {}).get("chosen") or ""
    tagged = [row for row in endpoints if host_label(row.get("tag")) == chosen]
    return chosen, (tagged[0].get("quantization") if tagged else "unknown") or "unknown"


def is_openrouter(base_url: str) -> bool:
    try:
        return (urlsplit(base_url).hostname or "").lower() == "openrouter.ai"
    except ValueError:
        return False


def is_repair(cache_context: Any) -> bool:
    context = cache_context if hasattr(cache_context, "get") else {}
    return bool(context.get("routingRepair")) or str(context.get("operationId") or "").startswith("repair:")


def plan(request, payload: dict[str, Any], base_url: str, *, endpoint_list=None, rng=None):
    """(payload, decision|None, endpoints, endpoint reason)."""
    from . import avoid_hosts, avoid_key, credential_scope, decide
    if not is_openrouter(base_url):
        return payload, None, [], "not_openrouter"
    provider = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
    if provider.get("order") or provider.get("only"):
        return payload, None, [], "caller_order"
    if endpoint_list is None:
        from backend.ai.providers.openrouter_cache_order import endpoint_list
    endpoints, reason = endpoint_list(request.model, base_url, request.api_key or "")
    context = request.cache_context
    scope = credential_scope(request.api_key, str(context.get("conversationScope") or ""))
    avoid = (avoid_hosts(FAMILY, request.model, avoid_key(request.api_key, context), units_of(request))
             if is_repair(context) else [])
    decision = decide(FAMILY, request.model, candidates(endpoints, payload), scope=scope, avoid=avoid, rng=rng)
    decision["scope"] = scope
    decision["avoid_key"] = avoid_key(request.api_key, context)
    return wire(payload, decision), decision, endpoints, reason


def outcome_of(exc: BaseException) -> str | None:
    """Observation outcome for a failed attempt; None = not an observation."""
    from backend.ai.clients.base import ProviderGenerationCancelled
    from backend.ai.clients.provider_error import ProviderHttpError, ProviderTransportError
    from backend.ai.errors import ModelOutputContractError
    if isinstance(exc, ProviderGenerationCancelled):
        return None
    if isinstance(exc, ProviderHttpError):
        return "http_error"
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, ModelOutputContractError):
        details = getattr(exc, "structural_details", {}) or {}
        return "empty" if details.get("validatorSubtype") in {"empty_output", "reasoning_only_exhausted"} \
            or "no content" in str(exc).lower() or "empty" in str(exc).lower() else "format"
    if isinstance(exc, (ProviderTransportError, RuntimeError, OSError, ValueError)):
        return "transport"
    return None


def cost_of(usage: Any) -> float | None:
    usage = usage if isinstance(usage, dict) else {}
    try:
        cost = float(usage["providerCostUsd"]) if usage.get("providerCostUsd") is not None else None
        if cost is not None and usage.get("isByok") is True and usage.get("upstreamInferenceCostUsd") is not None:
            cost += float(usage["upstreamInferenceCostUsd"])
    except (TypeError, ValueError):
        return None
    return cost


def record_success(request, result, decision, endpoints, family: str = FAMILY) -> str | None:
    from . import record, remember_sticky
    host, quant = host_for(result.upstream_provider, endpoints, decision)
    usage = result.usage_details if isinstance(result.usage_details, dict) else {}
    attempt = record(family, request.model, host, quant, "unvalidated",
                     latency_ms=result.provider_ms, in_tok=result.input_tokens,
                     cached_tok=result.cached_input_tokens, out_tok=result.output_tokens,
                     cost_usd=cost_of(usage), scope=(decision or {}).get("scope", ""),
                     avoid=(decision or {}).get("avoid_key", ""), units=units_of(request))
    if (decision or {}).get("scope") and host:
        remember_sticky(family, request.model, decision["scope"], host)
    return attempt


def record_failure(request, exc: BaseException, decision, endpoints, started: float,
                   family: str = FAMILY) -> None:
    from . import record
    outcome = outcome_of(exc)
    if outcome is None:
        return
    upstream = getattr(exc, "upstream_provider", "") or ""
    if not upstream:
        details = getattr(exc, "structural_details", None)
        meta = details.get("generationMeta") if isinstance(details, dict) else None
        usage = (meta or {}).get("usage") if isinstance(meta, dict) else None
        upstream = (usage or {}).get("upstreamProvider") or "" if isinstance(usage, dict) else ""
    if outcome in {"http_error", "transport"} and not upstream and family == FAMILY:
        # Without the router's provider_name a 4xx/connection failure belongs to
        # the router or the account (key, credits), not to a host.
        return
    host, quant = host_for(upstream, endpoints, decision)
    if not host:
        return
    record(family, request.model, host, quant, outcome, latency_ms=(time.monotonic() - started) * 1000.0,
           scope=(decision or {}).get("scope", ""), avoid=(decision or {}).get("avoid_key", ""),
           units=units_of(request))


def units_of(request) -> int:
    """Lines (unit ids) in one request; 0 when unknown."""
    try:
        return len(tuple(getattr(request, "expected_ids", None) or ()))
    except TypeError:
        return 0


__all__ = ["candidates", "wire", "host_for", "plan", "record_success", "record_failure", "outcome_of", "units_of"]
