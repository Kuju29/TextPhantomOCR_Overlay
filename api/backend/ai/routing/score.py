"""Host score and per-request choice (routing contract §4-§5).

Pure functions: no clock, no network, no global state. The Center runs the
same rules; scripts/fixtures/routing-vectors-10486.json holds shared vectors.

Rules the contract leaves open are fixed here and repeated in the vector file
("rules" block) so both sides compute identical numbers:
- lat_hist: 8 counts for upper bounds [1,2,4,8,16,32,64,128] s. A latency of
  s seconds goes to the first bound with s <= bound; anything above 64 s goes to
  the last bucket ("128 = more"). Median = the bound (in ms) of the first bucket
  whose cumulative count * 2 >= total; no samples -> unknown.
- cost: observed cost_usd / ((in_tok+out_tok)/1000) when cost_n >= 5 and
  tokens > 0; else listed prices (USD per token) with the observed cache share
  c = cached_tok / in_tok (0 without input): effective input = prompt*(1-c) +
  cache_read*c (cache_read missing -> prompt); per 1K = 1000 * (in*eff_in +
  out*completion) / (in+out), or 1000 * (eff_in + completion) / 2 without
  tokens. Missing listed prices -> unknown.
- unknown / non-positive cost or unknown latency -> factor 1 (neutral);
  cheapest/fastest = minimum over candidates with a known positive value.
- learning (n < min_samples) -> median score of the non-learning candidates
  (mean of the two middle values for an even count); none -> null.
- ranking: score desc, then host asc.
"""
from __future__ import annotations

from typing import Any, Callable, Iterable

LAT_BOUNDS_S = (1, 2, 4, 8, 16, 32, 64, 128)
VALIDATION_FAILURES = ("wrong_language", "missing_ids", "empty", "format")
TRANSPORT_FAILURES = ("http_error", "timeout", "transport")
OUTCOMES = ("ok", *VALIDATION_FAILURES, *TRANSPORT_FAILURES, "unvalidated")
COUNT_FIELDS = ("n", *OUTCOMES)
SUM_FIELDS = ("lat_sum", "lat_n", "in_tok", "cached_tok", "out_tok", "cost_usd", "cost_n")
REASONS = ("best", "explore", "sticky", "pinned", "manual", "auto", "learning", "fallback_cooldown")
MAX_ORDER = 16
DEFAULT_WEIGHTS = {"wq": 3.0, "wr": 2.0, "wc": 1.0, "wl": 0.5}


def empty_aggregate() -> dict[str, Any]:
    agg: dict[str, Any] = {name: 0 for name in COUNT_FIELDS}
    agg.update({name: 0 for name in SUM_FIELDS})
    agg["cost_usd"] = 0.0
    agg["lat_hist"] = [0] * len(LAT_BOUNDS_S)
    return agg


def add_aggregate(target: dict[str, Any], other: dict[str, Any] | None) -> dict[str, Any]:
    """Add counts of `other` into `target` (unknown/invalid fields are ignored)."""
    if not isinstance(other, dict):
        return target
    for name in (*COUNT_FIELDS, *SUM_FIELDS):
        value = other.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            target[name] = target.get(name, 0) + value
    hist = other.get("lat_hist")
    if isinstance(hist, list) and len(hist) == len(LAT_BOUNDS_S):
        target["lat_hist"] = [a + (b if isinstance(b, (int, float)) and not isinstance(b, bool) and b >= 0 else 0)
                              for a, b in zip(target.get("lat_hist") or [0] * len(LAT_BOUNDS_S), hist)]
    return target


def latency_bucket(latency_ms: float) -> int:
    seconds = max(0.0, float(latency_ms)) / 1000.0
    for index, bound in enumerate(LAT_BOUNDS_S):
        if seconds <= bound:
            return index
    return len(LAT_BOUNDS_S) - 1


def median_latency_ms(hist: Iterable[int] | None) -> float | None:
    values = list(hist or [])
    total = sum(values)
    if total <= 0:
        return None
    running = 0
    for index, count in enumerate(values):
        running += count
        if running * 2 >= total:
            return float(LAT_BOUNDS_S[index] * 1000)
    return float(LAT_BOUNDS_S[-1] * 1000)


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number not in (float("inf"), float("-inf")) and number >= 0 else None


