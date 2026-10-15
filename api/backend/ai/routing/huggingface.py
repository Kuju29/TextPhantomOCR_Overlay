"""Manual Hugging Face Router: inference providers serving a model as hosts.

The router has no server-side fallback list, so the chosen host is sent as a
`model:<provider>` suffix and, after a transport failure of that host before
any output, one retry goes to the next host. A user-selected suffix (a
provider or an HF policy such as :fastest) is respected and never routed.
"""
from __future__ import annotations

import hashlib
import threading
import time
from typing import Any
from urllib.parse import quote

import httpx

from .settings import host_label

FAMILY = "huggingface"
ROUTER = "https://router.huggingface.co/v1"
TTL_SECONDS = 30 * 60
FAILURE_TTL_SECONDS = 5 * 60
MAX_ENTRIES = 256
_lock = threading.Lock()
_cache: dict[tuple[str, str, str], tuple[float, list[dict[str, Any]], str]] = {}
# Only answers that say the host did not take the request: a gateway timeout
# (504/524) or a broken body may come after the host already generated (paid twice).
RETRY_STATUSES = frozenset({429, 503})


def _per_token(value: Any) -> float | None:
    """HF router lists prices in USD per 1M tokens."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    return float(value) / 1_000_000


def parse_card(card: Any) -> list[dict[str, Any]]:
    from backend.ai.providers.huggingface_catalogue import live_entries
    rows = []
    for entry in live_entries(card if isinstance(card, dict) else {}):
        host = host_label(entry.get("provider"))
        if not host or any(row["host"] == host for row in rows):
            continue
        pricing = entry.get("pricing") if isinstance(entry.get("pricing"), dict) else {}
        quant = entry.get("quantization")
        rows.append({"host": host,
                     "quant": quant.strip().lower()[:16] if isinstance(quant, str) and quant.strip() else "unknown",
                     "prices": {"prompt": _per_token(pricing.get("input")),
                                "completion": _per_token(pricing.get("output")),
                                "cache_read": _per_token(pricing.get("cache_read", pricing.get("input_cache_read")))}})
    return rows


def provider_list(model: str, base_url: str, api_key: str, *, client_factory=httpx.Client,
                  now=time.monotonic) -> tuple[list[dict[str, Any]], str]:
    """(live inference providers, reason); cached 30 min per account and model."""
    base = (base_url or ROUTER).rstrip("/")
    if base != ROUTER or not model or "/" not in model or not api_key:
        return [], "not_hf_router"
    key = (base, hashlib.sha256(api_key.encode()).hexdigest(), model)
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] > now():
            return [dict(row) for row in hit[1]], "cached" if hit[2] == "fetched" else hit[2]
    rows, reason = [], "fetched"
    try:
        with client_factory(timeout=4.0) as client:
            response = client.get(base + "/models/" + quote(model, safe="/"),
                                  headers={"Authorization": "Bearer " + api_key})
        if response.status_code != 200:
            reason = "providers_http_" + str(response.status_code)
        else:
            card = response.json()
            if isinstance(card, dict) and isinstance(card.get("data"), dict):
                card = card["data"]
            rows = parse_card(card) if isinstance(card, dict) and card.get("id") == model else []
            reason = "fetched" if rows else "no_live_providers"
    except (httpx.HTTPError, ValueError):
        reason = "providers_unreachable"
    except Exception:  # noqa: BLE001 - routing never breaks a translation; reason is traced
        reason = "providers_error"
    ttl = TTL_SECONDS if reason in ("fetched", "no_live_providers") else FAILURE_TTL_SECONDS
    with _lock:
        if len(_cache) >= MAX_ENTRIES and key not in _cache:
            _cache.pop(min(_cache, key=lambda k: _cache[k][0]))
        _cache[key] = (now() + ttl, [dict(row) for row in rows], reason)
    return rows, reason


def clear() -> None:
    with _lock:
        _cache.clear()


def plan(request, base_model: str, *, provider_list_fn=None, rng=None):
    """(decision|None, reason) for an unqualified HF model id."""
    from . import avoid_hosts, avoid_key, credential_scope, decide
    from .openrouter import is_repair
    lister = provider_list_fn or provider_list
    candidates, reason = lister(base_model, request.base_url or ROUTER, request.api_key or "")
    context = request.cache_context
    scope = credential_scope(request.api_key, str(context.get("conversationScope") or ""))
    key = avoid_key(request.api_key, context)
    from .openrouter import units_of
    avoid = avoid_hosts(FAMILY, base_model, key, units_of(request)) if is_repair(context) else []
    decision = decide(FAMILY, base_model, candidates, scope=scope, avoid=avoid, rng=rng)
    decision["scope"], decision["avoid_key"] = scope, key
    decision["quants"] = {row["host"]: row.get("quant") or "unknown" for row in candidates}
    return decision, reason


def retryable_before_output(exc: BaseException, emitted: bool) -> bool:
    """A transport failure of the host before any output (HF has no fallback list)."""
    from backend.ai.clients.base import ProviderGenerationCancelled
    from backend.ai.clients.provider_error import ProviderHttpError
    if emitted or isinstance(exc, ProviderGenerationCancelled):
        return False
    if isinstance(exc, ProviderHttpError):
        return isinstance(exc.status, int) and exc.status in RETRY_STATUSES
    cause = exc
    while cause is not None:
        if isinstance(cause, (httpx.ConnectError, httpx.ConnectTimeout)):
            return True
        cause = cause.__cause__
    return False


__all__ = ["provider_list", "parse_card", "plan", "retryable_before_output", "clear", "FAMILY"]
