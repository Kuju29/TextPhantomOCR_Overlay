""".86 provider routing (API side): score/choose parity vectors, scoreboard
bounds, use-driven Center sync, OpenRouter/HF wire, Paid feedback bodies and
observation finalisation. Offline: every network call is a fixture."""
from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
os.environ["TP_CENTER_URL"] = "http://127.0.0.1:8787"
for name in ("TP_ROUTING_MODE", "TP_ROUTING_NO_FP4", "TP_ROUTING_EXPLORE"):
    os.environ.pop(name, None)

import httpx
from backend import gateway_proof
from backend.ai import routing
from backend.ai.clients.base import ChatResult
from backend.ai.clients.provider_error import ProviderHttpError
from backend.ai.provider_contract import GenerationRequest
from backend.ai.routing import settings as rsettings
from backend.ai.routing.score import choose, empty_aggregate, latency_bucket, median_latency_ms, score_candidates
from backend.ai.routing.scoreboard import Scoreboard, StickyMap
from backend.ai.routing.sync import PATH, PEER, SyncClient

checks: list[str] = []
VECTORS = json.loads((ROOT / "scripts/fixtures/routing-vectors-10486.json").read_text(encoding="utf-8"))
SECRET = "a" * 64


def agg_of(raw):
    agg = empty_aggregate()
    agg.update(raw or {})
    return agg


def close(a, b):
    if a is None or b is None:
        return a is b
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    return math.isclose(round(a, 9), b, rel_tol=1e-9, abs_tol=1e-12)


# 1. Parity vectors (the Center runs the same file) ---------------------------
for row in VECTORS["latency_buckets"]:
    assert latency_bucket(row["latency_ms"]) == row["bucket"], row
for row in VECTORS["medians"]:
    assert median_latency_ms(row["lat_hist"]) == row["median_ms"], row
for vector in VECTORS["score"]:
    data = vector["input"]
    cands = [{**c, "agg": agg_of(c.get("agg"))} for c in data["candidates"]]
    out = score_candidates(cands, **{k: v for k, v in data.items() if k in ("min_samples", "weights")})
    assert set(out) == set(vector["expected"]), vector["name"]
    for host, expected in vector["expected"].items():
        for field, value in expected.items():
            assert close(out[host][field], value), (vector["name"], host, field, out[host][field], value)
for vector in VECTORS["choose"]:
    data = dict(vector["input"])
    sequence = iter(data.pop("rng"))
    cands = [{**c, "agg": agg_of(c.get("agg"))} for c in data.pop("candidates")]
    out = choose(cands, rng=lambda: next(sequence), **data)
    for field, value in vector["expected"].items():
        assert out[field] == value, (vector["name"], field, out[field], value)
checks.append(f"{len(VECTORS['score'])} score + {len(VECTORS['choose'])} choose vectors match the shared fixture")

# Independent arithmetic for the first vector (guards a self-generated file).
first = VECTORS["score"][0]["expected"]["deepinfra/fp8"]
quality, reliability = 37 / 40, 39 / 42
eff_in = 2.5e-7 * 0.5 + 5e-8 * 0.5
cost = 1000 * (80000 * eff_in + 20000 * 1e-6) / 100000
score = 100 * quality ** 3 * reliability ** 2 * 1 * (2000 / 4000) ** 0.5
assert close(first["quality"], round(quality, 9)) and close(first["reliability"], round(reliability, 9))
assert close(first["cost"], round(cost, 9)) and first["latency_ms"] == 4000.0 and close(first["score"], round(score, 9))
assert VECTORS["score"][1]["expected"]["novita"]["learning"] is True
assert close(VECTORS["score"][1]["expected"]["novita"]["score"], VECTORS["score"][0]["expected"]["together"]["score"])
checks.append("vector values re-derived by hand: Beta quality, reliability, cache-share cost, histogram median, learning median")

# 2. Scoreboard bounds and retention -------------------------------------------
now = [1_000_000 * 3600.0]
board = Scoreboard(clock=lambda: now[0], max_keys=3)
for index in range(5):
    board.add("openrouter", "m/x", f"h{index}", "fp8", "ok", latency_ms=1500)
