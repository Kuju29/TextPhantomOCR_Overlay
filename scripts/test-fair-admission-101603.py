"""2026.10.16.3 — fair, work-conserving admission with no waiter count cap.

Owner's rule: each kind of work has its own pipe; one user alone gets the full
pipe; with two or more users the pipe is split so one user cannot hold it all;
the waiting queue is never limited by a count of waiters and work is never
dropped because a queue is "full". Memory is the only bound (503 server_busy
+ Retry-After, which clients retry). Waiting holds no worker thread, a client
that leaves takes its waiter with it, and nothing leaks on any outcome.
"""
from __future__ import annotations

import asyncio
import os
import socket
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import tp_api_harness as harness  # noqa: E402

# A configured trusted reverse proxy for the whole process (10.9.9.9), so the
# "behind a trusted proxy" path runs through the app's real ProxyHeaders setup.
harness.prepare_env(TP_TRUSTED_PROXY_IPS="10.9.9.9")

import httpx  # noqa: E402

from backend.jobs import admission as adm  # noqa: E402
from backend.jobs.admission import (  # noqa: E402
    AdmissionCancelled, AdmissionGate, MemoryBudgetExceeded, RequestOwner,
    bind_request_owner, fair_key, reset_request_owner, waiting_bytes,
)


def run(coro):
    return asyncio.run(coro)


async def drain(gate: AdmissionGate) -> None:
    for owner, count in list(gate._running_by.items()):
        for _ in range(count):
            gate.release(owner)
    await asyncio.sleep(0)


