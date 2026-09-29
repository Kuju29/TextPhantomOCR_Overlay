"""Legacy public POST /translate: reject bad caps before enqueue and pace with TP_RATE_GATE=0."""

import asyncio
from dataclasses import replace
import sys
import time
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from backend.ai.rategate import RateGate
from backend.config import settings
from backend.jobs.queue import JobQueue
from backend.main import app


async def main():
    processed = []

    def process(payload):
        processed.append(time.monotonic())
        return {"Ai": {"translations": []}}

    queue = JobQueue(process)
    queue._ai_workers = queue._direct_workers = 1
    gate = RateGate()
    body = {
        "mode": "lens_text", "source": "ai", "lang": "th",
        "ai": {"provider": "huggingface", "model": "fixture", "api_key": "KEY_FIXTURE",
               "base_url": "https://router.huggingface.co/v1"},
    }
    without_automatic_gate = replace(settings, rate_gate_enabled=False)
    with patch("backend.jobs.queue.rate_gate", gate), \
         patch("backend.jobs.queue.settings", without_automatic_gate), \
         patch("backend.ai.rategate.settings", without_automatic_gate):
        app.state.job_queue = queue
        queue.start()
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url="http://localhost") as client:
                for invalid_rate in (
                    {"enabled": True, "rpm": 600, "burst": "Infinity"},
                    {"enabled": True, "rpm": 0, "burst": 1},
                    {"enabled": "tru", "rpm": 600, "burst": 1},
                    {"rpm": 600, "burst": 1},
                    [],
                ):
                    response = await client.post("/translate", json={**body, "rate": invalid_rate})
                    assert response.status_code == 400, (invalid_rate, response.text)
                    assert response.json()["detail"]["code"] == "invalid_manual_rate_cap"
                    assert not queue._jobs, "Invalid legacy cap must not create a queued job"

                rate = {"enabled": True, "rpm": 600, "burst": 1}
                first = await client.post("/translate", json={**body, "rate": rate})
                second = await client.post("/translate", json={**body, "rate": rate})
                assert first.status_code == second.status_code == 200
                ids = [first.json()["id"], second.json()["id"]]
                for _ in range(100):
                    if all(queue._jobs[identifier]["status"] in ("done", "error") for identifier in ids):
                        break
                    await asyncio.sleep(.02)
                assert all(queue._jobs[identifier]["status"] == "done" for identifier in ids), ids
                assert len(processed) == 2 and processed[1] - processed[0] >= .065, processed
                assert not any(task.done() for task in queue._tasks), "Legacy workers must remain alive"
        finally:
            await queue.shutdown()


asyncio.run(main())
print("PASS public legacy rate cap: malformed 400 before enqueue; explicit 600 RPM paces with TP_RATE_GATE=0")