assert board.local_keys() == 3 and set(board.window("openrouter", "m/x")) == {"h2", "h3", "h4"}
board.add("openrouter", "m/x", "h2", "fp8", "ok")  # h2 becomes most recently seen
board.add("openrouter", "m/x", "h5", "fp8", "ok")
assert set(board.window("openrouter", "m/x")) == {"h2", "h4", "h5"}
board = Scoreboard(clock=lambda: now[0])
board.add("openrouter", "m/x", "old", "fp8", "ok")
now[0] += 8 * 24 * 3600
board.add("openrouter", "m/x", "new", "fp8", "ok", latency_ms=3000, in_tok=100, cached_tok=50, out_tok=10, cost_usd=0.001)
window = board.window("openrouter", "m/x", 7)
assert set(window) == {"new"} and window["new"]["agg"]["lat_hist"][2] == 1 and window["new"]["agg"]["cost_n"] == 1
now[0] += 23 * 24 * 3600
board.add("openrouter", "m/x", "new", "fp8", "ok")
assert "old" not in board._local[("openrouter", "m/x", "new")]["buckets"] and ("openrouter", "m/x", "old") not in board._local
checks.append("scoreboard: LRU key bound, 7-day window, 30-day retention, histogram/cost sums")

clock = [0.0]
board = Scoreboard(clock=lambda: 3600.0 * 500 + clock[0])
for _ in range(3):
    board.add("openrouter", "m/x", "bad", "fp8", "timeout", cooldown=(3, 10, 30))
assert board.cooled("openrouter", "m/x") == {"bad"}
clock[0] += 31 * 60
assert board.cooled("openrouter", "m/x") == set()
board.add("openrouter", "m/x", "slow", "fp8", "timeout", cooldown=(3, 10, 30))
clock[0] += 11 * 60
board.add("openrouter", "m/x", "slow", "fp8", "timeout", cooldown=(3, 10, 30))
board.add("openrouter", "m/x", "slow", "fp8", "timeout", cooldown=(3, 10, 30))
assert "slow" not in board.cooled("openrouter", "m/x")
checks.append("cooldown: 3 failures in 10 min cool a host for 30 min; older failures do not count")


# 3. Sync triggers -------------------------------------------------------------
class FakeCenter:
    def __init__(self):
        self.calls, self.status, self.pull = [], 200, {"changed": False, "version": "1"}
        self.block = None

    def factory(self, timeout):
        center = self

        class Client:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def post(self, url, json=None, headers=None):
                if center.block: center.block.wait(5)
                center.calls.append(("POST", url, json, headers))
                return httpx.Response(center.status, json={"ok": True}, request=httpx.Request("POST", url))
            def get(self, url, headers=None):
                if center.block: center.block.wait(5)
                center.calls.append(("GET", url, None, headers))
                return httpx.Response(center.status, json=center.pull, request=httpx.Request("GET", url))
        return Client()


def sync_for(board, center, *, secret=SECRET, clock=None, spawn=lambda fn: fn(), applied=None):
    return SyncClient(board, secret=lambda: secret, base=lambda: "http://127.0.0.1:8787",
                      client=center.factory, spawn=spawn, clock=clock or (lambda: 0.0), instance="f" * 32,
                      on_settings=(applied.append if applied is not None else None))


mono = [10_000.0]
center = FakeCenter()
board = Scoreboard(clock=lambda: 3600.0 * 900)
sync = sync_for(board, center, secret="", clock=lambda: mono[0])
for _ in range(120):
    board.add("openrouter", "m/x", "h", "fp8", "timeout"); sync.after_record()
sync.before_route(); sync.note_version("99")
assert center.calls == [] and sync.requests == 0
checks.append("no gateway secret: local stats only, no network at all")

center = FakeCenter()
board = Scoreboard(clock=lambda: 3600.0 * 900)
sync = sync_for(board, center, clock=lambda: mono[0])
for _ in range(49):
    board.add("openrouter", "m/x", "h", "fp8", "ok"); sync.after_record()
assert center.calls == []
board.add("openrouter", "m/x", "h", "fp8", "ok"); sync.after_record()
assert len(center.calls) == 1 and center.calls[0][0] == "POST"
method, url, body, headers = center.calls[0]
assert url.endswith(PATH) and body["instance"] == "f" * 32 and sum(b["n"] for b in body["buckets"]) == 50
assert body["buckets"][0]["hour"] == 900 and body["buckets"][0]["ok"] == 50 and body["buckets"][0]["quant"] == "fp8"
assert gateway_proof.verify(SECRET, headers, "POST", PATH, json.loads(json.dumps(body))) == PEER
assert board.pending_n == 0 and board.window("openrouter", "m/x") == {}
checks.append("push at 50 pending, HMAC body-bound; acknowledged delta dropped (no double count)")

