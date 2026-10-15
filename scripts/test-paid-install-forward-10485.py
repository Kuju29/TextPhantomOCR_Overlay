"""The API gateway forwards only a valid X-TP-Install (32 lowercase hex) to Center.

Fictional Center wire only: the httpx client is replaced, nothing leaves the process.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
os.environ["TP_CENTER_URL"] = "http://127.0.0.1:8787"
os.environ.setdefault("TP_LOG_FILE", "0")
from unittest.mock import patch
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.api.routes.paid import router
from backend import paid_center

VALID = "a1" * 16
sent = []
checks = []


def check(name, ok):
    checks.append(name)
    assert ok, name


class FakeCenter:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def request(self, method, url, headers=None, json=None):
        sent.append((method, url, dict(headers or {})))
        return httpx.Response(200, json={"ok": True}, request=httpx.Request(method, url))


emitted = []
_emit = paid_center.diagnostics.emit


def recording_emit(event, **fields):
    emitted.append((event, fields))
    return _emit(event, **fields)


app = FastAPI()
app.include_router(router)
auth = {"Authorization": "Bearer " + "s" * 48}
with patch.object(paid_center, "center_base_url", return_value="http://127.0.0.1:8787"), \
        patch("backend.api.routes.paid.center_base_url", return_value="http://127.0.0.1:8787"), \
        patch.object(paid_center.httpx, "AsyncClient", FakeCenter), \
        patch.object(paid_center.diagnostics, "emit", recording_emit), TestClient(app) as client:
    for method, path, body in [("GET", "/paid/me", None), ("POST", "/paid/orders", {"package_id": "p"}),
                               ("POST", "/paid/addon-orders", {"code": "ai_login"}),
                               ("POST", "/paid/refunds", {"payment_id": "pay_x"}),
                               ("POST", "/paid/auth/verify", {"email": "a@example.com", "code": "123456"}),
                               ("POST", "/paid/support/messages", {"text": "hi"})]:
        response = client.request(method, path, headers={**auth, "X-TP-Install": VALID}, json=body)
        check(f"{path} answered", response.status_code == 200)
        check(f"{path} forwards the valid install id", sent[-1][2].get("X-TP-Install") == VALID)
    for bad in ["A1" * 16, "a1" * 15, "a1" * 17, "g" * 32, VALID + "\r\nX-Evil: 1", "a1" * 16 + " ", ""]:
        try:
            client.get("/paid/me", headers={**auth, "X-TP-Install": bad})
        except Exception:
            # httpx itself refuses header injection; nothing was forwarded either way.
            pass
        check(f"invalid install id {bad[:12]!r} is not forwarded", "X-TP-Install" not in sent[-1][2])
    client.get("/paid/me", headers=auth)
    check("no header, nothing forwarded", "X-TP-Install" not in sent[-1][2])
    forwarded = {k.lower() for k in sent[-1][2]}
    check("only the gateway's own headers reach Center", "x-evil" not in forwarded and "cookie" not in forwarded)
    client.get("/paid/me", headers={**auth, "X-TP-Install": VALID, "X-Other-Client-Header": "x"})
    check("other client headers are not forwarded", "X-Other-Client-Header" not in sent[-1][2])
check("the raw install id never reaches gateway diagnostics", emitted and VALID not in repr(emitted))
print({"suite": "paid-install-forward-10485", "passed": len(checks)})
