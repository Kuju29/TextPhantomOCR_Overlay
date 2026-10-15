""".84 multi-user API, Login:
1. The session store at its limit lets the least recently used session idle >= 24 h
   give way instead of refusing every new connection until a restart; sessions idle
   7 days end; a session in use is never evicted.
2. A website tab closed by the person during a translation is reported as its own
   error (login_work_tab_closed), not as "could not load". Offline."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from backend.ai.login import login_session_store as store
from backend.ai.login.login_provider_contract import LoginError


class SessionStore(unittest.TestCase):
    def setUp(self):
        store.clear()
        self.addCleanup(store.clear)
        self.clock = [1000.0]
        patcher = patch.object(store.time, "monotonic", side_effect=lambda: self.clock[0])
        patcher.start(); self.addCleanup(patcher.stop)
        p2 = patch.object(store, "center_base_url", return_value="https://center.test")
        p2.start(); self.addCleanup(p2.stop)

    def bind(self, owner):
        return store.bind_native(owner, "login_claude", "id-" + owner, {"t": owner})

    def test_full_store_evicts_least_recently_used_idle_session(self):
        with patch.object(store, "MAX_ACTIVE", 2):
            a = self.bind("a"); self.clock[0] += 10; b = self.bind("b")
            with self.assertRaises(LoginError) as ctx:
                self.bind("c")
            self.assertEqual(ctx.exception.code, "login_capacity_reached", "recently used sessions are kept")
            self.clock[0] += store.IDLE_EVICT_SECONDS + 5
            store.get(b["id"], "b")  # b is in use
            c = self.bind("c")
            with self.assertRaises(LoginError) as gone:
                store.get(a["id"], "a")
            self.assertEqual(gone.exception.code, "login_session_expired", "the idle owner signs in again")
            self.assertTrue(store.get(b["id"], "b")["active"])
            self.assertTrue(store.get(c["id"], "c")["active"])

    def test_week_idle_session_ends(self):
        a = self.bind("a")
        self.clock[0] += store.IDLE_EXPIRE_SECONDS + 1
        with self.assertRaises(LoginError):
            store.get(a["id"], "a")

    def test_credential_read_keeps_session_alive(self):
        a = self.bind("a")
        self.clock[0] += store.IDLE_EXPIRE_SECONDS - 10
        store.credential_for_session(a)
        self.clock[0] += 20
        self.assertTrue(store.get(a["id"], "a")["active"])


class TabClosedMapping(unittest.TestCase):
    def test_codes(self):
        source = (Path(__file__).resolve().parents[1] / "api/backend/ai/login/endpoint/login_endpoint_http.py").read_text(encoding="utf-8")
        self.assertIn("code == 'tab_unavailable' and detail == 'login_tab_closed'", source)
        self.assertEqual(source.count("'login_work_tab_closed'"), 2, "website relay and ChatGPT website both report it")
        contract = (Path(__file__).resolve().parents[1] / "src/shared/error-contract.js").read_text(encoding="utf-8")
        self.assertIn("LOGIN_WORK_TAB_CLOSED:", contract)


if __name__ == "__main__":
    unittest.main()