mono[0] += 10
board.add("openrouter", "m/x", "h", "fp8", "ok"); sync.after_record()
assert len(center.calls) == 1  # 1 pending, not a failure, not an hour yet
board.add("openrouter", "m/x", "h", "fp8", "http_error"); sync.after_record()
assert len(center.calls) == 2 and sum(b["n"] for b in center.calls[1][2]["buckets"]) == 2
mono[0] += 30
board.add("openrouter", "m/x", "h", "fp8", "timeout"); sync.after_record()
assert len(center.calls) == 2  # failure push throttled to once per 2 min
mono[0] += 91
board.add("openrouter", "m/x", "h", "fp8", "ok"); sync.after_record()
assert len(center.calls) == 3
mono[0] += 3599
board.add("openrouter", "m/x", "h", "fp8", "ok"); sync.after_record()
assert len(center.calls) == 3
mono[0] += 2
sync.after_record()
assert len(center.calls) == 4  # hourly push only because something is pending
mono[0] += 7200
sync.after_record()
assert len(center.calls) == 4  # nothing pending -> no request
checks.append("failure push immediately but at most every 2 min; otherwise hourly and only when pending")

center.status = 503
board.add("openrouter", "m/x", "h", "fp8", "timeout"); sync.after_record()
assert len(center.calls) == 5 and board.pending_n == 1 and board.window("openrouter", "m/x")["h"]["agg"]["timeout"] == 1
board.add("openrouter", "m/x", "h", "fp8", "timeout"); sync.after_record()
assert len(center.calls) == 5  # failed push: no retry for 2 min
checks.append("failed push keeps the delta locally and backs off")

center = FakeCenter()
board = Scoreboard(clock=lambda: 3600.0 * 900)
applied = []
sync = sync_for(board, center, clock=lambda: mono[0], applied=applied)
center.pull = {"changed": True, "version": "5", "settings_version": "2", "settings": {"mode_default": "auto"},
               "keys": [{"family": "openrouter", "model": "m/x", "host": "together", "quant": "bf16", "n": 30, "ok": 30}]}
sync.before_route()
assert len(center.calls) == 1 and center.calls[0][0] == "GET" and center.calls[0][1].endswith(PATH)  # first pull: no version query
assert gateway_proof.verify(SECRET, center.calls[0][3], "GET", PATH, None) == PEER
assert applied == [{"mode_default": "auto"}] and board.center_version == "5"
assert board.window("openrouter", "m/x")["together"]["agg"]["n"] == 30
sync.before_route(); sync.note_version("5"); sync.note_version("4")
assert len(center.calls) == 1
mono[0] += 3601
sync.before_route()
assert len(center.calls) == 2 and center.calls[1][1].endswith("?version=5")
center.pull = {"changed": False, "version": "5", "settings_version": "2"}
sync.note_version("6", "2")      # data-only change, copy pulled just now: no request
assert len(center.calls) == 2
sync.note_version("6", "3")      # admin changed settings: pull at once
assert len(center.calls) == 3
mono[0] += 901
sync.note_version("7", "2")      # data change, copy older than 15 min: pull
assert len(center.calls) == 4
board.add("openrouter", "m/x", "together", "bf16", "ok")
assert board.window("openrouter", "m/x")["together"]["agg"]["n"] == 31
checks.append("pull lazily on first routing, then when >60 min old, on an admin settings change at once, or on a newer data version when the copy is >15 min old; merge Center+local")

center = FakeCenter(); center.block = threading.Event()
board = Scoreboard(clock=lambda: 3600.0 * 900)
sync = sync_for(board, center, spawn=lambda fn: threading.Thread(target=fn, daemon=True).start(),
                clock=lambda: mono[0])
started = time.monotonic()
sync.before_route()
for _ in range(60):
    board.add("openrouter", "m/x", "h", "fp8", "ok"); sync.after_record()
elapsed = time.monotonic() - started
center.block.set()
assert elapsed < 0.5, elapsed


class Unreachable:
    def __init__(self, timeout): pass
    def __enter__(self): raise httpx.ConnectError("down")
    def __exit__(self, *a): return False


board = Scoreboard(clock=lambda: 3600.0 * 900)
sync = SyncClient(board, secret=lambda: SECRET, base=lambda: "http://127.0.0.1:1", client=Unreachable,
                  spawn=lambda fn: fn(), clock=lambda: mono[0])
for _ in range(50):
    board.add("openrouter", "m/x", "h", "fp8", "ok"); sync.after_record()
sync.before_route()
assert board.pending_n == 50 and board.window("openrouter", "m/x")["h"]["agg"]["n"] == 50
checks.append("an unreachable or slow Center never blocks routing; local data kept")


