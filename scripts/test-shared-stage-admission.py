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


async def check_full_capacity_and_rebalance() -> None:
    gate = AdmissionGate(15, max_waiters=8, max_wait_sec=1)
    # One user may consume the complete road when alone.
    for _ in range(15):
        await gate.acquire("A")
    assert gate.stats().running == 15
    assert gate.stats().share == 15

    # New users queue without preempting A. As A returns slots, the oldest fair
    # users enter immediately; the active share shrinks automatically.
    b = asyncio.create_task(gate.acquire("B"))
    c = asyncio.create_task(gate.acquire("C"))
    await asyncio.sleep(0)
    assert gate.stats().waiting == 2
    gate.release("A")
    await asyncio.wait_for(b, 1)
    gate.release("A")
    await asyncio.wait_for(c, 1)
    assert gate.stats().running == 15
    assert gate.stats().share == 5  # ceil(15/3)

    # Free enough of A's old non-preempted work for B/C to grow. The gate must
    # keep using all 15 physical slots rather than floor-dividing and wasting.
    for _ in range(8):
        gate.release("A")
    admitted = []
    for owner in ("B", "C") * 4:
        if gate._may_run(owner):  # exact production predicate; no fake scheduler
            await gate.acquire(owner)
            admitted.append(owner)
    assert gate.stats().running == 15, gate.stats().as_dict()
    assert all(gate._running_by.get(owner, 0) <= 5 for owner in ("A", "B", "C"))

    # Drain test state.
    for owner, count in list(gate._running_by.items()):
        for _ in range(count):
            gate.release(owner)


async def check_remainder_capacity() -> None:
    gate = AdmissionGate(15, max_waiters=8, max_wait_sec=1)
    # Four active users should be able to consume 15 slots as 4/4/4/3, not 12.
    owners = ["A", "B", "C", "D"]
    progress = True
    while gate.stats().running < 15 and progress:
        progress = False
        for owner in owners:
            if gate._may_run(owner):
                await gate.acquire(owner)
                progress = True
                if gate.stats().running == 15:
                    break
    counts = sorted(gate._running_by.values(), reverse=True)
    assert gate.stats().running == 15, gate.stats().as_dict()
    assert counts == [4, 4, 4, 3], counts




async def check_waiter_reservation_for_new_user() -> None:
    gate = AdmissionGate(15, max_waiters=8, max_wait_sec=0.05)
    for _ in range(15):
        await gate.acquire("A")
    # A may borrow all running slots, but it may not consume the entire small
    # server-side wait cushion. The browser owns A's large backlog.
    waiters = [asyncio.create_task(gate.acquire("A")) for _ in range(4)]
    await asyncio.sleep(0)
    assert gate.stats().waiting == 4, gate.stats().as_dict()
    try:
        await gate.acquire("A")
    except Exception as exc:
        assert "server at capacity" in str(exc)
    else:
        raise AssertionError("A unexpectedly monopolised all waiters")

    newcomer = asyncio.create_task(gate.acquire("B"))
    await asyncio.sleep(0)
    assert gate.stats().waiting == 5, gate.stats().as_dict()
    gate.release("A")
    await asyncio.wait_for(newcomer, 1)
    assert gate._running_by.get("B") == 1

    for task in waiters:
        task.cancel()
    await asyncio.gather(*waiters, return_exceptions=True)
    for owner, count in list(gate._running_by.items()):
        for _ in range(count):
            gate.release(owner)




async def check_stage_bridge_is_shared() -> None:
    lens = AdmissionGate(2, max_waiters=2, max_wait_sec=1)
    grouping = AdmissionGate(2, max_waiters=2, max_wait_sec=1)
    ai = AdmissionGate(2, max_waiters=2, max_wait_sec=1)
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
    await check_waiter_reservation_for_new_user()
    await check_stage_bridge_is_shared()
    await check_legacy_processor_receives_owner()
    await check_legacy_fair_queue()
    print("shared stage admission: PASS")


if __name__ == "__main__":
    asyncio.run(main())