class GateFairness(unittest.TestCase):
    def test_one_identity_alone_gets_every_lens_slot(self):
        async def go():
            gate = AdmissionGate(8, name="lens")
            for _ in range(8):
                self.assertEqual((await gate.acquire("A")).wait_ms, 0.0)
            self.assertEqual(gate.stats().running, 8)
            more = [asyncio.create_task(gate.acquire("A")) for _ in range(20)]
            await asyncio.sleep(0)
            # Work-conserving: every freed slot goes straight back to A.
            for _ in range(8):
                gate.release("A")
            await asyncio.sleep(0)
            self.assertEqual(gate._running_by, {"A": 8})
            for t in more:
                t.cancel()
            await asyncio.gather(*more, return_exceptions=True)
            await drain(gate)
            self.assertTrue(gate.invariants()["consistent"])
        run(go())

    def test_two_identities_alternate_fifo_within_each(self):
        async def go():
            gate = AdmissionGate(1)
            order = []
            async def job(owner, n):
                await gate.acquire(owner)
                order.append(f"{owner}{n}")
                await asyncio.sleep(0)
                gate.release(owner)
            await gate.acquire("A")  # A0 is running
            tasks = [asyncio.create_task(job("A", n)) for n in range(1, 6)]
            tasks += [asyncio.create_task(job("B", n)) for n in range(1, 6)]
            await asyncio.sleep(0)
            gate.release("A")
            await asyncio.wait_for(asyncio.gather(*tasks), 5)
            self.assertEqual(order, ["B1", "A1", "B2", "A2", "B3", "A3", "B4", "A4", "B5", "A5"])
        run(go())

    def test_late_one_page_user_served_within_one_slot_turn_of_78_burst(self):
        async def go():
            gate = AdmissionGate(8, name="lens")
            turn = 0.08
            done = {}
            async def page(owner, n):
                t0 = time.perf_counter()
                await gate.acquire(owner)
                try:
                    await asyncio.sleep(turn)
                finally:
                    gate.release(owner, run_sec=turn)
                done[(owner, n)] = time.perf_counter() - t0
            burst = [asyncio.create_task(page("burst", n)) for n in range(78)]
            await asyncio.sleep(2.5 * turn)
            late = asyncio.create_task(page("late", 0))
            await asyncio.wait_for(asyncio.gather(late, *burst), 10)
            late_latency = done[("late", 0)]
            # Waits at most one slot turn, then runs one turn.
            self.assertLess(late_latency, 2 * turn + 0.05, late_latency)
            self.assertGreater(max(v for (o, _), v in done.items() if o == "burst"), 9 * turn)
            self.assertTrue(gate.invariants()["consistent"] and gate.stats().running == 0)
        run(go())

    def test_500_queued_items_never_rejected(self):
        async def go():
            gate = AdmissionGate(8)
            async def page(owner):
                await gate.acquire(owner)
                await asyncio.sleep(0.001)
                gate.release(owner)
                return True
            results = await asyncio.wait_for(asyncio.gather(
                *(page("A" if i % 5 else f"U{i}") for i in range(500))), 30)
            self.assertEqual(results.count(True), 500)
            inv = gate.invariants()
            self.assertEqual((inv["running"], inv["waiting"], inv["staleServed"]), (0, 0, 0))
            self.assertEqual(waiting_bytes.total, 0)
        run(go())

    def test_cancel_check_and_task_cancel_remove_the_waiter(self):
        async def go():
            gate = AdmissionGate(1)
            await gate.acquire("A")
            gone = threading.Event()
            waiter = asyncio.create_task(gate.acquire("B", cancel_check=gone.is_set, nbytes=1000))
            cancelled = asyncio.create_task(gate.acquire("C", nbytes=500))
            await asyncio.sleep(0.05)
            self.assertEqual(gate.stats().waiting, 2)
            self.assertEqual(waiting_bytes.total, 1500)
            gone.set()
            with self.assertRaises(AdmissionCancelled):
                await asyncio.wait_for(waiter, 2)
            cancelled.cancel()
            await asyncio.gather(cancelled, return_exceptions=True)
            self.assertEqual(gate.stats().waiting, 0)
            self.assertEqual(waiting_bytes.total, 0)
            gate.release("A")
            self.assertEqual(gate.stats().running, 0)  # no slot handed to a gone waiter
            self.assertEqual(gate.invariants()["staleServed"], 0)
        run(go())

    def test_grant_racing_cancellation_is_handed_on_not_leaked(self):
        async def go():
            gate = AdmissionGate(1)
            await gate.acquire("A")
            b = asyncio.create_task(gate.acquire("B"))
            c = asyncio.create_task(gate.acquire("C"))
            await asyncio.sleep(0)
            gate.release("A")      # grants B synchronously ...
            b.cancel()             # ... and B's task is cancelled in the same tick
            await asyncio.gather(b, return_exceptions=True)
            await asyncio.wait_for(c, 1)
            self.assertEqual(gate._running_by, {"C": 1})
            gate.release("C")
            self.assertTrue(gate.invariants()["consistent"] and gate.stats().running == 0)
        run(go())

    def test_memory_guard_is_the_only_rejection(self):
        async def go():
            from backend.jobs import admission as module
            with patch.object(module.WaitingBytes, "limits", staticmethod(lambda: (10_000, 4_000))):
                gate = AdmissionGate(1)
                await gate.acquire("A")
                # A alone may go past its 4 000-byte share while one more share
                # of the budget stays free (work-conserving) ...
                a1 = asyncio.create_task(gate.acquire("A", nbytes=5_000))
                await asyncio.sleep(0)
                self.assertEqual(waiting_bytes.total, 5_000)
                # ... not into the last share, which stays for others ...
                with self.assertRaises(MemoryBudgetExceeded):
                    await gate.acquire("A", nbytes=2_000)
                b1 = asyncio.create_task(gate.acquire("B", nbytes=3_000))
                await asyncio.sleep(0)
                self.assertEqual(waiting_bytes.total, 8_000)
                # ... and the total is a hard memory bound for everybody.
                with self.assertRaises(MemoryBudgetExceeded) as caught:
                    await gate.acquire("C", nbytes=3_000)
                self.assertGreaterEqual(caught.exception.retry_after_sec, 1)
                self.assertEqual(gate.stats().waiting, 2)  # rejected ones never queued
                for t in (a1, b1):
                    t.cancel()
                await asyncio.gather(a1, b1, return_exceptions=True)
                gate.release("A")
                self.assertEqual(waiting_bytes.total, 0)
                self.assertEqual(gate.stats().running, 0)
        run(go())