# 4. Manual OpenRouter wire ------------------------------------------------------
from backend.ai.providers import cloud_openrouter, openrouter_cache_order

ENDPOINTS = [
    {"tag": "deepinfra/fp8", "provider_name": "DeepInfra", "quantization": "fp8", "status": 0,
     "prompt": 2.5e-7, "completion": 1e-6, "cache_read": 5e-8, "supported_parameters": ["reasoning", "max_tokens"]},
    {"tag": "together", "provider_name": "Together", "quantization": "bf16", "status": 0,
     "prompt": 3e-7, "completion": 1.2e-6, "cache_read": 3e-8, "supported_parameters": None},
    {"tag": "baseten", "provider_name": "Baseten", "quantization": "fp8", "status": 0,
     "prompt": 3e-7, "completion": 1.2e-6, "cache_read": None, "supported_parameters": None},
    {"tag": "cheap4", "provider_name": "Cheap", "quantization": "fp4", "status": 0,
     "prompt": 1e-7, "completion": 2e-7, "cache_read": None, "supported_parameters": None},
    {"tag": "down", "provider_name": "Down", "quantization": "fp8", "status": -2,
     "prompt": 1e-8, "completion": 1e-8, "cache_read": None, "supported_parameters": None},
]
parsed = openrouter_cache_order.parse_endpoints({"data": {"endpoints": [
    {"tag": "deepinfra/fp8", "provider_name": "DeepInfra", "quantization": "fp8", "status": 0,
     "pricing": {"prompt": "0.00000025", "completion": "0.000001", "input_cache_read": "0.00000005"},
     "supported_parameters": ["reasoning"]}]}})
assert parsed[0]["quantization"] == "fp8" and float(parsed[0]["cache_read"]) == 5e-8 and parsed[0]["provider_name"] == "DeepInfra"
checks.append("endpoint list keeps quantization, prices incl. cache read, status, supported parameters")


def or_request(*, repair=False, scope="", batch="b-1", op="op-1", model="vendor/model"):
    return GenerationRequest(provider="openrouter", model=model, api_key="sk-or-fixture",
                             base_url="https://openrouter.ai/api/v1", system_text="S", user_parts=("<<TP_P0:hi>>",),
                             unit_count=1, expected_ids=("P0",),
                             cache_context={"operationId": op, "routingBatch": batch, "routingRepair": repair,
                                            "conversationScope": scope,
                                            "translationMode": "conversation" if scope else "independent"})


def run_or(request, *, upstream="DeepInfra", error=None):
    seen = {}

    def fake(**kwargs):
        seen.update(kwargs)
        if error is not None:
            raise error
        return ChatResult("<<TP_P0:hello>>", request.model, 100, 10, 110, "stop", 900.0, 1, "provider", 0, True,
                          "done", upstream_provider=upstream, cached_input_tokens=50,
                          usage_details={"inputTokens": 100, "outputTokens": 10, "providerCostUsd": "0.00002"})
    with patch.object(openrouter_cache_order, "endpoint_list", lambda *a, **k: ([dict(r) for r in ENDPOINTS], "cached")), \
         patch.object(cloud_openrouter, "execute_openrouter_chat", side_effect=fake), routing.collect() as attempts:
        try:
            cloud_openrouter.ADAPTER.generate(request)
        except Exception as exc:  # noqa: BLE001
            seen["error"] = exc
    return seen, attempts


routing.reset()
seen, attempts = run_or(or_request())
provider = seen["payload"]["provider"]
assert provider["order"] == ["deepinfra/fp8", "together", "baseten"], provider
assert "sort" not in provider and "preferred_max_latency" not in provider
assert provider["allow_fallbacks"] is True and provider["require_parameters"] is True and "only" not in provider
assert provider["ignore"] == ["cheap4"], provider  # fp4 host excluded: fallback cannot reach it either
assert seen["trace_fields"]["routing"]["reason"] == "learning" and seen["trace_fields"]["routing"]["candidates"] == 3
assert len(seen["trace_fields"]["routing"]) <= 12 and len(attempts) == 1
checks.append("stats (still learning) = auto order; fp4 and down hosts excluded; never sort with order")

pending = routing.OBS._pending[attempts[0]]
assert pending["host"] == "deepinfra/fp8" and pending["quant"] == "fp8" and pending["cost_usd"] == 0.00002
assert routing.finalize(attempts, "ok") == 1 and routing.BOARD.window("openrouter", "vendor/model")["deepinfra/fp8"]["agg"]["ok"] == 1
checks.append("observation host mapped from the response display name via provider_name; finalised as ok")

