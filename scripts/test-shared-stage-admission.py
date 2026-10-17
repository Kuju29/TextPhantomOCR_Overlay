"""Regression proof for shared, non-monopolising API stage admission."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from backend.jobs.admission import AdmissionGate, identity_of
from backend.jobs.queue import FairIdentityQueue, JobQueue, _fair_stage_identity
from backend.jobs import stage_admission


def check_identity() -> None:
    key = "same-server-key"
    a = identity_of({"context": {"tp_tab_session": "A"}, "ai": {"api_key": key}})
    b = identity_of({"context": {"tp_tab_session": "B"}, "ai": {"api_key": key}})
    assert a != b and a.startswith("s:") and b.startswith("s:"), (a, b)
    # Legacy transport must join the SAME stage bucket when a modern tab session
    # is present, while truly old clients without a session keep their opaque
    # HTTP caller owner rather than collapsing onto a shared server key.
    assert _fair_stage_identity({"context": {"tp_tab_session": "A"}, "ai": {"api_key": key}}, "o:legacy-a") == a
    assert _fair_stage_identity({"context": {"tp_tab_session": "B"}, "ai": {"api_key": key}}, "o:legacy-b") == b
    assert _fair_stage_identity({"ai": {"api_key": key}}, "o:legacy-a") == "o:legacy-a"
    assert _fair_stage_identity({"ai": {"api_key": key}}, "o:legacy-b") == "o:legacy-b"


async def drain(gate) -> None:
    for owner, count in list(gate._running_by.items()):
        for _ in range(count):
            gate.release(owner)
    await asyncio.sleep(0)


async def check_full_capacity_and_rebalance() -> None:
    gate = AdmissionGate(15)
    # One user may consume the complete road when alone.
    for _ in range(15):
        await gate.acquire("A")
    assert gate.stats().running == 15
    assert gate.stats().share == 15

    # New users queue without preempting A. As A returns slots, the waiting
    # identities with the fewest running slots enter first (max-min fair).
    b = asyncio.create_task(gate.acquire("B"))
    c = asyncio.create_task(gate.acquire("C"))
    a_more = [asyncio.create_task(gate.acquire("A")) for _ in range(10)]
    await asyncio.sleep(0)
    assert gate.stats().waiting == 12
    gate.release("A")
    gate.release("A")
    await asyncio.wait_for(asyncio.gather(b, c), 1)
    assert gate._running_by == {"A": 13, "B": 1, "C": 1}, gate._running_by
    assert gate.stats().share == 5  # ceil(15/3), informational
    for t in a_more:
        t.cancel()
    await asyncio.gather(*a_more, return_exceptions=True)
    await drain(gate)
    assert gate.invariants()["consistent"] and gate.stats().running == 0


async def check_remainder_capacity() -> None:
    gate = AdmissionGate(15)
    # Four users each queueing more than 15 pages converge to 4/4/4/3 of the
    # 15 slots -- every physical slot stays in use.
    for _ in range(15):
        await gate.acquire("A")
    waiters = [asyncio.create_task(gate.acquire(owner)) for owner in "BCD" for _ in range(10)]
    waiters += [asyncio.create_task(gate.acquire("A")) for _ in range(10)]
    await asyncio.sleep(0)
    for _ in range(11):  # A's old work finishes slot by slot
        gate.release("A")
    await asyncio.sleep(0)
    counts = sorted(gate._running_by.values(), reverse=True)
    assert gate.stats().running == 15, gate.stats().as_dict()
    assert counts == [4, 4, 4, 3], (counts, gate._running_by)
    for t in waiters:
        t.cancel()
    await asyncio.gather(*waiters, return_exceptions=True)
    await drain(gate)


async def check_waiters_are_never_count_limited() -> None:
    gate = AdmissionGate(15)
    for _ in range(15):
        await gate.acquire("A")
    # The former 8-waiter cushion is gone: 500 waiters queue, none rejected.
    waiters = [asyncio.create_task(gate.acquire("A")) for _ in range(500)]
    await asyncio.sleep(0)
    assert gate.stats().waiting == 500 and not any(t.done() for t in waiters)
    newcomer = asyncio.create_task(gate.acquire("B"))
    await asyncio.sleep(0)
    gate.release("A")
    await asyncio.wait_for(newcomer, 1)
    assert gate._running_by.get("B") == 1
    for t in waiters:
        t.cancel()
    await asyncio.gather(*waiters, return_exceptions=True)
    await drain(gate)
    assert gate.invariants()["consistent"]


async def check_stage_bridge_is_shared() -> None:
    lens = AdmissionGate(2)
    grouping = AdmissionGate(2)
    ai = AdmissionGate(2)
    stage_admission.configure(asyncio.get_running_loop(), lens=lens, grouping=grouping, ai=ai)
    # Avoid sharing asyncio primitives across threads: use threading events in
    # the worker and inspect the shared gate from the owning event loop.
    import threading
    started = threading.Event()
    stop = threading.Event()
    def work() -> None:
        with stage_admission.stage_slot("lens", "legacy-B"):
            started.set()
            stop.wait(1)

    await lens.acquire("extension-A")
    task = asyncio.create_task(asyncio.to_thread(work))
    for _ in range(100):
        if started.is_set():
            break
        await asyncio.sleep(0.005)
    assert started.is_set(), "legacy worker never acquired the shared Lens gate"
    assert lens.stats().running == 2, lens.stats().as_dict()

    third = asyncio.create_task(lens.acquire("runsapi-C"))
    await asyncio.sleep(0)
    assert not third.done() and lens.stats().waiting == 1
    lens.release("extension-A")
    await asyncio.wait_for(third, 1)
    assert lens.stats().running == 2, lens.stats().as_dict()

    lens.release("runsapi-C")
    stop.set()
    await task
    assert lens.stats().running == 0, lens.stats().as_dict()
    stage_admission.clear()


async def check_legacy_processor_receives_owner() -> None:
    seen = []
    def processor(payload, *, admission_identity=None):
        seen.append(admission_identity)
        return {"ok": True}
    queue = JobQueue(processor)
    try:
        result = await queue._run_processor({}, admission_identity="owner-A")
        assert result == {"ok": True}
        assert seen == ["owner-A"], seen
    finally:
        queue._executor.shutdown(wait=True, cancel_futures=True)


async def check_legacy_fair_queue() -> None:
    q = FairIdentityQueue(maxsize=20)
    for i in range(4):
        q.put_nowait((f"A{i}", {"n": i}, "A"))
    q.put_nowait(("B0", {}, "B"))
    q.put_nowait(("C0", {}, "C"))
    order = []
    while not q.empty():
        job_id, _payload, owner = await q.get()
        order.append((job_id, owner))
        q.task_done()
    assert [owner for _, owner in order[:5]] == ["A", "B", "C", "A", "A"], order


async def main() -> None:
    check_identity()
    await check_full_capacity_and_rebalance()
    await check_remainder_capacity()
    await check_waiters_are_never_count_limited()
    await check_stage_bridge_is_shared()
    await check_legacy_processor_receives_owner()
    await check_legacy_fair_queue()
    print("shared stage admission: PASS")


if __name__ == "__main__":
    asyncio.run(main())
