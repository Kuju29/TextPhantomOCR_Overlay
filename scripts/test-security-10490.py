"""Pre-launch security/readiness checks (.10490). Offline: no network, no Center.

1  request-body caps (Content-Length and streamed) + queue byte budget
2  cookie-session Login (Gemini, DeepSeek) disabled on shared deployments
3  the API forwards a client IP to Center only when it is trustworthy
4  no built-in Firebase jar; no cookie poll loop; 5/15/60-minute back-off; prefetch
6  per-identity token bucket, per-identity queue/conversation/repair caps, CORS
7  diagnostic writers default off, also on a Space
8  .gitignore covers runtime state and secrets
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import math
import os
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.api import ingress  # noqa: E402

MiB = 1024 * 1024
CLEAN_ENV = {k: v for k, v in os.environ.items()
             if k not in {"SPACE_ID", "SPACE_HOST", "TP_PUBLIC_DEPLOYMENT", "TP_ALLOW_SHARED_COOKIE_LOGIN",
                          "TP_TRUSTED_PROXY_IPS", "TP_MAX_IMAGE_BODY_BYTES", "TP_MAX_JOB_BODY_BYTES",
                          "TP_MAX_JSON_BODY_BYTES", "TP_IDENTITY_QUOTAS", "TP_IDENTITY_RATE_PER_SEC",
                          "TP_IDENTITY_BURST", "TP_ALLOWED_ORIGINS"}}


def small_app(calls):
    app = FastAPI()

    @app.post("/v1/translate")
    async def translate(payload: dict):
        calls.append(len(json.dumps(payload)))
        return {"ok": True}

    @app.post("/ai/resolve")
    async def resolve(request: Request):
        body = await request.body()
        calls.append(len(body))
        return {"ok": True}

    @app.post("/v1/lens/raw")
    async def lens(request: Request):
        calls.append("lens")
        return {"ok": True}

    app.add_middleware(ingress.IdentityQuotaMiddleware)
    app.add_middleware(ingress.BodyLimitMiddleware)
    return app


class BodyLimits(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"TP_MAX_IMAGE_BODY_BYTES": "4096",
                                           "TP_MAX_JSON_BODY_BYTES": str(64 * 1024),
                                           "TP_IDENTITY_QUOTAS": "0"}, clear=False)
        self.env.start()
        self.calls = []
        self.client = TestClient(small_app(self.calls))

    def tearDown(self):
        self.env.stop()

    def test_defaults_sized_from_largest_accepted_image(self):
        with patch.dict(os.environ, {"TP_MAX_IMAGE_BODY_BYTES": "", "TP_MAX_JSON_BODY_BYTES": ""}):
            b64 = 4 * math.ceil((24 * MiB) / 3)
            self.assertEqual(ingress.image_body_limit(), b64 + 2 * MiB)          # 34 MiB
            self.assertEqual(ingress.job_body_limit(), 2 * b64 + 2 * MiB)        # 66 MiB
            self.assertEqual(ingress.json_body_limit(), 2 * MiB)
            self.assertEqual(ingress.body_limit_for("/v1/lens/raw"), b64 + 2 * MiB)
            self.assertEqual(ingress.body_limit_for("/v1/translate"), 2 * b64 + 2 * MiB)
            self.assertEqual(ingress.body_limit_for("/paid/orders"), 2 * MiB)
            # The largest image the API accepts, as a data URI in a JSON body, fits.
            uri = "data:image/png;base64," + "A" * b64
            self.assertLess(len(json.dumps({"image": {"dataUri": uri}, "ai": {"x": "y" * 4096}})),
                            ingress.image_body_limit())
            both = json.dumps({"src": uri, "imageDataUri": uri, "context": {"page_url": "x" * 4096}})
            self.assertLess(len(both), ingress.job_body_limit())

    def test_declared_length_rejected_before_route_runs(self):
        response = self.client.post("/v1/translate", content=b"{" + b" " * 9000 + b"}",
                                    headers={"content-type": "application/json"})
        self.assertEqual(response.status_code, 413)
        detail = response.json()["detail"]
        self.assertEqual((detail["schema"], detail["code"]), ("tp.error/1", "request_too_large"))
        self.assertEqual(detail["maxBytes"], 8192)  # job route: twice the image cap
        self.assertEqual(self.calls, [])

    def test_streamed_body_rejected_while_reading(self):
        def chunks():
            for _ in range(80):                 # 80 KiB > 64 KiB general cap
                yield b" " * 1024
        response = self.client.post("/ai/resolve", content=chunks(),
                                    headers={"content-type": "application/json"})
        self.assertEqual(response.status_code, 413, response.text)
        self.assertEqual(self.calls, [])

    def test_lying_content_length_cannot_bypass_stream_count(self):
        # The ASGI receive wrapper counts real bytes even if a server let a
        # chunked body through with a small declared length.
        app = small_app(self.calls)
        sent = []

        async def run():
            body = [b'{"a":"' + b"x" * 70000 + b'"}']

            async def receive():
                return {"type": "http.request", "body": body.pop() if body else b"", "more_body": False}

            async def send(message):
                sent.append(message)
            scope = {"type": "http", "method": "POST", "path": "/ai/resolve", "raw_path": b"/ai/resolve",
                     "query_string": b"", "headers": [(b"content-length", b"10"),
                                                      (b"content-type", b"application/json")],
                     "client": ("203.0.113.1", 1), "server": ("t", 80), "scheme": "http",
                     "http_version": "1.1", "root_path": "", "app": app}
            await app(scope, receive, send)
        asyncio.run(run())
        self.assertEqual(sent[0]["status"], 413)

    def test_under_cap_passes_and_invalid_length_is_400(self):
        self.assertEqual(self.client.post("/v1/translate", json={"a": "b"}).status_code, 200)
        response = self.client.post("/ai/resolve", content=b"{}", headers={"content-length": "abc"})
        self.assertEqual(response.status_code, 400)

    def test_real_app_rejects_huge_translate_without_parsing(self):
        from backend import main
        with patch.dict(os.environ, {"TP_MAX_IMAGE_BODY_BYTES": "", "TP_MAX_JSON_BODY_BYTES": ""}):
            client = TestClient(main.app)
            limit = ingress.job_body_limit()
            # Declared length only; the body is never sent or parsed.
            response = client.post("/v1/translate", content=b"{}",
                                   headers={"content-type": "application/json",
                                            "content-length": str(limit + 1)})
            self.assertEqual(response.status_code, 413)
            self.assertEqual(response.json()["detail"]["code"], "request_too_large")


    def test_real_app_streamed_translate_is_413_not_parse_error(self):
        # FastAPI turns non-HTTP exceptions raised while reading the body into a
        # generic 400; the cap must stay a 413 with the canonical error body.
        from backend import main

        def chunks():
            for _ in range(20):
                yield b"A" * 1024
        response = TestClient(main.app).post("/v1/translate", content=chunks(),
                                             headers={"content-type": "application/json"})
        self.assertEqual(response.status_code, 413, response.text)
        self.assertEqual(response.json()["detail"]["code"], "request_too_large")


class QueueBudget(unittest.TestCase):
    def queue(self, **overrides):
        from backend.jobs import queue as queue_mod
        settings = dataclasses.replace(queue_mod.settings, **overrides)
        self.patch = patch.object(queue_mod, "settings", settings)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        return queue_mod, queue_mod.JobQueue(lambda payload: {"ok": True})

    def enqueue(self, q, payload, identity=None, scope="o:a"):
        async def run():
            token = ingress._identity.set(identity)
            try:
                return await q.enqueue(payload, caller_scope=scope)
            finally:
                ingress._identity.reset(token)
        return asyncio.run(run())

    def test_byte_budget_global_and_per_identity(self):
        mod, q = self.queue(max_queue_bytes=3 * MiB, max_queue_bytes_per_identity=2 * MiB,
                            max_queue_per_identity=100)
        image = "data:image/png;base64," + "A" * MiB
        self.enqueue(q, {"imageDataUri": image}, identity="install:a")
        with self.assertRaises(mod.QueueBytesFull):
            self.enqueue(q, {"imageDataUri": image + "A" * MiB}, identity="install:a")
        self.enqueue(q, {"imageDataUri": image}, identity="install:b")
        with self.assertRaises(mod.QueueBytesFull):     # global budget
            self.enqueue(q, {"imageDataUri": image + "A" * (MiB // 2)}, identity="install:c")
        self.assertTrue(issubclass(mod.QueueBytesFull, mod.QueueFull))  # 503 + Retry-After route contract
        # A worker taking the job releases its reservation.
        job_id = next(iter(q._queued_bytes))
        q._queued_bytes.pop(job_id)
        self.enqueue(q, {"imageDataUri": image}, identity="install:c")

    def test_per_identity_job_cap_spans_tab_scopes(self):
        mod, q = self.queue(max_queue_per_identity=2, max_queue_per_caller=200)
        self.enqueue(q, {"src": "https://a/1"}, identity="install:a", scope="o:tab1")
        self.enqueue(q, {"src": "https://a/2"}, identity="install:a", scope="o:tab2")
        with self.assertRaises(mod.CallerQueueFull):
            self.enqueue(q, {"src": "https://a/3"}, identity="install:a", scope="o:tab3")
        self.enqueue(q, {"src": "https://b/1"}, identity="install:b", scope="o:tab9")
        record = q.public_record(next(iter(q._jobs)))
        self.assertNotIn("identity", record)


class CookieLogin(unittest.TestCase):
    def setUp(self):
        from backend.ai.login import login_routes as routes
        from backend.ai.login import login_session_store as store
        from backend.ai.login.endpoint import login_endpoint_session as flows
        self.routes, self.store, self.flows = routes, store, flows
        store.clear(); flows.clear()
        self.auth = patch.object(routes.login_entitlement, "authorize", return_value="fiction-owner")
        self.auth.start()
        self.request = SimpleNamespace(headers={"authorization": "Bearer " + "x" * 48}, state=SimpleNamespace(),
                                       base_url="https://api.example/")

    def tearDown(self):
        self.auth.stop(); self.store.clear(); self.flows.clear()

    def invoke(self, coroutine):
        from fastapi.responses import JSONResponse
        from backend.ai.login.login_provider_contract import LoginError

        async def call(action, *args, **kwargs):
            try:
                return JSONResponse(action())
            except LoginError as exc:
                return self.routes.failure_response(exc)
        async def run():
            return await coroutine
        with patch.object(self.routes, "call", call):
            return asyncio.run(run())

    def rows(self):
        body = json.loads(self.invoke(self.routes.providers(self.request)).body)
        return body, {p["id"]: p for p in body["providers"]}

    def test_space_disables_cookie_providers_with_reason(self):
        env = {**CLEAN_ENV, "SPACE_ID": "owner/textphantom",
               "TP_LOGIN_ENABLED_PROVIDERS": "login_chatgpt,login_claude,login_gemini,login_deepseek"}
        with patch.dict(os.environ, env, clear=True):
            body, rows = self.rows()
            self.assertEqual(body["deployment"], "shared")
            for provider in ("login_gemini", "login_deepseek"):
                self.assertFalse(rows[provider]["available"])
                self.assertFalse(rows[provider]["sign_in_available"])
                self.assertEqual(rows[provider]["reason"], "disabled")  # existing clients: "Disabled"
                self.assertEqual(rows[provider]["disabled_reason"], "shared_deployment_cookie_session")
                self.assertIn("session cookies", rows[provider]["message"])
                start = self.invoke(self.routes.start(provider, self.request))
                self.assertEqual(start.status_code, 409)
                self.assertEqual(json.loads(start.body)["error"]["code"], "login_provider_unavailable")
                body_in = self.routes.EndpointImportInput(
                    flow_id="lgf_" + "a" * 48, state="s" * 16, browser_instance="b" * 48,
                    expected_identity="c" * 64, credentials={"psid": "fictional-cookie-value"})
                imported = self.invoke(self.routes.endpoint_import(provider, body_in, self.request))
                self.assertEqual(imported.status_code, 409)
            self.assertEqual(self.store.owned("fiction-owner"), [])
            for provider in ("login_chatgpt", "login_claude"):
                self.assertNotEqual(rows[provider].get("disabled_reason"), "shared_deployment_cookie_session")

    def test_private_api_and_explicit_opt_in_keep_them(self):
        env = {**CLEAN_ENV, "TP_LOGIN_ENABLED_PROVIDERS": "login_gemini,login_deepseek"}
        with patch.dict(os.environ, env, clear=True):
            body, rows = self.rows()
            self.assertEqual(body["deployment"], "private")
            self.assertNotIn("disabled_reason", rows["login_gemini"])
            self.assertNotEqual(rows["login_gemini"]["reason"], "disabled")
        with patch.dict(os.environ, {**env, "TP_PUBLIC_DEPLOYMENT": "1", "TP_ALLOW_SHARED_COOKIE_LOGIN": "1"},
                        clear=True):
            _, rows = self.rows()
            self.assertNotIn("disabled_reason", rows["login_deepseek"])
        with patch.dict(os.environ, {**env, "SPACE_ID": "x", "TP_PUBLIC_DEPLOYMENT": "0"}, clear=True):
            _, rows = self.rows()
            self.assertNotIn("disabled_reason", rows["login_gemini"])


class GatewayPeer(unittest.TestCase):
    def peer(self, host, env, proxies=""):
        from backend import paid_center
        from backend.api.routes import paid
        settings = dataclasses.replace(paid_center.settings, trusted_proxy_ips=proxies)
        with patch.dict(os.environ, {**CLEAN_ENV, **env}, clear=True), \
                patch.object(paid_center, "settings", settings):
            return paid.gateway_peer(SimpleNamespace(client=SimpleNamespace(host=host)))

    def test_space_proxy_address_is_never_forwarded(self):
        self.assertEqual(self.peer("10.16.4.9", {"SPACE_ID": "a/b"}), "::")
        self.assertEqual(self.peer("34.1.2.3", {"SPACE_HOST": "a-b.hf.space"}), "::")

    def test_trusted_proxy_client_is_forwarded(self):
        self.assertEqual(self.peer("203.0.113.7", {"SPACE_ID": "a/b"}, "10.0.0.0/8"), "203.0.113.7")
        self.assertEqual(self.peer("10.0.0.5", {}, "10.0.0.0/8"), "::")  # still the proxy itself

    def test_private_deployment_uses_global_peer_only(self):
        self.assertEqual(self.peer("8.8.4.4", {}), "8.8.4.4")
        self.assertEqual(self.peer("172.17.0.1", {}), "::")   # docker bridge / local proxy
        self.assertEqual(self.peer("127.0.0.1", {}), "::")

    def test_unknown_marker_is_signable(self):
        from backend.gateway_proof import headers, verify
        secret = "a" * 64
        sent = headers(secret, "::", "POST", "/api/customer/auth/request", {"email": "x@example.com"})
        self.assertEqual(verify(secret, sent, "POST", "/api/customer/auth/request",
                                {"email": "x@example.com"}), "::")


class LensCookie(unittest.TestCase):
    def setUp(self):
        from backend.lens import cookie
        self.c = cookie
        cookie._reset_for_tests()
        self.addCleanup(cookie._reset_for_tests)

    def test_no_public_default_jar_and_no_poll_loop(self):
        from backend.config import Settings
        from backend import main
        with patch.dict(os.environ, {"FIREBASE_URL": ""}):
            self.assertEqual(Settings().firebase_url, "")
        self.assertFalse(hasattr(main, "_cookie_refresh_loop"))
        self.assertNotIn("firebasedatabase", (ROOT / "api/backend/config.py").read_text())
        with patch.object(self.c, "_order", return_value=("direct", "firebase")):
            self.assertEqual(self.c._sources(""), ("direct",))
            self.assertEqual(self.c._sources("https://own.example/jar.json"), ("direct", "firebase"))
            self.assertTrue(self.c.configured(""))
        with patch.object(self.c, "_order", return_value=("firebase",)):
            self.assertFalse(self.c.configured(""))

    def test_failures_back_off_5_15_60_minutes(self):
        clock = [1_000_000.0]
        calls = []

        def down():
            calls.append(1)
            raise RuntimeError("source down")
        with patch.object(self.c, "_order", return_value=("direct",)), \
                patch.object(self.c, "_fetch_direct", side_effect=down), \
                patch.object(self.c.time, "time", lambda: clock[0]):
            for expected in (300, 900, 3600, 3600):
                with self.assertRaises(RuntimeError):
                    self.c.state("")
                self.assertAlmostEqual(self.c.backoff_remaining(), expected)
                with self.assertRaises(self.c.CookieSourceBackoff):
                    self.c.state("")              # within back-off: no source call
                clock[0] += expected + 1
            self.assertEqual(len(calls), 4)

    def test_aged_jar_served_during_backoff_and_success_resets(self):
        clock = [2_000_000.0]
        with patch.object(self.c, "_order", return_value=("direct",)), \
                patch.object(self.c.time, "time", lambda: clock[0]):
            with patch.object(self.c, "_fetch_direct", return_value={"NID": "a"}):
                self.c.state("")
            clock[0] += self.c.settings.firebase_cookie_ttl_sec + 1
            calls = []
            with patch.object(self.c, "_fetch_direct", side_effect=lambda: calls.append(1) or (_ for _ in ()).throw(RuntimeError("down"))):
                self.assertEqual(self.c.state("").data, {"NID": "a"})
                self.assertEqual(self.c.state("").data, {"NID": "a"})
            self.assertEqual(len(calls), 1)
            clock[0] += 301
            with patch.object(self.c, "_fetch_direct", return_value={"NID": "b"}):
                self.assertEqual(self.c.state("").data, {"NID": "b"})
            self.assertEqual(self.c.backoff_remaining(), 0.0)

    def test_prefetch_is_non_blocking_and_only_near_expiry(self):
        gate = threading.Event()
        fetched = []

        def slow():
            gate.wait(5)
            fetched.append(1)
            return {"NID": str(len(fetched))}
        def settled():
            # Wait for the background prefetch itself (bounded), not a fixed
            # number of short sleeps that a loaded runner can outlast.
            deadline = time.monotonic() + 30
            while self.c._prefetching and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(self.c._prefetching, "prefetch thread did not finish")
        with patch.object(self.c, "_order", return_value=("direct",)), \
                patch.object(self.c, "_fetch_direct", side_effect=slow):
            self.assertTrue(self.c.prefetch(""))          # cold jar
            # Non-blocking: the fetch cannot finish before the gate opens, yet
            # prefetch() has already returned.
            self.assertEqual(fetched, [])
            self.assertFalse(self.c.prefetch(""))         # one in flight
            gate.set()
            settled()
            self.assertEqual(fetched, [1])
            self.assertFalse(self.c.prefetch(""))         # fresh jar: nothing to do
            with self.c._condition:
                self.c._cache["ts"] -= self.c.settings.firebase_cookie_ttl_sec * 0.9
            self.assertTrue(self.c.prefetch(""))          # near expiry
            settled()
            self.assertEqual(len(fetched), 2)


class IdentityQuota(unittest.TestCase):
    def setUp(self):
        ingress.buckets.clear()
        self.calls = []
        self.env = patch.dict(os.environ, {**CLEAN_ENV, "SPACE_ID": "a/b", "TP_IDENTITY_BURST": "3",
                                           "TP_IDENTITY_RATE_PER_SEC": "0.5"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = TestClient(small_app(self.calls), client=("10.1.2.3", 5000))

    def post(self, install=None, path="/v1/lens/raw", **headers):
        if install:
            headers["X-TP-Install"] = install
        return self.client.post(path, content=b"{}", headers=headers)

    def test_bucket_per_install_with_retry_after(self):
        a, b = "a" * 32, "b" * 32
        with patch("backend.lens.cookie.prefetch", lambda *a, **k: False):
            for _ in range(3):
                self.assertEqual(self.post(a).status_code, 200)
            limited = self.post(a)
            self.assertEqual(limited.status_code, 429)
            self.assertGreaterEqual(int(limited.headers["Retry-After"]), 1)
            self.assertEqual(limited.json()["detail"]["code"], "identity_rate_limited")
            self.assertEqual(self.post(b).status_code, 200)     # another browser unaffected
            # Non-quota routes and requests without an identity are not bucketed.
            self.assertEqual(self.post(a, path="/ai/resolve2").status_code, 404)
            for _ in range(6):
                self.assertEqual(self.post().status_code, 200)

    def test_tab_session_identity_when_no_install(self):
        with patch("backend.lens.cookie.prefetch", lambda *a, **k: False):
            for _ in range(3):
                self.post(**{"X-TP-Tab-Session": "tab-1"})
            self.assertEqual(self.post(**{"X-TP-Tab-Session": "tab-1"}).status_code, 429)
            self.assertEqual(self.post(**{"X-TP-Tab-Session": "tab-2"}).status_code, 200)

    def test_lens_route_triggers_cookie_prefetch(self):
        seen = []
        with patch("backend.lens.cookie.prefetch", lambda *a, **k: seen.append(1) or False):
            self.post("c" * 32)
            self.post("c" * 32, path="/ai/resolve")
        self.assertEqual(seen, [1])

    def test_private_loopback_caller_is_exempt(self):
        with patch.dict(os.environ, {"SPACE_ID": ""}):
            client = TestClient(small_app(self.calls), client=("127.0.0.1", 1))
            with patch("backend.lens.cookie.prefetch", lambda *a, **k: False):
                for _ in range(6):
                    self.assertEqual(client.post("/v1/lens/raw", content=b"{}",
                                                 headers={"X-TP-Install": "d" * 32}).status_code, 200)

    def test_identity_resolution(self):
        scope = {"client": ("10.0.0.2", 1), "headers": [(b"x-tp-install", b"E" * 32)]}
        self.assertEqual(ingress.resolve_identity(scope), (None, None))  # not 32 lowercase hex
        scope["headers"] = [(b"x-tp-install", b"e" * 32)]
        identity, ip = ingress.resolve_identity(scope)
        self.assertTrue(identity.startswith("install:") and "e" * 32 not in identity)
        self.assertIsNone(ip)


class PoolCaps(unittest.TestCase):
    def test_conversation_slots_per_identity(self):
        from backend.ai.translation_paths import store as conv
        db = conv.Store()
        token = ingress._identity.set("install:x")
        try:
            with patch.object(conv, "MAX_SESSIONS_PER_IDENTITY", 2), \
                    patch("backend.application.repair_pool.store.store.active_for_pages", return_value=set()), \
                    patch("backend.application.repair_pool.store.store.active_workflows", return_value=set()):
                leases = [db.try_acquire(db.key(f"m{i}")) for i in range(2)]
                with self.assertRaises(conv.ConversationError) as raised:
                    db.try_acquire(db.key("m2"))
                self.assertEqual(raised.exception.code, "ai_conversation_identity_capacity")
                db.release(leases[0])                  # idle, never committed: evictable
                self.assertIsNotNone(db.try_acquire(db.key("m3")))
                other = ingress._identity.set("install:y")
                try:
                    self.assertIsNotNone(db.try_acquire(db.key("m4")))
                finally:
                    ingress._identity.reset(other)
        finally:
            ingress._identity.reset(token)

    def test_repair_runs_per_identity(self):
        from backend.application.repair_pool import store as repair, state
        db = repair.RepairStore()
        with patch.object(repair, "MAX_IDENTITY_RUNS", 2):
            for n in range(2):
                db.register(f"run-{n}", f"{n:064x}", [f"page-{n}"], f"tab-{n}", "install:x")
            with self.assertRaises(state.PoolError) as raised:
                db.register("run-9", f"{9:064x}", ["page-9"], "tab-9", "install:x")
            self.assertEqual((raised.exception.code, raised.exception.status), ("repair_identity_capacity", 429))
            db.register("run-y", f"{10:064x}", ["page-y"], "tab-y", "install:y")


class Cors(unittest.TestCase):
    def test_default_admits_extension_origins_only(self):
        from backend import main
        client = TestClient(main.app)
        for origin, allowed in (("chrome-extension://abcdefghijklmnop", True),
                                ("moz-extension://0d6c0a8e-1b2c-4d5e-8f90-123456789abc", True),
                                ("https://evil.example", False), ("null", False)):
            response = client.options("/v1/capabilities", headers={
                "Origin": origin, "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-tp-install"})
            got = response.headers.get("access-control-allow-origin")
            self.assertEqual(got == origin, allowed, (origin, response.status_code, got))
            self.assertIsNone(response.headers.get("access-control-allow-credentials"))


class DiagnosticDefaults(unittest.TestCase):
    def test_writers_off_by_default_on_a_space(self):
        env = {k: v for k, v in CLEAN_ENV.items()
               if k not in {"TP_LOG_FILE", "TP_TRACE", "TP_AI_WIRE_TRACE", "TP_DIAGNOSTICS"}}
        env.update(SPACE_ID="owner/textphantom", PYTHONPATH=str(ROOT / "api"))
        code = ("from backend import logfile, trace\nfrom backend.ai import wire_trace\n"
                "print(logfile.is_enabled(), trace.enabled(), wire_trace.enabled())")
        out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True,
                             timeout=120, check=True).stdout.split()
        self.assertEqual(out[-3:], ["False", "False", "False"])


class Gitignore(unittest.TestCase):
    def test_runtime_state_and_secrets_ignored(self):
        text = (ROOT / ".gitignore").read_text()
        for pattern in ("logs/", "data/", "*.sqlite", "*.sqlite3", "gateway.key", ".env",
                        "node_modules/", "packages/", "__pycache__/"):
            self.assertIn(pattern, text.splitlines(), pattern)


if __name__ == "__main__":
    unittest.main(verbosity=1)
