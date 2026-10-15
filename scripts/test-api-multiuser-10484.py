""".84 multi-user API checks (offline, no provider or Google calls).

1. AI Login uses its own admission lane/executor, never the shared AI slots.
2. A plain JSON translation sees its caller disconnect (cancel_check turns true).
3. Login entitlement: a verified token is reused briefly, a rejected one too, a
   Center outage is never cached.
4. Lens cookie: a jar past its refresh time is reused while the source is down;
   after Lens rejects a jar, a source serving the same jar is skipped (direct used).
5. Lens result cache is 30 min since last use.
6. OpenRouter reasoning: effort and max_tokens are never sent together.
"""
from __future__ import annotations

import asyncio
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))


class LoginLane(unittest.TestCase):
    def test_login_requests_use_login_gate_and_executor(self):
        source = (ROOT / "api/backend/application/ai_translation/provider_execution.py").read_text(encoding="utf-8")
        self.assertIn('ctx.resolved_provider == "login"', source)
        self.assertIn("state.login_admission_gate if login_lane else state.ai_admission_gate", source)
        self.assertIn("loop.run_in_executor(executor, threaded_invoke)", source)
        self.assertNotIn("app.state.ai_executor, threaded_invoke", source)
        main = (ROOT / "api/backend/main.py").read_text(encoding="utf-8")
        self.assertIn("app.state.login_admission_gate = AdmissionGate(", main)
        self.assertIn('"login_executor"', main, "login executor is shut down with the others")


class Disconnect(unittest.TestCase):
    def test_json_route_cancel_check_turns_true_on_disconnect(self):
        from backend.application.ai_translation.streaming import until_disconnect
        messages = asyncio.Queue()

        class FakeRequest:
            async def receive(self):
                return await messages.get()

        seen = {}

        async def invoke(*, cancel_check):
            assert cancel_check() is False
            await messages.put({"type": "http.disconnect"})
            for _ in range(50):
                if cancel_check():
                    seen["cancelled"] = True
                    return {"stopped": True}
                await asyncio.sleep(0.01)
            return {"stopped": False}

        result = asyncio.run(until_disconnect(FakeRequest(), invoke))
        self.assertEqual(result, {"stopped": True})
        self.assertTrue(seen.get("cancelled"))

    def test_route_uses_watcher_for_json(self):
        source = (ROOT / "api/backend/api/routes/ai_v1.py").read_text(encoding="utf-8")
        self.assertIn("return await until_disconnect(request, lambda **kwargs: execute(", source)


class Entitlement(unittest.TestCase):
    def setUp(self):
        from backend.ai.login import login_entitlement
        self.mod = login_entitlement
        login_entitlement.clear()
        self.addCleanup(login_entitlement.clear)
        self.calls = []

    def _client(self, status, body):
        calls = self.calls

        class Client:
            def __init__(self, *a, **k): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, url, headers):
                calls.append(url)
                return SimpleNamespace(status_code=status, json=lambda: body)
        return Client

    def run_auth(self, token, status, body):
        with patch.object(self.mod, "require_center", return_value="https://center.test"), \
                patch.object(self.mod, "center_client", self._client(status, body)):
            return self.mod.authorize(token)

    def test_allow_is_reused(self):
        token = "t" * 48
        body = {"ok": True, "user_id": "usr_1", "active": True, "entitlement": {"status": "active"}}
        self.assertEqual(self.run_auth(token, 200, body), "usr_1")
        self.assertEqual(self.run_auth(token, 500, {}), "usr_1", "second call within 60 s uses the verified answer")
        self.assertEqual(len(self.calls), 1)

    def test_rejected_token_is_remembered(self):
        from backend.ai.login.login_provider_registry import LoginError
        token = "f" * 48
        for _ in range(3):
            with self.assertRaises(LoginError) as ctx:
                self.run_auth(token, 401, {})
            self.assertEqual(ctx.exception.code, "login_account_required")
        self.assertEqual(len(self.calls), 1, "a repeated bad token does not reach the Center again")

    def test_center_outage_is_not_cached(self):
        from backend.ai.login.login_provider_registry import LoginError
        token = "c" * 48
        with self.assertRaises(LoginError):
            self.run_auth(token, 503, {})
        body = {"ok": True, "user_id": "usr_2", "active": True, "entitlement": {"status": "active"}}
        self.assertEqual(self.run_auth(token, 200, body), "usr_2")
        self.assertEqual(len(self.calls), 2)

    def test_expired_entry_asks_again(self):
        token = "e" * 48
        body = {"ok": True, "user_id": "usr_3", "active": True, "entitlement": {"status": "active"}}
        self.run_auth(token, 200, body)
        key = self.mod._key(token)
        with self.mod._lock:
            self.mod._cache[key] = (time.monotonic() - 1, "usr_3", None)
        self.run_auth(token, 200, body)
        self.assertEqual(len(self.calls), 2)


