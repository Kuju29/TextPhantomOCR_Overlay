"""Real API admission/Conversation ownership; blocked synthetic provider only.

The executor deliberately ignores cooperative cancellation until released. This
models a network call whose outer HTTP task has gone away while its worker is
still alive. No external provider, wallet, or persistent customer data is used.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace as NS
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "api"
if not API.is_dir():
    API = ROOT / "source" / "TextPhantom" / "api"
sys.path.insert(0, str(API))

from backend.application.ai_translation import provider_execution
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation_paths.mode import descriptor
from backend.ai.translation_paths.store import current
from backend.jobs.admission import AdmissionGate


async def scenario(*, conversation=False, unlimited=False):
    gate = AdmissionGate(1)
    executor = ThreadPoolExecutor(2)
    entered_a, entered_b, release = (threading.Event() for _ in range(3))
    lock = threading.Lock()
    alive = peak = 0
    cancellation_seen, leases = [], []

    def translate(text, lang, cfg, **kwargs):
        nonlocal alive, peak
        with lock:
            alive += 1
            peak = max(peak, alive)
        leases.append(current())
        (entered_a if text == "A" else entered_b).set()
        try:
            assert release.wait(3), "Synthetic worker was not released"
            cancellation_seen.append((text, kwargs["cancel_check"]()))
            return {"meta": {}}
        finally:
            with lock:
                alive -= 1

    def context(name):
        ai = AiConfig(
            api_key="synthetic",
            provider="huggingface",
            model="fixture",
            translation_mode="conversation" if conversation else "independent",
            conversation=descriptor(
                {"documentId": "same-document"},
                context={"tp_tab_session": "same-owner"},
            ),
        )
        return NS(
            trace_id="",
            payload={"operationId": name},
            marked=name,
            target_lang="th",
            config=ai,
            request=NS(app=NS(state=NS(ai_admission_gate=gate, ai_executor=executor))),
            identity=name,
            correlation={},
            resolved_provider="huggingface",
            rate={"enabled": False},
            unlimited=unlimited,
        )

    tasks = []
    try:
        with patch.object(provider_execution, "translate", side_effect=translate):
            first = asyncio.create_task(provider_execution.run(context("A"), rate_wait_ms=0))
            tasks.append(first)
            assert await asyncio.to_thread(entered_a.wait, 1)
            first.cancel()
            await asyncio.sleep(0.02)
            first.cancel()  # Repeated disconnect/shutdown cancellation is safe.
            await asyncio.sleep(0.02)
            assert not first.done(), "Outer task released a still-running worker"
            if not unlimited:
                assert gate.stats().running == 1
            if conversation:
                lease = leases[0]
                assert lease.store._rows[lease.key]["active"] == lease.token

            second = asyncio.create_task(provider_execution.run(context("B"), rate_wait_ms=0))
            tasks.append(second)
            await asyncio.sleep(0.15)
            assert not entered_b.is_set(), "Second generation overlapped cancelled worker"
            assert peak == 1
            release.set()
            outcomes = await asyncio.gather(*tasks, return_exceptions=True)
            assert isinstance(outcomes[0], asyncio.CancelledError)
            assert not isinstance(outcomes[1], BaseException), outcomes[1]
            assert entered_b.is_set()
            assert peak == 1
            assert cancellation_seen == [("A", True), ("B", False)], cancellation_seen
            assert gate.stats().running == 0
            if conversation:
                assert leases[-1].store._rows[leases[-1].key]["active"] is None
            return {
                "mode": "conversation" if conversation else "independent",
                "unlimited": unlimited,
                "repeated_cancel": "passed",
                "provider_peak": peak,
                "gate_running_after_completion": gate.stats().running,
                "conversation_lease": "held_until_worker_exit" if conversation else "not_used",
            }
    finally:
        release.set()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        executor.shutdown(wait=True)


async def main():
    with tempfile.TemporaryDirectory() as temporary, patch.dict(
        os.environ,
        {"TP_CONVERSATION_STATE_FILE": temporary + "/synthetic", "TP_AI_WIRE_TRACE": "0"},
    ):
        for options in ({}, {"conversation": True}, {"conversation": True, "unlimited": True}):
            print(await scenario(**options))


if __name__ == "__main__":
    asyncio.run(main())
