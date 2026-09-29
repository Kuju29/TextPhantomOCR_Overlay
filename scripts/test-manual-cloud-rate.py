"""User-pinned RPM applies even to Cloud providers without proactive pacing."""
import asyncio
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from backend.ai.provider_bootstrap import ensure_provider_registry
from backend.ai.provider_registry import provider_registry
from backend.ai.rategate import RateGate
from backend.ai.rate_policy import InvalidManualRatePolicy, manual_rate_policy
from backend.application.ai_translation import rate_admission

ensure_provider_registry(provider_registry)
spec = provider_registry.require("huggingface")
assert not spec.proactive_rate_gate
gate = RateGate()
rate = manual_rate_policy({"rate": {"enabled": True, "rpm": 600, "burst": 1}},
                          provider="huggingface", base_url=spec.default_base_url)
assert rate["enabled"] and not rate["local"]
try:
    manual_rate_policy({"rate":{"enabled":True,"rpm":600,"burst":0}},
                       provider="huggingface",base_url=spec.default_base_url)
    assert False, "Explicit but incomplete cap must fail before provider dispatch"
except InvalidManualRatePolicy as exc:
    assert exc.code == "invalid_manual_rate_cap"
for malformed in ({"rate": []}, {"rate": {"rpm": 30, "burst": 4}},
                  {"rate": {"enabled": "tru", "rpm": 30, "burst": 4}},
                  {"rate": {"enabled": None, "rpm": 30, "burst": 4}}):
    try:
        manual_rate_policy(malformed, provider="huggingface", base_url=spec.default_base_url)
        assert False, f"Malformed cap {malformed} cannot silently become provider-managed"
    except InvalidManualRatePolicy as exc:
        assert exc.code == "invalid_manual_rate_cap"
assert manual_rate_policy({"rate": {"enabled": 1, "rpm": 30, "burst": 4}},
                          provider="huggingface", base_url=spec.default_base_url)["enabled"]
for invalid in ("NaN", "Infinity", "-Infinity"):
    for field in ("rpm", "burst"):
        settings = {"enabled": True, "rpm": 600, "burst": 1}
        settings[field] = invalid
        try:
            manual_rate_policy({"rate": settings}, provider="huggingface",
                               base_url=spec.default_base_url)
            assert False, f"Invalid {field}={invalid} must fail before provider dispatch"
        except InvalidManualRatePolicy as exc:
            assert exc.code == "invalid_manual_rate_cap"
config = SimpleNamespace(base_url=spec.default_base_url, api_key="USER_FIXTURE",
                         model="fixture-model")

async def verify():
    with patch.object(rate_admission, "rate_gate", gate):
        first, _ = await rate_admission.acquire(rate=rate, unlimited=False,
            provider="huggingface", config=config, context={"tp_tab_session": "reader"},
            payload={"operationId": "initial"}, idempotency_key=None)
        assert first["gated"] and first["pinned"] and first["rpm"] == 600, (
            "Manual cap must be visible before initial admission", first)
        started = time.monotonic()
        second, waited = await rate_admission.acquire(rate=rate, unlimited=False,
            provider="huggingface", config=config, context={"tp_tab_session": "reader"},
            payload={"operationId": "repair"}, idempotency_key=None)
        elapsed = time.monotonic() - started
        assert second["gated"] and elapsed >= 0.065 and waited >= 65, (
            "Repair must consume the same HF manual request bucket", second, elapsed, waited)
        state = gate.snapshot("huggingface", config.model, config.api_key, manual_override=True)
        assert state["gated"] and state["pinned"] and state["rpm"] == 600
        started = time.monotonic()
        third, waited = await rate_admission.acquire(rate=rate, unlimited=True,
            provider="huggingface", config=config, context={"tp_tab_session": "reader"},
            payload={"operationId":"trusted-peer"}, idempotency_key=None)
        assert third["gated"] and waited >= 65 and time.monotonic() - started >= 0.065, (
            "Trusted local API callers must still respect their own explicit cap", third, waited)
        no_cap = manual_rate_policy({"rate": {"enabled": False, "rpm": 600}},
                                    provider="huggingface", base_url=spec.default_base_url)
        entry, _ = await rate_admission.acquire(rate=no_cap, unlimited=False,
            provider="huggingface", config=config, context={},
            payload={"operationId": "unlimited-by-user"}, idempotency_key=None)
        assert entry == {}, "Unselected cap must not silently apply"

asyncio.run(verify())
print("PASS HF manual Cloud RPM: initial and repair share a real rate bucket")