os.environ["TP_ROUTING_MODE"] = "auto"
seen, _ = run_or(or_request())
assert seen["payload"]["provider"]["order"] == ["deepinfra/fp8", "together", "baseten"]
assert seen["trace_fields"]["routing"]["mode"] == "auto"
os.environ.pop("TP_ROUTING_MODE")
rsettings.apply_center({"mode_default": "stats", "models": {"vendor/model": {
    "mode": "manual", "manual_order": ["baseten", "together"], "manual_fallback": False}}})
seen, _ = run_or(or_request())
provider = seen["payload"]["provider"]
assert provider["order"] == ["baseten", "together"] and provider["only"] == ["baseten", "together"], provider
rsettings.apply_center({"models": {"vendor/model": {"mode": "manual", "manual_order": ["baseten"], "manual_fallback": True}}})
seen, _ = run_or(or_request())
assert seen["payload"]["provider"]["order"] == ["baseten", "deepinfra/fp8", "together"] and "only" not in seen["payload"]["provider"]
rsettings.reset()
checks.append("auto (env) and manual (Center settings: only / fallback) wire")

routing.reset()
for host, hist in (("deepinfra/fp8", 3), ("together", 0)):
    for _ in range(25):
        routing.BOARD.add("openrouter", "vendor/model", host, "fp8", "ok")
seen, _ = run_or(or_request())
assert seen["trace_fields"]["routing"]["reason"] in {"best", "explore"}
checks.append("stats with >=2 measured hosts scores and picks (best/explore)")

routing.reset()
seen, attempts = run_or(or_request(scope="conv-1"), upstream="Baseten")
routing.finalize(attempts, "ok")
seen, _ = run_or(or_request(scope="conv-1"))
assert seen["payload"]["provider"]["order"][0] == "baseten" and seen["trace_fields"]["routing"]["reason"] == "sticky"
seen, _ = run_or(or_request(scope="conv-2"))
assert seen["payload"]["provider"]["order"][0] == "deepinfra/fp8"
checks.append("stickiness: later requests of a conversation scope start at the host that served it")

routing.reset()
seen, attempts = run_or(or_request(scope="conv-3"))
token = routing.issue_token(attempts)
assert routing.feedback([{"token": token, "outcome": "wrong_language"}]) == 1
assert routing.BOARD.window("openrouter", "vendor/model")["deepinfra/fp8"]["agg"]["wrong_language"] == 1
seen, _ = run_or(or_request(repair=True, op="repair:r:t", scope="conv-3"))
provider = seen["payload"]["provider"]
assert provider["ignore"] == ["cheap4", "deepinfra/fp8"] and provider["order"][0] == "together", provider
seen, _ = run_or(or_request(op="next"))
assert seen["payload"]["provider"]["ignore"] == ["cheap4"]
seen, _ = run_or(or_request(repair=True, op="repair:r:x", batch="other-batch"))
assert seen["payload"]["provider"]["ignore"] == ["cheap4"]
assert routing.feedback([{"token": token, "outcome": "ok"}]) == 0
checks.append("extension feedback token finalises wrong_language; the repair ignores that host only for its batch")

routing.reset()
seen, attempts = run_or(or_request(), error=ProviderHttpError("x", provider="openrouter", model="vendor/model",
                                                              status=502, upstream_provider="Together"))
assert routing.BOARD.window("openrouter", "vendor/model")["together"]["agg"]["http_error"] == 1 and attempts == []
seen, _ = run_or(or_request(), error=ProviderHttpError("x", provider="openrouter", model="vendor/model", status=402))
assert set(routing.BOARD.window("openrouter", "vendor/model")) == {"together"}
seen, _ = run_or(or_request(), error=TimeoutError("slow"))
assert routing.BOARD.window("openrouter", "vendor/model")["deepinfra/fp8"]["agg"]["timeout"] == 1
from backend.ai.clients.base import ProviderGenerationCancelled
seen, _ = run_or(or_request(), error=ProviderGenerationCancelled("user"))
assert sum(r["agg"]["n"] for r in routing.BOARD.window("openrouter", "vendor/model").values()) == 2
checks.append("attempt failures: host http_error, account 402 not a host failure, timeout on chosen, cancellation ignored")

with patch.object(openrouter_cache_order, "endpoint_list", lambda *a, **k: ([], "endpoints_unreachable")), \
     patch.object(cloud_openrouter, "execute_openrouter_chat",
                  side_effect=lambda **k: ChatResult("x", "m", upstream_provider="")) as call:
    cloud_openrouter.ADAPTER.generate(or_request())
