"""10489 owner question: does AI think (model capability) lookup have a cache, and
does it collide with translation work?

Simulates 20 concurrent translations for one model through the API's real
capability path (provider_resolution.discovered_model_capabilities ->
refresh_cloud_model_capabilities, as translation/invocation.py calls it) with a
fake catalogue that counts reads and sleeps to widen the race. No network.

Asserts, per provider:
  * paid / cloud (OpenRouter-style adapter list_models): 20 concurrent cold
    translations -> 1 catalogue read; 20 later translations -> 0 (300 s TTL);
  * login (selected_model): 20 concurrent cold translations -> 1 read
    (10489 fix: the Login branch was not coalesced, 20 cold pages = 20 reads);
  * the cache lock is never held during the catalogue read: another scope's
    cache lookup completes while a read is in progress.
"""

from __future__ import annotations

import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.ai import provider_resolution as pr  # noqa: E402
from backend.ai.provider_bootstrap import ensure_provider_registry  # noqa: E402
from backend.ai.provider_contract import ModelListResult  # noqa: E402

N = 20
REASONING = {"reasoning": {"supported": True, "control": "levels", "supported_efforts": ["low", "high"]}}


def translation(provider, base, model, key):
    """The capability part of translation/invocation.py:148-158."""
    fresh, caps = pr.discovered_model_capabilities(provider, base, model, key)
    if provider in {"paid", "login"} and not fresh:
        fresh, caps = pr.refresh_cloud_model_capabilities(provider, base, model, key)
    elif not fresh:
        fresh, caps = pr.refresh_cloud_model_capabilities(provider, base, model, key)
    return fresh, caps


def concurrent(provider, base, model, key):
    start = threading.Barrier(N)

    def one(_):
        start.wait()
        return translation(provider, base, model, key)

    with ThreadPoolExecutor(N) as pool:
        return list(pool.map(one, range(N)))


class Catalogue:
    def __init__(self, delay=0.2):
        self.calls, self.delay, self.lock_free_during_read = 0, delay, None
        self._count = threading.Lock()

    def list_models(self, *, api_key, base_url):
        with self._count:
            self.calls += 1
        # While this read is in progress another scope's cache lookup must not wait.
        probe = threading.Thread(target=lambda: pr.discovered_model_capabilities(
            "openrouter", "https://other.invalid", "x/y", "other-key"))
        began = time.monotonic()
        probe.start()
        probe.join(1.0)
        self.lock_free_during_read = (not probe.is_alive()) and time.monotonic() - began < 0.5
        time.sleep(self.delay)
        return ModelListResult(models=("qa/model",), status="valid", http_status=200,
                               capabilities={"qa/model": dict(REASONING)})


def check_catalogue(provider, base):
    key = f"{provider}-key-10489"
    pr.forget_model_capabilities(provider, base, key)
    fake = Catalogue()
    with patch.object(pr.provider_registry, "require", lambda _p: SimpleNamespace(adapter=fake)):
        results = concurrent(provider, base, "qa/model", key)
        cold = fake.calls
        results += concurrent(provider, base, "qa/model", key)
    assert all(fresh and caps.get("reasoning", {}).get("supported") is True for fresh, caps in results), results[:2]
    assert cold == 1, f"{provider}: {cold} catalogue reads for {N} concurrent cold translations"
    assert fake.calls == 1, f"{provider}: warm translations re-read the catalogue ({fake.calls})"
    assert fake.lock_free_during_read is True, f"{provider}: cache lock held across the catalogue read"
    print(f"{provider}: {N} concurrent cold + {N} warm translations -> {fake.calls} catalogue read; "
          "cache lock free during the read")


def check_login():
    base, key, model = "", "login-key-10489", "session-1/qa-chat"
    pr.forget_model_capabilities("login", base, key)
    calls, guard = [], threading.Lock()
    lock_free = []

    def selected_model(bearer, requested):
        with guard:
            calls.append(requested)
        probe = threading.Thread(target=lambda: pr.discovered_model_capabilities(
            "openrouter", "https://other.invalid", "x/y", "other-key"))
        probe.start()
        probe.join(1.0)
        lock_free.append(not probe.is_alive())
        time.sleep(0.2)
        return {"id": "qa-chat", "model_capabilities": dict(REASONING)}

    with patch("backend.ai.login.login_translation.selected_model", selected_model):
        results = concurrent("login", base, model, key)
        cold = len(calls)
        results += concurrent("login", base, model, key)
    assert all(fresh and caps.get("reasoning", {}).get("supported") is True for fresh, caps in results)
    assert cold == 1, f"login: {cold} selected-model reads for {N} concurrent cold translations"
    assert len(calls) == 1, f"login: warm translations re-read ({len(calls)})"
    assert all(lock_free), "login: cache lock held across the selected-model read"
    # A different exact Login model (new session) is never answered by another one's read.
    other = "session-2/qa-chat"
    with patch("backend.ai.login.login_translation.selected_model", selected_model):
        translation("login", base, other, key)
    assert calls[-1] == other and len(calls) == 2
    print(f"login: {N} concurrent cold + {N} warm translations -> {cold} selected-model read; "
          "a new session's model reads once on its own")


def check_failure_is_not_cached_forever():
    """A failed read is shared by its concurrent followers, never cached as fresh."""
    key = "paid-fail-10489"
    pr.forget_model_capabilities("paid", "", key)
    calls = []

    def failing(*, api_key, base_url):
        calls.append(1)
        time.sleep(0.2)
        return ModelListResult(status="unreachable")

    adapter = SimpleNamespace(list_models=failing)
    with patch.object(pr.provider_registry, "require", lambda _p: SimpleNamespace(adapter=adapter)):
        results = concurrent("paid", "", "qa/model", key)
    assert all(not fresh for fresh, _ in results)
    assert len(calls) == 1, f"paid: {len(calls)} reads for {N} concurrent failed lookups"
    print(f"paid (Center unreachable): {N} concurrent -> {len(calls)} read, result stays 'loading'")


if __name__ == "__main__":
    ensure_provider_registry()
    check_catalogue("paid", "")
    check_catalogue("openrouter", "https://openrouter.ai/api/v1")
    check_login()
    check_failure_is_not_cached_forever()
    print("thinking capability cache 10489: OK")
