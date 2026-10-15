""".83 Manual OpenRouter tries endpoints with a cheaper cache-read price first.
Offline: the endpoint list is a recorded-shape fixture, no network."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
from backend.ai.providers import openrouter_cache_order as co

LISTING = {"data": {"id": "deepseek/deepseek-v4.1-flash", "endpoints": [
    {"tag": "baseten", "status": 0, "pricing": {"prompt": "0.0000003", "completion": "0.0000012"}},
    {"tag": "together", "status": 0, "pricing": {"prompt": "0.0000003", "completion": "0.0000012", "input_cache_read": "0.00000003"}},
    {"tag": "cohere", "status": 0, "pricing": {"prompt": "0.0000003", "completion": "0.0000011", "input_cache_read": "0.0000003"}},
    {"tag": "deepinfra/fp8", "status": 0, "pricing": {"prompt": "0.00000025", "completion": "0.000001", "input_cache_read": "0.00000005"}},
    {"tag": "down", "status": -1, "pricing": {"prompt": "0.0000001", "completion": "0.0000001", "input_cache_read": "0.00000001"}},
]}}


class Response:
    def __init__(self, status, body): self.status_code, self._body = status, body
    def json(self): return self._body


def factory(calls, status=200, body=LISTING):
    class Client:
        def __init__(self, **kw): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, headers=None):
            calls.append(url)
            return Response(status, body)
    return Client


checks = []
assert co.cache_order_from_endpoints(LISTING) == ["deepinfra/fp8", "together"], co.cache_order_from_endpoints(LISTING)
checks.append("only endpoints whose cache read is cheaper than prompt, cheapest first; down/equal-price excluded")

co.clear(); calls = []
order, reason = co.cache_order("deepseek/deepseek-v4.1-flash", "https://openrouter.ai/api/v1", "sk-x", client_factory=factory(calls))
again, reason2 = co.cache_order("deepseek/deepseek-v4.1-flash", "https://openrouter.ai/api/v1", "sk-x", client_factory=factory(calls))
assert order == again == ["deepinfra/fp8", "together"] and (reason, reason2) == ("fetched", "cached")
assert calls == ["https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints"], calls
checks.append("endpoint list read once per model and reused")

co.clear(); calls = []
order, reason = co.cache_order("x/y", "https://openrouter.ai/api/v1", client_factory=factory(calls, status=503))
assert order == [] and reason == "endpoints_http_503"
order, reason = co.cache_order("x/y", "https://gateway.example/v1", client_factory=factory(calls))
assert order == [] and reason == "not_openrouter"
class Boom:
    def __init__(self, **kw): raise RuntimeError("no network")
order, reason = co.cache_order("x/z", "https://openrouter.ai/api/v1", client_factory=Boom)
assert order == [] and reason == "endpoints_error"
checks.append("unreadable list / other gateways keep normal routing with a visible reason")

payload = {"model": "m", "provider": {"sort": "throughput", "allow_fallbacks": True, "require_parameters": True,
                                      "preferred_max_latency": {"p90": 8}}}
routed = co.apply_cache_order(payload, ["together"])
assert routed["provider"] == {"allow_fallbacks": True, "require_parameters": True, "order": ["together"]}, routed
assert co.apply_cache_order(payload, []) is payload
pinned = {"provider": {"only": ["azure"]}}
assert co.apply_cache_order(pinned, ["together"]) is pinned
checks.append("order replaces throughput sort, keeps fallbacks; caller-pinned endpoints untouched")
print(json.dumps({"passed": len(checks), "checks": checks}))