def effective_cost(agg: dict[str, Any], prices: dict[str, Any] | None) -> float | None:
    """USD per 1K tokens (observed when cost_n >= 5, else listed with cache share)."""
    tokens = (agg.get("in_tok") or 0) + (agg.get("out_tok") or 0)
    if (agg.get("cost_n") or 0) >= 5 and tokens > 0:
        return float(agg.get("cost_usd") or 0.0) / (tokens / 1000.0)
    prices = prices if isinstance(prices, dict) else {}
    prompt, completion = _num(prices.get("prompt")), _num(prices.get("completion"))
    if prompt is None or completion is None:
        return None
    cache_read = _num(prices.get("cache_read"))
    cache_read = prompt if cache_read is None else cache_read
    inp, out = agg.get("in_tok") or 0, agg.get("out_tok") or 0
    share = min(1.0, (agg.get("cached_tok") or 0) / inp) if inp > 0 else 0.0
    eff_in = prompt * (1 - share) + cache_read * share
    if inp + out > 0:
        return 1000.0 * (inp * eff_in + out * completion) / (inp + out)
    return 1000.0 * (eff_in + completion) / 2.0


def quality(agg: dict[str, Any]) -> float:
    validated = (agg.get("ok") or 0) + sum(agg.get(name) or 0 for name in VALIDATION_FAILURES)
    return ((agg.get("ok") or 0) + 1) / (validated + 2)


def reliability(agg: dict[str, Any]) -> float:
    n = agg.get("n") or 0
    failures = sum(agg.get(name) or 0 for name in TRANSPORT_FAILURES)
    return (max(0, n - failures) + 1) / (n + 2)


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2.0


def score_candidates(candidates: list[dict[str, Any]], *, min_samples: int = 20,
                     weights: dict[str, float] | None = None) -> dict[str, dict[str, Any]]:
    """{host: {score, learning, quality, reliability, cost, latency_ms}}.

    Each candidate: {host, quant?, prices?: {prompt, completion, cache_read},
    agg: window aggregate}."""
    w = {**DEFAULT_WEIGHTS, **{k: float(v) for k, v in (weights or {}).items() if k in DEFAULT_WEIGHTS}}
    rows: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        agg = candidate.get("agg") or empty_aggregate()
        rows[candidate["host"]] = {
            "learning": (agg.get("n") or 0) < min_samples,
            "quality": quality(agg), "reliability": reliability(agg),
            "cost": effective_cost(agg, candidate.get("prices")),
            "latency_ms": median_latency_ms(agg.get("lat_hist")),
        }
    costs = [row["cost"] for row in rows.values() if row["cost"] is not None and row["cost"] > 0]
    lats = [row["latency_ms"] for row in rows.values() if row["latency_ms"] is not None and row["latency_ms"] > 0]
    cheapest, fastest = (min(costs) if costs else None), (min(lats) if lats else None)
    for row in rows.values():
        cost_factor = cheapest / row["cost"] if cheapest is not None and row["cost"] and row["cost"] > 0 else 1.0
        lat_factor = fastest / row["latency_ms"] if fastest is not None and row["latency_ms"] and row["latency_ms"] > 0 else 1.0
        row["score"] = 100.0 * (row["quality"] ** w["wq"]) * (row["reliability"] ** w["wr"]) * \
            (cost_factor ** w["wc"]) * (lat_factor ** w["wl"])
    learned = _median([row["score"] for row in rows.values() if not row["learning"]])
    for row in rows.values():
        if row["learning"]:
            row["score"] = learned
    return rows


def _price(candidate: dict[str, Any], name: str) -> float | None:
    prices = candidate.get("prices") if isinstance(candidate.get("prices"), dict) else {}
    return _num(prices.get(name))


def auto_order(candidates: list[dict[str, Any]]) -> list[str]:
    """Cache-first rule: cache-capable hosts by (cache_read + completion), then the rest
    by (prompt + completion); unknown prices last; ties by host."""
    cached, rest, unknown = [], [], []
    for candidate in candidates:
        prompt, completion, read = (_price(candidate, k) for k in ("prompt", "completion", "cache_read"))
        host = candidate["host"]
        if prompt is not None and completion is not None and read is not None and read < prompt:
            cached.append((read + completion, host))
        elif prompt is not None and completion is not None:
            rest.append((prompt + completion, host))
        else:
            unknown.append(host)
    return [h for _, h in sorted(cached)] + [h for _, h in sorted(rest)] + sorted(unknown)


def _is_fp4(quant: Any) -> bool:
    return str(quant or "").lower() in {"fp4", "int4"}


