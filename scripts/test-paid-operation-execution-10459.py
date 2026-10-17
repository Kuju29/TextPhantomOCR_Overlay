"""Independent Paid execution keeps normal fairness/cancellation, with no wallet lock."""
import asyncio
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
from backend.application.ai_translation import provider_execution
from backend.ai.translation.contracts import AiConfig
from backend.ai import content_stream
from backend.jobs.admission import AdmissionGate
from fastapi import HTTPException


def context(shared, name, unlimited=False):
    owner = name[0]
    return NS(trace_id="", payload={"operationId": name}, marked=name, target_lang="th",
              config=AiConfig(api_key="synthetic-" + owner, provider="paid", model="qa/model",
                              translation_mode="independent", thinking="minimum"),
              request=NS(app=NS(state=shared)), identity=owner, correlation={}, resolved_provider="paid",
              rate={"enabled": False}, unlimited=unlimited, unit_count=1,
              requested_route="/synthetic/ai/translate", route_identity={})


async def parallel_case(unlimited=False):
    shared = NS(ai_admission_gate=AdmissionGate(2),
                ai_executor=ThreadPoolExecutor(4))
    started, release = threading.Event(), threading.Event()
    sent = []
    tasks = []
    def translate(text, lang, config, **kwargs):
        sent.append(text)
        if text == "A0":
            started.set()
            assert release.wait(4)
            assert kwargs["cancel_check"]()
        return {"meta": {}}
    try:
        with patch.object(provider_execution, "translate", side_effect=translate):
            first = asyncio.create_task(provider_execution.run(context(shared, "A0", unlimited), rate_wait_ms=0))
            tasks.append(first)
            assert await asyncio.to_thread(started.wait, 1)
            second = await asyncio.wait_for(provider_execution.run(context(shared, "A1", unlimited), rate_wait_ms=0), 1)
            assert second.result == {"meta": {}} and not first.done()
            await asyncio.wait_for(provider_execution.run(context(shared, "B0", unlimited), rate_wait_ms=0), 1)
            first.cancel()
            await asyncio.sleep(0.01)
            first.cancel()
            await asyncio.sleep(0.01)
            assert not first.done(), "Cancellation abandoned a running provider owner"
            if not unlimited:
                assert shared.ai_admission_gate.stats().running == 1
            release.set()
            answer = (await asyncio.wait_for(asyncio.gather(first, return_exceptions=True), 2))[0]
            assert isinstance(answer, asyncio.CancelledError)
            assert sent == ["A0", "A1", "B0"]
            assert not hasattr(shared, "paid_wallet_gate"), "API retained duplicate financial authority"
            if not unlimited:
                assert shared.ai_admission_gate.stats().running == 0
    finally:
        release.set()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        shared.ai_executor.shutdown(wait=True)


async def queued_cancel_case():
    shared = NS(ai_admission_gate=AdmissionGate(2),
                ai_executor=ThreadPoolExecutor(4))
    started = {name: threading.Event() for name in ("A0", "B0")}
    release = threading.Event()
    sent = []
    tasks = []
    def translate(text, lang, config, **kwargs):
        sent.append(text)
        started[text].set()
        assert release.wait(4)
        return {"meta": {}}
    async def queued(cancelled):
        with content_stream.scope(lambda text: None, cancel_event=cancelled):
            return await provider_execution.run(context(shared, "A-queued"), rate_wait_ms=0)
    try:
        with patch.object(provider_execution, "translate", side_effect=translate):
            for name in started:
                tasks.append(asyncio.create_task(provider_execution.run(context(shared, name), rate_wait_ms=0)))
            for event in started.values():
                assert await asyncio.to_thread(event.wait, 1)
            cancelled = asyncio.Event()
            waiting = asyncio.create_task(queued(cancelled))
            tasks.append(waiting)
            await asyncio.sleep(0.01)
            cancelled.set()
            answer = (await asyncio.wait_for(asyncio.gather(waiting, return_exceptions=True), 1))[0]
            assert isinstance(answer, HTTPException), answer
            assert answer.detail["requestDispatched"] is False
            assert answer.detail["providerAttempts"] == answer.detail["generationAttempts"] == 0
            assert "A-queued" not in sent
            release.set()
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 2)
            assert shared.ai_admission_gate.stats().running == 0
    finally:
        release.set()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        shared.ai_executor.shutdown(wait=True)


def test_same_paid_account_can_progress_independently():
    for unlimited in (False, True):
        asyncio.run(parallel_case(unlimited))


def test_cancel_before_shared_admission_never_dispatches():
    asyncio.run(queued_cancel_case())


if __name__ == "__main__":
    test_same_paid_account_can_progress_independently()
    test_cancel_before_shared_admission_never_dispatches()
    print(json.dumps({"passed": True, "sameAccountIndependentProgress": True,
                      "runningCancellationKeepsOwner": True, "queuedCancellationNoDispatch": True,
                      "apiFinancialState": False}))
