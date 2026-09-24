"""Run with TP_CENTER_URL=http://127.0.0.1:8787 and PYTHONPATH=api."""
import hashlib
import os
from unittest.mock import patch

assert os.getenv("TP_CENTER_URL") == "http://127.0.0.1:8787"

from fastapi.testclient import TestClient
from backend.main import app
from backend.paid_center import center_base_url, center_origin
from backend.ai.provider_bootstrap import ensure_provider_registry
from backend.ai.provider_registry import provider_registry
from backend.ai.provider_contract import GenerationRequest, ProbeRequest
from backend.ai.providers.cloud_paid import ADAPTER
from backend.security import assert_ai_base_url_allowed, UnsafeBaseUrl

assert center_base_url() == "http://127.0.0.1:8787"
assert center_origin() == "http://127.0.0.1:8787"
ensure_provider_registry()
assert provider_registry.get("paid") is not None
assert_ai_base_url_allowed("paid", center_base_url() + "/api/customer", user_key=True)
try:
    assert_ai_base_url_allowed("paid", "http://127.0.0.1:9999/api/customer", user_key=True)
except UnsafeBaseUrl:
    pass
else:
    raise AssertionError("Paid token redirected to unapproved endpoint")

class Response:
    status_code = 200
    is_success = True
    def __init__(self, payload): self.payload = payload
    def json(self): return self.payload

class FakeClient:
    calls = []
    def __init__(self, **kwargs): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def get(self, url, headers):
        self.calls.append(("GET", url, None, headers))
        return Response({"models": [{"id": "qa/test"}]})
    def post(self, url, json, headers):
        self.calls.append(("POST", url, json, headers))
        return Response({"choices": [{"message": {"content": "Translated."}}],
            "model": "qa/test", "usage": {"prompt_tokens": 13, "completion_tokens": 4,
                "cost": 0.001}, "charged_tp": "825", "balance_tp": "9175"})

with TestClient(app) as client:
    assert client.get("/meta").json()["paid"]["available"] is True
    async def fake_customer_request(path, **kwargs):
        assert path == "/api/customer/auth/request"
        return 200, {"ok": True}
    with patch("backend.api.routes.paid.customer_request", side_effect=fake_customer_request):
        assert client.post("/paid/auth/request", json={"email": "first@gmail.com"}).json() == {"ok": True}
    async def fake_auth_status(path, **kwargs):
        assert path == "/api/customer/auth/status"
        return 200, {"available": False, "code": "OTP_DISABLED", "message": "ระบบยังไม่เปิด OTP"}
    with patch("backend.api.routes.paid.customer_request", side_effect=fake_auth_status):
        response = client.get("/paid/auth/status")
        assert response.status_code == 200 and response.json()["code"] == "OTP_DISABLED"
        assert response.headers["cache-control"] == "no-store"
    with patch("backend.ai.providers.cloud_paid.httpx.Client", FakeClient):
        listed = ADAPTER.list_models(api_key="customer-session", base_url="")
        assert listed.models == ("qa/test",)
        probe = ADAPTER.probe(ProbeRequest(model="qa/test", api_key="customer-session"))
        assert probe.ok and all(call[0] == "GET" for call in FakeClient.calls)
        result = ADAPTER.generate(GenerationRequest(provider="paid", model="qa/test",
            api_key="customer-session", system_text="Translate", user_parts=("panel text",),
            cache_context={"operationId": "one-operation"}))
        assert result.text == "Translated." and result.usage_details["chargedTp"] == "825"
        method, url, body, headers = FakeClient.calls[-1]
        assert method == "POST" and url == center_base_url() + "/api/customer/chat/completions"
        assert body["operation_id"] == hashlib.sha256(b"customer-session\0one-operation").hexdigest()
        assert body["model"] == "qa/test" and body["messages"][1]["content"] == "panel text"
        assert headers["Authorization"] == "Bearer customer-session"
        assert all("sk-or-v1" not in str(call) for call in FakeClient.calls)
print("Paid Center URL binding, read-only model probe, and generation contract passed.")