provider = call.call_args.kwargs["payload"]["provider"]
assert provider["sort"] == "throughput" and "order" not in provider
assert call.call_args.kwargs["trace_fields"]["routing"]["endpoints"] == "endpoints_unreachable"
checks.append("unreadable endpoint list keeps OpenRouter's normal routing with the reason traced")


# 5. Manual Hugging Face -----------------------------------------------------------
from backend.ai.providers import cloud_huggingface as hf
from backend.ai.routing import huggingface as hf_routing
from backend.ai import content_stream

CARD = {"id": "org/model", "providers": [
    {"provider": "together", "status": "live", "pricing": {"input": 0.3, "output": 1.2}},
    {"provider": "novita", "status": "live", "pricing": {"input": 0.2, "output": 0.8}},
    {"provider": "sambanova", "status": "error"}]}
assert [r["host"] for r in hf_routing.parse_card(CARD)] == ["together", "novita"]
assert hf_routing.parse_card(CARD)[1]["prices"]["prompt"] == 0.2 / 1_000_000 and hf_routing.parse_card(CARD)[0]["quant"] == "unknown"

calls = []


class CardClient:
    def __init__(self, **kw): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get(self, url, headers=None):
        calls.append(url)
        return httpx.Response(200, json=CARD, request=httpx.Request("GET", url))


hf_routing.clear()
rows, reason = hf_routing.provider_list("org/model", hf.DEFAULT_BASE_URL, "hf_x", client_factory=CardClient)
rows2, reason2 = hf_routing.provider_list("org/model", hf.DEFAULT_BASE_URL, "hf_x", client_factory=CardClient)
assert len(calls) == 1 and (reason, reason2) == ("fetched", "cached") and rows == rows2
checks.append("HF inference providers read once per account+model and cached")


def hf_request(model="org/model", repair=False):
    return GenerationRequest(provider="huggingface", model=model, api_key="hf_fixture", base_url=hf.DEFAULT_BASE_URL,
                             system_text="S", user_parts=("<<TP_P0:hi>>",), unit_count=1, expected_ids=("P0",),
                             cache_context={"operationId": "op", "routingBatch": "b", "routingRepair": repair})


def run_hf(request, outcomes):
    sent = []

    def fake(**kwargs):
        sent.append(kwargs["payload"]["model"])
        step = outcomes[len(sent) - 1]
        if callable(step):
            return step()
        if isinstance(step, BaseException):
            raise step
        return ChatResult("<<TP_P0:ok>>", "org/model", 10, 2, 12, "stop", 500.0, 1, "provider", 0, True, "done",
                          upstream_provider=step)
    with patch.object(hf_routing, "provider_list", lambda *a, **k: (hf_routing.parse_card(CARD), "cached")), \
         patch.object(hf, "execute_huggingface_chat", side_effect=fake):
        try:
            hf.ADAPTER.generate(request)
        except Exception as exc:  # noqa: BLE001
            sent.append(exc)
    return sent


routing.reset()
sent = run_hf(hf_request(), ["novita"])
assert sent == ["org/model:novita"], sent  # learning -> auto order: cheapest listed first
http503 = ProviderHttpError("busy", provider="huggingface", model="org/model", status=503)
sent = run_hf(hf_request(), [http503, "together"])
assert sent == ["org/model:novita", "org/model:together"], sent
assert routing.BOARD.window("huggingface", "org/model")["novita"]["agg"]["http_error"] == 1
sent = run_hf(hf_request(), [http503, http503])
assert sent[:2] == ["org/model:novita", "org/model:together"] and isinstance(sent[2], ProviderHttpError) and len(sent) == 3
checks.append("HF: chosen host as model:<provider>; one retry with the next host on a transport failure")


def emitted_then_fail():
    content_stream.emit("<<TP_P0:par")
    raise ProviderHttpError("cut", provider="huggingface", model="org/model", status=502)


with content_stream.scope(lambda text: None):
    sent = run_hf(hf_request(), [emitted_then_fail, "together"])
assert sent[0] == "org/model:novita" and isinstance(sent[1], ProviderHttpError) and len(sent) == 2
sent = run_hf(hf_request(model="org/model:together"), [http503, "novita"])
assert sent[0] == "org/model:together" and isinstance(sent[1], ProviderHttpError)
sent = run_hf(hf_request(model="org/model:fastest"), ["novita"])
assert sent == ["org/model:fastest"]
checks.append("HF: no retry after output was generated; a user-chosen provider or HF policy is respected")


