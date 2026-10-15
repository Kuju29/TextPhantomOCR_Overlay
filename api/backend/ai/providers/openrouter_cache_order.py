"""Manual OpenRouter: try endpoints with a cheaper cache-read price first.

Requests repeat a long instruction prefix (a Conversation its whole history),
which OpenRouter bills at the cache-read price only on an endpoint that has one.
The model's public endpoint list is read once per model and kept for a while;
when it cannot be read, OpenRouter's normal routing is kept and the reason is traced.
"""
from __future__ import annotations

import threading
import time
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

TTL_SECONDS = 30 * 60
FAILURE_TTL_SECONDS = 5 * 60
MAX_MODELS = 256
MAX_ORDER = 8
_lock = threading.Lock()
_cache: dict[str, tuple[float, list[dict[str, Any]], str]] = {}


def _price(value: Any) -> Decimal | None:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None
    return result if result.is_finite() and result >= 0 else None


def parse_endpoints(data: Any) -> list[dict[str, Any]]:
    """Every listed endpoint with what routing needs (tag, provider_name,
    quantization, status, prices incl. cache read, supported parameters).
    Prices stay Decimal (USD per token); unusable rows are dropped."""
    rows = []
    endpoints = (data or {}).get('data', {}).get('endpoints') if isinstance(data, dict) else None
    for item in endpoints if isinstance(endpoints, list) else []:
        if not isinstance(item, dict):
            continue
        tag, pricing = item.get('tag'), item.get('pricing')
        if not isinstance(tag, str) or not 1 <= len(tag) <= 80:
            continue
        pricing = pricing if isinstance(pricing, dict) else {}
        status = item.get('status', 0)
        params = item.get('supported_parameters')
        rows.append({
            'tag': tag,
            'provider_name': str(item.get('provider_name') or '')[:80],
            'quantization': str(item.get('quantization') or 'unknown').strip().lower()[:16] or 'unknown',
            'status': status if isinstance(status, int) and not isinstance(status, bool) else -1,
            'prompt': _price(pricing.get('prompt')),
            'completion': _price(pricing.get('completion')),
            'cache_read': _price(pricing.get('input_cache_read')),
            'supported_parameters': ([str(p).lower() for p in params if isinstance(p, str)][:64]
                                     if isinstance(params, list) else None),
        })
    return rows


def order_from_parsed(rows: list[dict[str, Any]]) -> list[str]:
    """Usable cache-capable endpoints from parsed rows, cheapest first."""
    ranked = []
    for row in rows:
        prompt, cache, completion = row['prompt'], row['cache_read'], row['completion']
        if row['status'] != 0 or prompt is None or cache is None or completion is None or cache >= prompt:
            continue
        ranked.append((cache + completion, row['tag']))
    return [tag for _, tag in sorted(ranked)][:MAX_ORDER]


def cache_order_from_endpoints(data: Any) -> list[str]:
    """Tags of usable endpoints whose cache read is cheaper than their prompt price,
    cheapest (cache read + completion) first."""
    rows = []
    endpoints = (data or {}).get('data', {}).get('endpoints') if isinstance(data, dict) else None
    for item in endpoints if isinstance(endpoints, list) else []:
        if not isinstance(item, dict) or item.get('status', 0) != 0:
            continue
        tag, pricing = item.get('tag'), item.get('pricing')
        if not isinstance(tag, str) or not 1 <= len(tag) <= 80 or not isinstance(pricing, dict):
            continue
        prompt, cache, completion = (_price(pricing.get(k)) for k in ('prompt', 'input_cache_read', 'completion'))
        if prompt is None or cache is None or completion is None or cache >= prompt:
            continue
        rows.append((cache + completion, tag))
    return [tag for _, tag in sorted(rows)][:MAX_ORDER]


def endpoint_list(model: str, base_url: str, api_key: str = '', *, client_factory=httpx.Client,
                  now=time.monotonic) -> tuple[list[dict[str, Any]], str]:
    """(parsed endpoints, reason). reason: 'fetched', 'cached' or a failure code.
    One GET per model per 30 min (5 min after a failure); shared by cache order
    and provider routing."""
    if (urlsplit(base_url).hostname or '').lower() != 'openrouter.ai' or not model or '/' not in model:
        return [], 'not_openrouter'
    key = base_url.rstrip('/') + '\n' + model
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] > now():
            return [dict(row) for row in hit[1]], 'cached' if hit[2] == 'fetched' else hit[2]
    rows, reason = [], 'fetched'
    try:
        headers = {'Authorization': 'Bearer ' + api_key} if api_key else {}
        url = base_url.rstrip('/') + '/models/' + quote(model, safe='/:.-_') + '/endpoints'
        with client_factory(timeout=4.0) as client:
            response = client.get(url, headers=headers)
        if response.status_code != 200:
            reason = 'endpoints_http_' + str(response.status_code)
        else:
            rows = parse_endpoints(response.json())
    except (httpx.HTTPError, ValueError):
        reason = 'endpoints_unreachable'
    except Exception:  # noqa: BLE001 - routing must never break a translation; reason is traced
        reason = 'endpoints_error'
    ttl = TTL_SECONDS if reason == 'fetched' else FAILURE_TTL_SECONDS
    with _lock:
        if len(_cache) >= MAX_MODELS and key not in _cache:
            _cache.pop(min(_cache, key=lambda k: _cache[k][0]))
        _cache[key] = (now() + ttl, [dict(row) for row in rows], reason)
    return rows, reason


def cache_order(model: str, base_url: str, api_key: str = '', *, client_factory=httpx.Client,
                now=time.monotonic) -> tuple[list[str], str]:
    """(order, reason). reason is 'cached', 'fetched', 'no_cache_endpoints' or a failure code."""
    rows, reason = endpoint_list(model, base_url, api_key, client_factory=client_factory, now=now)
    if reason not in ('fetched', 'cached'):
        return [], reason
    order = order_from_parsed(rows)
    if not order:
        return [], 'no_cache_endpoints'
    return order, reason


def apply_cache_order(payload: dict[str, Any], order: list[str]) -> dict[str, Any]:
    """Put cache-capable endpoints first unless the caller already chose endpoints."""
    provider = payload.get('provider') if isinstance(payload.get('provider'), dict) else {}
    if not order or provider.get('order') or provider.get('only'):
        return payload
    routed = {key: value for key, value in provider.items() if key not in ('sort', 'preferred_max_latency')}
    routed['order'] = list(order)
    routed.setdefault('allow_fallbacks', True)
    return {**payload, 'provider': routed}


def clear() -> None:
    with _lock:
        _cache.clear()