class LensCookie(unittest.TestCase):
    def setUp(self):
        from backend.lens import cookie
        self.cookie = cookie
        with cookie._condition:
            cookie._cache.update(ts=0.0, url="", data=None)
            cookie._refresh_error = None
            cookie._refreshing = False

    def test_stale_jar_reused_when_source_down(self):
        c = self.cookie
        url = "https://fb.test/lens/cookie.json"
        with patch.object(c, "_fetch_firebase", return_value={"NID": "a"}), \
                patch.object(c, "_order", return_value=("firebase",)):
            first = c.state(url)
        self.assertEqual(first.data, {"NID": "a"})
        with c._condition:
            c._cache["ts"] = 0.0  # aged past its refresh time
        with patch.object(c, "_fetch_firebase", side_effect=RuntimeError("pi down")), \
                patch.object(c, "_order", return_value=("firebase",)):
            again = c.state(url)
            self.assertEqual(again.data, {"NID": "a"}, "old jar still used")
            # Backed off: the next call does not hit the failing source again.
            c.state(url)

    def test_rejected_jar_skips_source_and_uses_direct(self):
        c = self.cookie
        url = "https://fb.test/lens/cookie.json"
        with patch.object(c, "_fetch_firebase", return_value={"NID": "old"}), \
                patch.object(c, "_fetch_direct", return_value={"NID": "fresh"}), \
                patch.object(c, "_order", return_value=("firebase", "direct")):
            first = c.state(url)
            self.assertEqual(first.data, {"NID": "old"})
            refreshed = c.refresh_after(first, url)
        self.assertEqual(refreshed.data, {"NID": "fresh"})
        self.assertNotEqual(refreshed.generation, first.generation)
        self.assertEqual(c.source(), "direct")

    def _direct(self, host, path="/", status=200):
        c = self.cookie

        class Jar:
            jar = [SimpleNamespace(name="NID", value="x", domain=".google.com")]

        class Client:
            def __init__(self, *a, **k): self.cookies = Jar()
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, url):
                return SimpleNamespace(status_code=status, url=SimpleNamespace(host=host, path=path))
        with patch.object(c.httpx, "Client", Client):
            return c._fetch_direct()

    def test_direct_rejects_consent_page(self):
        with self.assertRaises(RuntimeError):
            self._direct("consent.google.com")
        with self.assertRaises(RuntimeError):
            self._direct("www.google.com", "/sorry/index")
        with self.assertRaises(RuntimeError):
            self._direct("example.com")

    def test_direct_accepts_redirect_to_google_home_10485(self):
        # Owner run 2026-10-14: lens.google.com -> www.google.com (HTTP 200).
        self.assertEqual(self._direct("www.google.com"), {"NID": "x"})
        self.assertEqual(self._direct("lens.google.com"), {"NID": "x"})


class LensCache(unittest.TestCase):
    def test_sliding_thirty_minutes(self):
        from backend.lens import client
        self.assertEqual(client._LENS_CACHE_TTL_SEC, 1800.0)
        client._lens_cache.clear()
        client._lens_cache_set("k", {"x": 1})
        with client._lens_cache_lock:
            client._lens_cache["k"] = (time.time() - 1700, {"x": 1})
        self.assertEqual(client._lens_cache_get("k"), {"x": 1})
        with client._lens_cache_lock:
            ts = client._lens_cache["k"][0]
        self.assertGreater(ts, time.time() - 5, "a hit renews the entry")


class OpenRouterReasoning(unittest.TestCase):
    def test_effort_and_max_tokens_never_together(self):
        from backend.ai.provider_contract import GenerationRequest
        from backend.ai.providers.cloud_openrouter import prepare_payload
        caps = {"reasoning": {"supported": True, "mandatory": False, "control": "levels",
                              "supported_efforts": ["none", "low", "medium", "high"], "supports_max_tokens": True}}
        for thinking in ("low", "medium", "high", "on", "default"):
            request = GenerationRequest(provider="openrouter", model="vendor/model", system_text="s",
                                        user_parts=("<<I1_P0:x>>",), thinking=thinking, unit_count=1,
                                        model_capabilities=caps)
            reasoning = prepare_payload(request).get("reasoning") or {}
            self.assertFalse("effort" in reasoning and "max_tokens" in reasoning, (thinking, reasoning))


if __name__ == "__main__":
    unittest.main()
