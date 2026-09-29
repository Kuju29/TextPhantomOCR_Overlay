"""A Local API owner only enters the rate gate when its own cap is enabled."""
import asyncio
import time
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from backend.ai.rate_policy import manual_rate_policy, rate_bucket_identity
from backend.ai.rategate import rate_gate

identity = {"provider":"lmstudio", "base_url":"http://localhost:1234/v1"}
off = manual_rate_policy({"rate":{"enabled":False,"rpm":600,"burst":1}}, **identity)
on = manual_rate_policy({"rate":{"enabled":True,"rpm":600,"burst":1}}, **identity)
assert off["enabled"] is False and on["enabled"] is True
assert on["mode"] == "manual_local_cap"
low = manual_rate_policy({"rate":{"enabled":True,"rpm":1,"burst":1}}, **identity)
assert rate_bucket_identity(on, base_url=identity["base_url"]) != rate_bucket_identity(low, base_url=identity["base_url"])

async def check():
    args = ("lmstudio", "local-test-manual-rate", rate_bucket_identity(on, base_url=identity["base_url"]))
    extras = dict(session="test", deadline_sec=2, max_waiters=3, rpm_override=600,
                  burst_override=1, manual_local=True)
    await rate_gate.acquire(*args, job_id="one", **extras)
    started = time.monotonic()
    await rate_gate.acquire(*args, job_id="repair", **extras)
    assert time.monotonic() - started >= 0.065, "repair shares the Local model request cap"
    other = time.monotonic()
    await rate_gate.acquire("lmstudio", "local-test-manual-rate",
                            rate_bucket_identity(on, base_url="http://localhost:5555/v1"),
                            job_id="other-endpoint", **extras)
    assert time.monotonic() - other < 0.065

asyncio.run(check())
print("PASS Local runs:API manual request cap by runtime/model")
