"""Official OpenRouter PKCE delegated-key Login. Credentials remain in RAM."""
import hashlib
from urllib.parse import urlencode
from .login_provider_contract import LoginProvider, LoginError
from .login_oauth_common import public_base, challenge
from . import login_http as http

PROVIDER = LoginProvider("login_openrouter", "OpenRouter", "openrouter_credits", "openrouter.ai", "/auth", 0, "")
CALLBACK_PARAMETER = "callback_url"

def configuration():
    return {}

def prepare(flow):
    flow["redirect_uri"] = public_base(flow.get("callback_base", ""))+"/login/oauth/callback/openrouter"
    flow["callback_delivery"] = "server"

def auth_url(flow):
    return "https://openrouter.ai/auth?"+urlencode({"callback_url": flow["redirect_uri"], "state": flow["state"],
        "code_challenge": challenge(flow), "code_challenge_method": "S256", "key_label": "TextPhantom"})

def exchange(code, flow, *, client_id=None):
    if client_id is not None:
        raise LoginError("login_callback_invalid", "Invalid OpenRouter callback.", 400)
    data = http.request("https://openrouter.ai/api/v1/auth/keys", method="POST", oauth=True,
        body={"code": code, "code_verifier": flow["verifier"], "code_challenge_method": "S256"})
    key = data.get("key")
    if not isinstance(key, str) or not 16 <= len(key) <= 32768:
        raise LoginError("login_token_invalid", "OpenRouter did not return a usable delegated key.", 502)
    tokens = {"access_token": key, "no_refresh": True, "identity_kind": "account" if isinstance(data.get("user_id"), str) and data["user_id"] else "delegated_key"}
    info = http.request("https://openrouter.ai/api/v1/key", headers=headers(tokens))
    if not isinstance(info.get("data"), dict):
        raise LoginError("login_grant_invalid", "OpenRouter could not verify this delegated key.", 502)
    identity = "user:"+data["user_id"] if tokens["identity_kind"] == "account" else "grant:"+hashlib.sha256(key.encode()).hexdigest()
    return identity, tokens

def headers(tokens):
    return {"Authorization": "Bearer "+tokens["access_token"]}

def refresh(previous):
    raise LoginError("login_session_expired", "Reconnect your OpenRouter account.", 401)

def models(tokens):
    from .login_profiles import native_model
    from backend.ai.providers.cloud_openrouter import normalize_capabilities
    data = http.request("https://openrouter.ai/api/v1/models/user", headers=headers(tokens), query={"output_modalities": "text"})
    rows = data.get("data")
    if not isinstance(rows, list) or len(rows) > 1000:
        raise LoginError("login_provider_contract", "Invalid OpenRouter account model catalogue.", 502)
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        architecture = row.get("architecture") or {}
        item = native_model(row.get("id"), row.get("name"), {"supportedOutputModalities": architecture.get("output_modalities"), **row})
        if item:
            item["model_capabilities"] = normalize_capabilities(row)
            result.append(item)
    return result

def generate(tokens, payload, *, dispatch):
    body = {k: v for k, v in payload.items() if k not in {"reasoning_effort", "thinking_budget", "response_format"}}
    body["provider"] = {"allow_fallbacks": False, "require_parameters": True}
    dispatch()
    return http.request("https://openrouter.ai/api/v1/chat/completions", method="POST", body=body, headers=headers(tokens), inference=True)