# 6. Paid: routing_feedback / avoid_host / X-TP-Routing-Version ---------------------
from backend.ai.providers import cloud_paid

PAID_BODY = {"id": "gen", "model": "qa/test", "choices": [{"message": {"content": "<<I1_P0:ok>>"},
             "finish_reason": "stop"}], "usage": {"prompt_tokens": 30, "completion_tokens": 2},
             "charged_tp": "1", "balance_tp": "9", "provider": "DeepInfra"}


def run_paid(op, *, version="3", repair=False, batch="pb", key="synthetic-session"):
    posted = []

    class Client:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def post(self, url, **kwargs):
            posted.append(kwargs["json"])
            headers = {"x-tp-routing-version": version} if version else {}
            return httpx.Response(200, json=PAID_BODY, headers=headers, request=httpx.Request("POST", url))

    request = GenerationRequest(provider="paid", model="qa/test", api_key=key, system_text="QA",
                                user_parts=("hello",), cache_context={"operationId": op, "routingBatch": batch,
                                                                      "routingRepair": repair})
    with patch.object(cloud_paid, "center_client", lambda *a, **k: Client()), \
         patch("backend.ai.paid_protocol.require_protocol", lambda *a, **k: None), \
         patch.object(routing.SYNC, "note_version", lambda v, s=None: notes.append(v)), \
         patch.object(cloud_paid.diagnostics, "emit", lambda *a, **k: None), routing.collect() as attempts:
        cloud_paid.ADAPTER.generate(request)
    return posted[0], attempts


notes: list = []
routing.reset(); cloud_paid._ROUTING_CENTERS.clear()
body, attempts = run_paid("p-0", version="")
assert "routing_feedback" not in body and "avoid_host" not in body and attempts == []
checks.append("Paid: an older Center (no X-TP-Routing-Version) never receives routing fields")

body, attempts = run_paid("p-1")
assert "routing_feedback" not in body and notes == ["3"] and len(attempts) == 1
routing.finalize(attempts, "wrong_language")
other, _ = run_paid("p-other", key="another-customer")
assert "routing_feedback" not in other  # never on another customer's request
body2, attempts2 = run_paid("repair:run:task", repair=True)
assert body2["routing_feedback"] == [{"operation_id": body["operation_id"], "outcome": "wrong_language"}]
assert body2["avoid_host"] == "DeepInfra", body2
routing.finalize(attempts2, "ok")
body3, _ = run_paid("p-2", batch="other")
assert body3["routing_feedback"] == [{"operation_id": body2["operation_id"], "outcome": "ok"}] and "avoid_host" not in body3
for index in range(40):
    routing.OBS._paid_feedback.append({"owner": cloud_paid._feedback_owner("synthetic-session"),
                                       "operation_id": f"{index:064x}", "outcome": "ok"})
body4, _ = run_paid("p-3")
assert len(body4["routing_feedback"]) == 32
checks.append("Paid: feedback of earlier operations (<=32, same credential only) and avoid_host on repair; version header noted")


class Lost:
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def post(self, url, **kwargs): raise httpx.ReadError("lost")


before = len(routing.OBS._paid_feedback)
req = GenerationRequest(provider="paid", model="qa/test", api_key="synthetic-session", system_text="QA",
                        user_parts=("hello",), cache_context={"operationId": "p-lost"})
with patch.object(cloud_paid, "center_client", lambda *a, **k: Lost()), \
     patch("backend.ai.paid_protocol.require_protocol", lambda *a, **k: None), \
     patch.object(cloud_paid.diagnostics, "emit", lambda *a, **k: None):
    try:
        cloud_paid.ADAPTER.generate(req)
    except Exception:
        pass
assert len(routing.OBS._paid_feedback) == before
checks.append("Paid: feedback of a request lost in transport is kept for the next one")


# 7. Finalisation through the validators ----------------------------------------------
from backend.application.ai_translation.orchestration import _routing_validation
from backend.jobs.stages.ai_repair import _routing_outcome
from backend.ai.translation.invocation import contract_outcome
from backend.ai.errors import ModelOutputContractError, WrongLanguageOutput

routing.reset()


def pending_attempt(host="together"):
    with routing.collect() as ids:
        routing.record("openrouter", "vendor/model", host, "bf16", "unvalidated")
    return ids