def choose(candidates: list[dict[str, Any]], *, mode: str = "stats", model_rules: dict[str, Any] | None = None,
           no_fp4: bool = True, explore: float = 0.05, min_samples: int = 20,
           weights: dict[str, float] | None = None, cooled: Iterable[str] = (),
           sticky: str | None = None, avoid: Iterable[str] = (),
           rng: Callable[[], float] | None = None) -> dict[str, Any]:
    """One routing decision. Steps (fixed order, also in the vector file):
    1 blocked removed; 2 no_fp4 (unless every remaining candidate is fp4/int4);
    3 avoid removed (unless that leaves nothing); 4 mode order (stats draws
    u1=rng() for explore when >=2 candidates have min_samples, and u2=rng() only
    when exploring among >=1 other); 5 cooled hosts moved to the end; 6 pinned
    first (if present and not cooled) else sticky first (same condition).
    """
    rules = model_rules if isinstance(model_rules, dict) else {}
    blocked = {str(h) for h in rules.get("blocked") or []}
    pool = [c for c in candidates if c.get("host") and c["host"] not in blocked]
    seen: set[str] = set()
    pool = [c for c in pool if not (c["host"] in seen or seen.add(c["host"]))]
    # Blocked and fp4-excluded hosts are also ignored on the wire, so an
    # OpenRouter fallback (allow_fallbacks) cannot reach them either.
    excluded = set(blocked)
    # Native fp4 models (every listed host is fp4/int4) keep them; decided on the
    # full list, so blocking the other hosts never lets fp4 back in.
    if no_fp4 and any(not _is_fp4(c.get("quant")) for c in candidates if c.get("host")):
        excluded |= {c["host"] for c in pool if _is_fp4(c.get("quant"))}
        pool = [c for c in pool if not _is_fp4(c.get("quant"))]
    avoid_set = {str(h) for h in avoid if h}
    if avoid_set:
        kept = [c for c in pool if c["host"] not in avoid_set]
        if kept or not pool:
            pool = kept
            excluded |= avoid_set
    ignore: list[str] = sorted(excluded)[:MAX_ORDER * 2]
    cooled_set = {str(h) for h in cooled}
    mode = mode if mode in {"stats", "auto", "manual"} else "stats"
    scores: dict[str, dict[str, Any]] = {}
    only = False
    if mode == "manual":
        hosts = {c["host"] for c in pool}
        order = [h for h in dict.fromkeys(str(x) for x in rules.get("manual_order") or []) if h in hosts]
        if rules.get("manual_fallback") is True:
            order += [h for h in auto_order(pool) if h not in order]
        else:
            only = True
        reason = "manual"
        order, reason = _cool(order, cooled_set, reason)
    else:
        scores = score_candidates(pool, min_samples=min_samples, weights=weights)
        learned = [h for h, row in scores.items() if not row["learning"]]
        if mode == "auto" or len(learned) < 2:
            reason = "auto" if mode == "auto" else "learning"
            order, reason = _cool(auto_order(pool), cooled_set, reason)
        else:
            draw = rng or __import__("random").random
            ranked = sorted(scores, key=lambda h: (-(scores[h]["score"] or 0.0), h))
            active = [h for h in ranked if h not in cooled_set] or ranked
            chosen, reason = active[0], "best"
            others = active[1:]
            if draw() < explore and others:
                total = sum(max(0.0, scores[h]["score"] or 0.0) for h in others)
                pick = draw() * total
                chosen, acc = others[0], 0.0
                if total > 0:
                    for host in others:
                        acc += max(0.0, scores[host]["score"] or 0.0)
                        if pick < acc:
                            chosen = host
                            break
                reason = "explore"
            elif ranked[0] in cooled_set:
                reason = "fallback_cooldown"
            order = [chosen] + [h for h in active if h != chosen] + [h for h in ranked if h not in active]
    pinned = rules.get("pinned")
    if pinned and pinned in order and pinned not in cooled_set:
        order, reason = [pinned] + [h for h in order if h != pinned], "pinned"
    elif sticky and sticky in order and sticky not in cooled_set:
        order, reason = [sticky] + [h for h in order if h != sticky], "sticky"
    order = order[:MAX_ORDER]
    return {"mode": mode, "order": order, "ignore": ignore, "only": only,
            "chosen": order[0] if order else None, "reason": reason, "candidates": len(pool),
            "scores": {h: (None if row["score"] is None else round(row["score"], 6)) for h, row in scores.items()}}


def _cool(order: list[str], cooled: set[str], reason: str) -> tuple[list[str], str]:
    moved = [h for h in order if h not in cooled] + [h for h in order if h in cooled]
    if order and moved and moved[0] != order[0]:
        return moved, "fallback_cooldown"
    return moved, reason


__all__ = ["LAT_BOUNDS_S", "OUTCOMES", "VALIDATION_FAILURES", "TRANSPORT_FAILURES", "REASONS",
           "empty_aggregate", "add_aggregate", "latency_bucket", "median_latency_ms", "effective_cost",
           "quality", "reliability", "score_candidates", "auto_order", "choose"]
