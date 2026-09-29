"""Live HF catalogue evidence; never infer serving limits from model names."""
from __future__ import annotations
from backend.ai.workload import normalize_limits
import re
_PROVIDER = re.compile(r"[a-z][a-z0-9_-]{0,63}")

def catalogue_limits(entries):
    """Return explicit-route limits and the safe intersection for Auto.

    Every live route must be uniquely named and disclose a valid context. A
    missing/ambiguous route invalidates the intersection, not the other pinned
    routes. Min, never max: failover must fit any currently advertised route.
    No routing change, generation, cache warming or model-name fallback occurs.
    """
    routes, seen, ambiguous = {}, set(), set()
    complete, live_count = True, 0
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict) or str(entry.get("status") or "").lower() != "live":
            continue
        live_count += 1
        provider = str(entry.get("provider") or "").strip().lower()
        if not _PROVIDER.fullmatch(provider):
            complete = False
            continue
        if provider in seen:
            ambiguous.add(provider)
            complete = False
        seen.add(provider)
        limit = normalize_limits({"contextTokens": entry.get("context_length"),
            "source": "huggingface_live_provider_route", "scope": "pinned_provider_model"})
        if "contextTokens" in limit:
            routes[provider] = limit
        else:
            complete = False
    for provider in ambiguous:
        routes.pop(provider, None)
    common = {}
    if complete and live_count and len(routes) == live_count:
        common = {"contextTokens": min(row["contextTokens"] for row in routes.values()),
            "source": "huggingface_live_route_intersection", "scope": "catalogue_live_routes"}
    return routes, common