ids = pending_attempt()
body = {"meta": {}}
_routing_validation({"meta": {"routing_attempts": ids}}, body, ["u1"])
assert "routingFeedback" not in body["meta"] and routing.BOARD.window("openrouter", "vendor/model")["together"]["agg"]["missing_ids"] == 1
ids = pending_attempt()
_routing_validation({"meta": {"routing_attempts": ids}}, body, [])
assert len(body["meta"]["routingFeedback"]["token"]) == 32
for state, expected in (({"valid": True}, "ok"), ({"valid": False, "reason": "wrong_target_script"}, "wrong_language"),
                        ({"valid": False, "reason": "missing_or_empty", "missing": [0]}, "missing_ids"),
                        ({"valid": False, "reason": "missing_or_empty", "missing": [0, 1]}, "empty"),
                        ({"valid": False, "reason": "malformed"}, "format")):
    ids = pending_attempt("h-" + expected.replace("_", "-"))
    _routing_outcome({"meta": {"routing_attempts": ids}}, state, 2)
    assert routing.BOARD.window("openrouter", "vendor/model")["h-" + expected.replace("_", "-")]["agg"][expected] == 1
assert contract_outcome(WrongLanguageOutput("x")) == "wrong_language"
assert contract_outcome(ModelOutputContractError("x", validatorSubtype="empty_output")) == "empty"
assert contract_outcome(ModelOutputContractError("x", missingIds=["P1"])) == "missing_ids"
assert contract_outcome(ModelOutputContractError("x")) == "format"
checks.append("validators finalise attempts: response mapping (missing / token), job validator, decoder contract errors")

mono_obs = [0.0]
from backend.ai.routing.observations import Observations
obs = Observations(Scoreboard(clock=lambda: 3600.0 * 900), StickyMap(), clock=lambda: mono_obs[0])
attempt = obs.record("openrouter", "vendor/model", "together", "bf16", "unvalidated")
mono_obs[0] += 16 * 60
obs.sweep()
assert obs.pending_count() == 0 and obs.board.window("openrouter", "vendor/model")["together"]["agg"]["unvalidated"] == 1
assert obs.record("openrouter", "vendor/model", "Bad Host!", "x", "ok") is None
checks.append("unreported answers become `unvalidated` after 15 min (lazy, no timer); invalid host labels dropped")


# 8. Push batches: size bound, same id on an uncertain retry, cached <= input --------
hours = [3600.0 * 900]
board = Scoreboard(clock=lambda: hours[0])
for index in range(1200):
    board.add("openrouter", f"m/{index}", "together", "bf16", "ok", latency_ms=1000, in_tok=10, cached_tok=99, out_tok=5)
assert board.window("openrouter", "m/0")["together"]["agg"]["cached_tok"] == 10  # clamped to in_tok
rows = board.take_push()
assert len(rows) == 800 and len(json.dumps({"instance": "f" * 32, "push": board.push_id, "buckets": rows})) < 512 * 1024
first_id = board.push_id
board.fail_push(uncertain=True)                      # sent, answer lost: keep the same batch and id
again = board.take_push()
assert board.push_id == first_id and again == rows
board.fail_push()                                    # definite failure: rows go back to the delta
assert board.push_id == "" and board.pending_n == 1200
second = board.take_push()
assert len(second) == 800 and board.push_id and board.push_id != first_id
board.ack_push()
assert len(board.take_push()) == 400
checks.append("push batches stay under the Center limit (800 rows / 400 KB); an uncertain failure retries the same batch id; cached tokens clamped")


class LostAnswer(FakeCenter):
    def factory(self, timeout):
        center = self

        class Client:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def post(self, url, json=None, headers=None):
                center.calls.append(("POST", url, json, headers))
                if len(center.calls) == 1:
                    raise httpx.ReadTimeout("answer lost")
                return httpx.Response(200, json={"ok": True}, request=httpx.Request("POST", url))
        return Client()


lost = LostAnswer()
board = Scoreboard(clock=lambda: 3600.0 * 900)
sync = sync_for(board, lost, clock=lambda: mono[0])
for _ in range(50):
    board.add("openrouter", "m/x", "together", "bf16", "ok")
sync.after_record()
assert len(lost.calls) == 1 and board.push_id and board.pending_n == 0
mono[0] += 121
sync.after_record()                                  # nothing new pending, but the lost batch is retried
assert len(lost.calls) == 2 and lost.calls[1][2]["push"] == lost.calls[0][2]["push"]
assert lost.calls[1][2]["buckets"] == lost.calls[0][2]["buckets"] and board.push_id == ""
checks.append("a push whose answer was lost is retried with the same push id (the Center drops the repeat)")

print(json.dumps({"passed": len(checks), "checks": checks}, ensure_ascii=False))
