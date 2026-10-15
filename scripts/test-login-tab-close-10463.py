"""Replay verified import -> tab close -> model read, with real RAM session ownership."""
import hashlib
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from backend.ai.login import login_native, login_session_store as store
from backend.ai.login.endpoint import login_endpoint_session as endpoint
from backend.ai.login.login_provider_contract import LoginError

@pytest.fixture(autouse=True)
def clean():
    endpoint.clear(); store.clear()
    yield
    endpoint.clear(); store.clear()

@pytest.mark.parametrize("provider,credentials", [
    ("login_deepseek", {"token": "synthetic-provider-token"}),
    ("login_gemini", {"psid": "synthetic-provider-cookie"}),
])
def test_close_after_verified_import_keeps_connection_until_explicit_abort(provider, credentials):
    owner = "synthetic-owner"
    flow = endpoint.start(owner, provider)
    identity = "synthetic-account"
    verified = {"identity": identity, "credentials": dict(credentials),
                "models": [{"id": "web-default", "name": "Default", "model_capabilities": {}}]}
    with patch.object(login_native, "module", return_value=SimpleNamespace(endpoint_validate=lambda *args: verified)):
        result = endpoint.complete(owner, provider, flow["flow_id"], flow["state"],
            "synthetic-browser", hashlib.sha256(identity.encode()).hexdigest(), dict(credentials), lambda: owner)
    ident = result["session"]["id"]
    assert endpoint.cancel(owner, provider, flow["flow_id"], reason="tab_closed") == result
    assert endpoint.cancel(owner, provider, flow["flow_id"], reason="tab_closed") == result
    session = store.get(ident, owner)
    assert session["provider"] == provider
    assert store.credential_for_session(session)["tokens"]["models"][0]["id"] == "web-default"
    with pytest.raises(LoginError): endpoint.cancel("other-owner", provider, flow["flow_id"], reason="tab_closed")
    with pytest.raises(LoginError): endpoint.cancel(owner, "login_claude", flow["flow_id"], reason="tab_closed")
    assert store.get(ident, owner)["id"] == ident
    endpoint.cancel(owner, provider, flow["flow_id"])
    with pytest.raises(LoginError) as failure: store.get(ident, owner)
    assert failure.value.code == "login_session_expired"


def test_close_before_import_never_creates_a_session():
    flow = endpoint.start("synthetic-owner", "login_deepseek")
    assert endpoint.cancel("synthetic-owner", "login_deepseek", flow["flow_id"], reason="tab_closed")["status"] == "cancelled"
    assert store.owned("synthetic-owner", "login_deepseek") == []
    with pytest.raises(LoginError): endpoint.status("synthetic-owner", "login_deepseek", flow["flow_id"])


def test_flow_expiry_after_connection_does_not_expire_verified_session():
    owner, provider = 'synthetic-owner', 'login_deepseek'
    flow = endpoint.start(owner, provider)
    identity = 'synthetic-account'
    verified = {'identity':identity, 'credentials':{'token':'synthetic-provider-token'},
                'models':[{'id':'web-default', 'name':'Default', 'model_capabilities':{}}]}
    with patch.object(login_native, 'module', return_value=SimpleNamespace(endpoint_validate=lambda *args:verified)):
        result = endpoint.complete(owner, provider, flow['flow_id'], flow['state'],
            'synthetic-browser', hashlib.sha256(identity.encode()).hexdigest(), {'token':'synthetic-provider-token'}, lambda:owner)
    endpoint._flows[flow['flow_id']]['expires'] = 0
    with pytest.raises(LoginError) as failure: endpoint.status(owner, provider, flow['flow_id'])
    assert failure.value.code == 'login_auth_expired'
    assert store.get(result['session']['id'], owner)['id'] == result['session']['id']
    endpoint.disconnect(owner, provider, result['session']['id'])
    with pytest.raises(LoginError): store.get(result['session']['id'], owner)