class FairKey(unittest.TestCase):
    def test_install_beats_tab_beats_ip_beats_key_hash(self):
        self.assertEqual(fair_key("s:tab1"), "s:tab1")  # no request: unchanged
        token = bind_request_owner(RequestOwner(install="install:x", ip="ip:y", auth="auth:z"))
        try:
            self.assertEqual(fair_key("s:tab1"), "install:x")
        finally:
            reset_request_owner(token)
        token = bind_request_owner(RequestOwner(ip="ip:y", auth="auth:z"))
        try:
            self.assertEqual(fair_key("s:tab1"), "s:tab1")
            self.assertEqual(fair_key("k:keyhash"), "ip:y")
            self.assertEqual(fair_key("anon"), "ip:y")
        finally:
            reset_request_owner(token)
        token = bind_request_owner(RequestOwner(auth="auth:z"))
        try:
            self.assertEqual(fair_key("k:keyhash"), "k:keyhash")
            self.assertEqual(fair_key("anon"), "auth:z")
        finally:
            reset_request_owner(token)


def _scope(peer, headers=()):
    return {"type": "http", "client": (peer, 1234),
            "headers": [(k.encode(), v.encode()) for k, v in headers]}


class ClientAddress(unittest.TestCase):
    """Fairness by address works on any hosting with no configuration."""

    def setUp(self):
        from backend.api import fairness
        self.fairness = fairness
        self.env = patch.dict(os.environ, {}, clear=False)
        self.env.start()
        for name in ("TP_FAIRNESS_FORWARDED", "TP_FAIRNESS_FORWARDED_HEADER", "TP_FAIRNESS_FORWARDED_HOPS"):
            os.environ.pop(name, None)
        self.addCleanup(self.env.stop)

    def test_direct_public_client_ignores_spoofed_forwarded_for(self):
        ip = self.fairness.fairness_client_ip(_scope("8.8.4.4", [("x-forwarded-for", "1.2.3.4")]))
        self.assertEqual(ip, "8.8.4.4")

    def test_localhost_and_lan_clients_need_no_configuration(self):
        self.assertEqual(self.fairness.fairness_client_ip(_scope("127.0.0.1")), "127.0.0.1")
        self.assertEqual(self.fairness.fairness_client_ip(_scope("192.168.1.20")), "192.168.1.20")

    def test_local_reverse_proxy_uses_the_address_it_appended(self):
        scope = _scope("127.0.0.1", [("x-forwarded-for", "6.6.6.6, 198.51.100.7")])
        self.assertEqual(self.fairness.fairness_client_ip(scope), "198.51.100.7")
        os.environ["TP_FAIRNESS_FORWARDED"] = "off"
        self.assertEqual(self.fairness.fairness_client_ip(scope), "127.0.0.1")
        os.environ["TP_FAIRNESS_FORWARDED"] = "private"
        os.environ["TP_FAIRNESS_FORWARDED_HEADER"] = "cf-connecting-ip"
        scope = _scope("10.0.0.2", [("cf-connecting-ip", "198.51.100.9")])
        self.assertEqual(self.fairness.fairness_client_ip(scope), "198.51.100.9")

    def test_configured_trusted_proxy_through_uvicorn_proxy_middleware(self):
        from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
        seen = []
        async def app(scope, receive, send):
            seen.append(self.fairness.request_owner(scope).ip)
        mw = ProxyHeadersMiddleware(app, trusted_hosts=["10.9.9.9"])
        async def go():
            async def receive():
                return {"type": "http.request", "body": b""}
            async def send(_m):
                pass
            for peer in ("10.9.9.9", "1.0.0.1"):
                await mw(_scope(peer, [("x-forwarded-for", "9.9.9.9")]), receive, send)
        with patch("backend.paid_center.trusted_proxy_hosts", lambda: ["10.9.9.9"]):
            run(go())
        # Behind the trusted proxy: the forwarded client. Direct public peer:
        # itself (its forwarded header is not believed).
        self.assertEqual(seen[0], self.fairness._opaque("ip", "9.9.9.9"))
        self.assertEqual(seen[1], self.fairness._opaque("ip", "1.0.0.1"))


