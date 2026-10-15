"""10490: the API relays the Center's per-account change tokens (X-TP-Changes)
unchanged on the Paid/support responses the extension already receives, and
only in their exact opaque shape.

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

GOOD = "v1;b=0a1b2c3d4e5f;support=111111111111;account=222222222222;prices=333333333333"
answer = {"value": GOOD, "status": 200}
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
        headers_out = {"X-TP-Changes": answer["value"]} if answer["value"] is not None else {}
        body = {"ok": True} if answer["status"] < 400 else {"error": {"code": "AUTH_REQUIRED", "message": "x"}}
        return httpx.Response(answer["status"], json=body, headers=headers_out,
                              request=httpx.Request(method, url))


app = FastAPI()
app.include_router(router)
auth = {"Authorization": "Bearer " + "s" * 48}
with patch.object(paid_center, "center_base_url", return_value="http://127.0.0.1:8787"), \
        patch("backend.api.routes.paid.center_base_url", return_value="http://127.0.0.1:8787"), \
        patch.object(paid_center.httpx, "AsyncClient", FakeCenter), TestClient(app) as client:
    for path in ("/paid/me", "/paid/account", "/paid/support", "/paid/support/status", "/paid/addons"):
        response = client.get(path, headers=auth)
        check(path + " relays the tokens", response.headers.get("x-tp-changes") == GOOD)
    response = client.post("/paid/support/presence", json={}, headers=auth)
    check("support writes relay the tokens", response.headers.get("x-tp-changes") == GOOD)
    response = client.get("/paid/support/wait?after=0&version=0&timeout=0", headers=auth)
    check("the support long-poll relays the tokens", response.headers.get("x-tp-changes") == GOOD)
    for bad in ("v1;b=zz", "v2;b=0a1b2c", "v1;b=0a1b2c\r\nX-Evil: 1", "<script>", "v1;" + "a=" + "0" * 40):
        answer["value"] = bad
        response = client.get("/paid/me", headers=auth)
        check("malformed token is dropped: " + repr(bad), "x-tp-changes" not in response.headers)
    answer["value"] = None
    check("no token, no header", "x-tp-changes" not in client.get("/paid/me", headers=auth).headers)
    answer.update(value=GOOD, status=401)
    response = client.get("/paid/me", headers=auth)
    check("an error answer still carries the tokens", response.status_code == 401 and
          response.headers.get("x-tp-changes") == GOOD)
    paid_center.center_changes.set("")

check("valid_changes keeps the exact shape only", paid_center.valid_changes(GOOD) == GOOD and
      paid_center.valid_changes(GOOD + ";x") == "")
print("Paid change-token relay passed:", len(checks), "checks")