class AddressFairnessHttp(unittest.TestCase):
    """The fair split works by client address when a request carries neither
    an install id nor a tab session -- directly exposed and behind a proxy."""

    def setUp(self):
        from backend import main
        from backend.lens import client as lens_client, cookie
        self.main = main
        self.order = []
        self.lock = threading.Lock()
        def fetch(path, lang, firebase_url=None):
            time.sleep(0.05)
            return {"originalParagraphs": [], "translatedParagraphs": [], "originalTextFull": "",
                    "translatedTextFull": "", "imageUrl": None}
        self.patches = [patch.object(lens_client, "fetch_lens_data", fetch),
                        patch.object(cookie, "configured", lambda *a, **k: True),
                        patch.object(main.app.state, "admission_gate", AdmissionGate(1, name="lens"))]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.gate = main.app.state.admission_gate
        real_acquire = self.gate.acquire
        async def acquire(key, **kw):
            result = await real_acquire(key, **kw)
            with self.lock:
                self.order.append(key)
            return result
        self.gate.acquire = acquire
        import base64
        self.jpeg = base64.b64decode(harness.jpeg_data_uri(7).split(",", 1)[1])

    def _round(self, users):
        """users: list of (peer_ip, extra_headers); 4 anonymous pages each, sent user by user."""
        async def go():
            clients = [httpx.AsyncClient(transport=httpx.ASGITransport(app=self.main.app, client=(peer, 5000)),
                                         base_url="http://api", headers=headers) for peer, headers in users]
            try:
                async def page(c):
                    return await c.post("/v2/engine/runsextension/lens/raw",
                                        files={"image": ("p.jpg", self.jpeg, "image/jpeg")},
                                        data={"lang": "th", "tp_tab_session": ""})
                held = await self.gate.acquire("holder")  # everybody queues behind one slot
                tasks = []
                for c in clients:
                    tasks += [asyncio.create_task(page(c)) for _ in range(4)]
                    await asyncio.sleep(0.02)
                self.gate.release("holder")
                del held
                return await asyncio.gather(*tasks)
            finally:
                for c in clients:
                    await c.aclose()
        responses = run(go())
        self.assertTrue(all(r.status_code == 200 for r in responses), [r.text[:200] for r in responses])
        keys = [k for k in self.order if k != "holder"]
        self.order.clear()
        return keys

    def test_direct_clients_by_ip_alternate(self):
        keys = self._round([("8.8.4.4", {"X-Forwarded-For": "1.1.1.1"}), ("1.0.0.1", {})])
        self.assertEqual(len(set(keys)), 2, keys)  # the spoofed header did not merge or split them
        self.assertEqual(keys[:4], [keys[0], keys[1], keys[0], keys[1]], keys)

    def test_clients_behind_configured_trusted_proxy_alternate(self):
        keys = self._round([("10.9.9.9", {"X-Forwarded-For": "9.9.9.9"}),
                            ("10.9.9.9", {"X-Forwarded-For": "8.8.8.8"})])
        self.assertEqual(len(set(keys)), 2, keys)
        self.assertEqual(keys[:4], [keys[0], keys[1], keys[0], keys[1]], keys)

    def test_clients_behind_unconfigured_local_proxy_alternate(self):
        keys = self._round([("127.0.0.1", {"X-Forwarded-For": "9.9.9.9"}),
                            ("127.0.0.1", {"X-Forwarded-For": "8.8.8.8"})])
        self.assertEqual(len(set(keys)), 2, keys)
        self.assertEqual(keys[:4], [keys[0], keys[1], keys[0], keys[1]], keys)

    def test_install_id_wins_over_address(self):
        same_ip = "8.8.4.4"
        keys = self._round([(same_ip, {"X-TP-Install": "a" * 32}), (same_ip, {"X-TP-Install": "b" * 32})])
        self.assertEqual(len(set(keys)), 2, keys)
        self.assertTrue(all(k.startswith("install:") for k in keys))


class LiveServer(unittest.TestCase):
    """Real uvicorn + real routes; Lens stubbed."""

    @classmethod
    def setUpClass(cls):
        cls.server = harness.Server(lens_delay=0.15).__enter__()
        cls.log = harness.EventLog()
        cls.log.install()

    @classmethod
    def tearDownClass(cls):
        cls.server.__exit__(None, None, None)

    def setUp(self):
        self.server.lens.behaviour = None
        self.server.lens.delay = 0.15
        self.server.lens.peak = 0

    def tearDown(self):
        snap = self.server.quiescent()
        self.assertTrue(snap["idle"], snap)

    async def _post(self, client, payload, headers=None):
        return await client.post(self.server.url + "/v2/engine/runsapi/translate", json=payload,
                                 headers={"X-TP-Client-Version": "2026.9.27.26", **(headers or {})})

    def test_burst_never_rejected_peak_lens_8_late_user_fast(self):
        async def go():
            async with httpx.AsyncClient(timeout=120, limits=httpx.Limits(max_connections=200)) as c:
                t0 = time.perf_counter()
                burst = [asyncio.create_task(self._post(c, harness.runsapi_payload(i, session="burst")))
                         for i in range(78)]
                await asyncio.sleep(0.6)
                ls = time.perf_counter()
                late = await self._post(c, harness.runsapi_payload(1000, session="late"))
                late_s = time.perf_counter() - ls
                results = await asyncio.gather(*burst)
                return late, late_s, results, time.perf_counter() - t0
        late, late_s, results, total = run(go())
        self.assertEqual(late.status_code, 200, late.text[:300])
        self.assertEqual([r.status_code for r in results].count(200), 78)
        self.assertLessEqual(self.server.lens.peak, 8)
        self.assertEqual(self.server.lens.peak, 8)
        # One Lens turn (0.15 s) of waiting plus its own turn, with slack.
        self.assertLess(late_s, 0.15 * 2 + 0.5, late_s)
        perf = [e for e in self.log.events("v1.translate") if e.get("lens_queue_position")]
        self.assertTrue(perf, "waiting must be visible in the perf events")
        self.assertTrue(all("lens_wait_ms" in e and "admission_wait_ms" in e for e in perf))

    def test_runsapi_waits_without_holding_pipeline_threads(self):
        executor = self.server.state.pipeline_executor
        before = len(executor._threads)
        self.server.lens.delay = 0.3
        async def go():
            async with httpx.AsyncClient(timeout=120, limits=httpx.Limits(max_connections=200)) as c:
                tasks = [asyncio.create_task(self._post(c, harness.runsapi_payload(2000 + i, session=f"u{i % 3}")))
                         for i in range(60)]
                await asyncio.sleep(0.5)
                lens_waiting = self.server.call_on_loop(lambda: self.server.state.admission_gate.stats().waiting)
                threads_now = len(executor._threads)
                results = await asyncio.gather(*tasks)
                return lens_waiting, threads_now, results
        lens_waiting, threads_now, results = run(go())
        self.assertTrue(all(r.status_code == 200 for r in results))
        self.assertGreater(lens_waiting, 20)
        # 60 requests in flight, Lens limit 8: only Lens holders ever got a
        # pipeline thread (a few more may be finishing their response). The
        # 2026.10.16.2 design parked up to 40 threads in the Lens wait.
        self.assertLessEqual(len(executor._threads), 12, (before, threads_now, len(executor._threads)))

    def test_byte_guard_answers_503_with_retry_after_and_logs(self):
        self.server.lens.delay = 0.4
        from backend.jobs import admission as module
        async def go():
            async with httpx.AsyncClient(timeout=60) as c:
                hold = [asyncio.create_task(self._post(c, harness.runsapi_payload(3000 + i, session="h")))
                        for i in range(8)]
                await asyncio.sleep(0.15)
                with patch.object(module.WaitingBytes, "limits", staticmethod(lambda: (1000, 500))):
                    busy = await self._post(c, harness.runsapi_payload(3100, session="x"))
                await asyncio.gather(*hold)
                return busy
        busy = run(go())
        self.assertEqual(busy.status_code, 503, busy.text[:300])
        detail = busy.json()["detail"]
        self.assertEqual(detail["code"], "server_busy")
        self.assertTrue(detail["retryable"])
        self.assertGreaterEqual(int(busy.headers["retry-after"]), 1)
        self.assertGreater(detail["retryAfterMs"], 0)
        guard = self.log.events("admission.memory_guard")
        self.assertTrue(guard and guard[-1]["code"] == "server_busy" and guard[-1]["status"] == 503)

    def test_disconnected_waiter_leaves_queue_and_logs_499(self):
        self.server.lens.delay = 0.6
        calls_before = self.server.lens.calls
        import json as _json
        async def go():
            async with httpx.AsyncClient(timeout=60) as c:
                hold = [asyncio.create_task(self._post(c, harness.runsapi_payload(4000 + i, session="h")))
                        for i in range(8)]
                await asyncio.sleep(0.1)
                body = _json.dumps(harness.runsapi_payload(4100, session="leaver")).encode()
                sock = socket.create_connection(("127.0.0.1", self.server.port))
                sock.sendall(b"POST /v2/engine/runsapi/translate HTTP/1.1\r\nHost: x\r\n"
                             b"Content-Type: application/json\r\nContent-Length: "
                             + str(len(body)).encode() + b"\r\n\r\n" + body)
                for _ in range(100):
                    waiting = self.server.call_on_loop(lambda: self.server.state.admission_gate.stats().waiting)
                    if waiting:
                        break
                    await asyncio.sleep(0.01)
                self.assertGreaterEqual(waiting, 1)
                sock.close()  # tab closed / client timeout
                for _ in range(100):
                    waiting = self.server.call_on_loop(lambda: self.server.state.admission_gate.stats().waiting)
                    if not waiting:
                        break
                    await asyncio.sleep(0.02)
                left_while_others_run = any(not t.done() for t in hold)
                await asyncio.gather(*hold)
                return waiting, left_while_others_run
        waiting, early = run(go())
        self.assertEqual(waiting, 0)
        self.assertTrue(early, "the gone waiter must leave before the slots free up")
        gone = self.log.events("request.client_disconnected")
        self.assertTrue(any(e["status"] == 499 and e["code"] == "client_disconnected" for e in gone), gone)
        # The gone request never reached Lens: only the 8 holders did.
        self.assertEqual(self.server.lens.calls - calls_before, 8)

    def test_failures_and_hangs_never_block_the_queue(self):
        # Every 5th Lens call fails, every 7th hangs for 1 s (a bounded upstream
        # timeout): the rest of a 3-user burst completes, nobody is rejected,
        # and every counter returns to zero.
        def behaviour(index):
            if index % 5 == 0:
                raise RuntimeError("Lens HTTP 500 (operation=upload)")
            if index % 7 == 0:
                time.sleep(1.0)
        self.server.lens.behaviour = behaviour
        self.server.lens.delay = 0.05
        async def go():
            async with httpx.AsyncClient(timeout=120, limits=httpx.Limits(max_connections=200)) as c:
                tasks = [asyncio.create_task(self._post(c, harness.runsapi_payload(5000 + i, session=f"f{i % 3}")))
                         for i in range(90)]
                return await asyncio.gather(*tasks)
        results = run(go())
        codes = [r.status_code for r in results]
        self.assertNotIn(503, codes)
        self.assertEqual(codes.count(200) + codes.count(502), 90, codes)
        self.assertGreater(codes.count(200), 60)
        self.assertLessEqual(self.server.lens.peak, 8)
        snap = self.server.quiescent()
        self.assertTrue(snap["idle"], snap)
        self.assertEqual(snap["lens"]["running"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
