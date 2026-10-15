"""HF Spaces OAuth inference-api grants, user's own HF inference billing."""
import base64
import os
import re
from urllib.parse import quote_plus, urlencode
from .login_provider_contract import LoginProvider, LoginError
from .login_oauth_common import public_base, challenge, access_tokens
from . import login_http as http

PROVIDER = LoginProvider("login_huggingface", "Hugging Face", "hf_inference_credits", "huggingface.co", "/oauth/authorize", 0, "")

def configuration():
    client = os.environ.get("TP_LOGIN_HF_CLIENT_ID", os.environ.get("OAUTH_CLIENT_ID", ""))
    secret = os.environ.get("TP_LOGIN_HF_CLIENT_SECRET", os.environ.get("OAUTH_CLIENT_SECRET", ""))
    scopes = os.environ.get("OAUTH_SCOPES", "openid profile inference-api")
    if not client or not secret or len(client) > 512 or len(secret) > 4096 or "inference-api" not in scopes.split():
        raise LoginError("login_setup_required", "Enable Hugging Face OAuth with the inference-api scope on this API Space.", 503)
    return {"client_id": client, "secret": secret, "scope": "openid profile inference-api"}

def basic(cfg):
    return "Basic "+base64.b64encode((quote_plus(cfg["client_id"])+":"+quote_plus(cfg["secret"])).encode()).decode()

def prepare(flow):
    flow["oauth_config"] = configuration()
    flow["redirect_uri"] = public_base(flow.get("callback_base", ""))+"/login/oauth/callback/huggingface"
    flow["callback_delivery"] = "server"

def auth_url(flow):
    cfg = flow["oauth_config"]
    return "https://huggingface.co/oauth/authorize?"+urlencode({"client_id": cfg["client_id"], "redirect_uri": flow["redirect_uri"],
        "scope": cfg["scope"], "response_type": "code", "state": flow["state"], "code_challenge": challenge(flow), "code_challenge_method": "S256"})

def exchange(code, flow, *, client_id=None):
    if client_id is not None:
        raise LoginError("login_callback_invalid", "Invalid Hugging Face callback.", 400)
    cfg = flow["oauth_config"]
    data = http.request("https://huggingface.co/oauth/token", method="POST", form={"client_id": cfg["client_id"], "code": code,
        "code_verifier": flow["verifier"], "grant_type": "authorization_code", "redirect_uri": flow["redirect_uri"]}, headers={"Authorization": basic(cfg)}, oauth=True)
    if "scope" in data and "inference-api" not in str(data["scope"]).split():
        raise LoginError("login_grant_required", "Hugging Face did not grant inference-api access.", 403)
    tokens = access_tokens(data)
    profile = http.request("https://huggingface.co/oauth/userinfo", headers=headers(tokens))
    identity = profile.get("sub")
    if not isinstance(identity, str) or not 1 <= len(identity) <= 256:
        raise LoginError("login_identity_invalid", "Hugging Face did not return a verified identity.", 401)
    tokens.update(subject=identity, client_id=cfg["client_id"])
    return identity, tokens

def headers(tokens):
    return {"Authorization": "Bearer "+tokens["access_token"]}

def refresh(previous):
    cfg = configuration()
    if not previous.get("refresh_token"):
        failure = LoginError("login_session_expired", "Your Hugging Face Login expired. Sign in again.", 401)
        failure.oauth_terminal = True
        raise failure
    if previous["client_id"] != cfg["client_id"]:
        raise LoginError("login_session_expired", "The HF registration changed. Sign in again.", 401)
    data = http.request("https://huggingface.co/oauth/token", method="POST", form={"client_id": cfg["client_id"], "refresh_token": previous["refresh_token"],
        "grant_type": "refresh_token"}, headers={"Authorization": basic(cfg)}, oauth=True)
    return access_tokens(data, previous)

def models(tokens):
    from .login_profiles import native_model
    from backend.ai.providers.huggingface_limits import catalogue_limits
    data = http.request("https://router.huggingface.co/v1/models", headers=headers(tokens))
    rows = data.get("data")
    if not isinstance(rows, list) or len(rows) > 1000:
        raise LoginError("login_provider_contract", "Invalid Hugging Face model catalogue.", 502)
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        architecture = row.get("architecture") or {}
        routes = [p for p in (row.get("providers") or []) if isinstance(p, dict) and p.get("status") == "live" and re.fullmatch(r"[a-z0-9-]{1,60}", str(p.get("provider", "")))]
        for route in routes:
            meta = {"supportedInputModalities": architecture.get("input_modalities"), "supportedOutputModalities": architecture.get("output_modalities"), **route}
            item = native_model(str(row.get("id", ""))+":"+route["provider"], row.get("id"), meta)
            if item:
                _, limits = catalogue_limits([route])
                if limits:
                    item["model_capabilities"]["limits"] = limits
                item["name"] += " · "+route["provider"]
                result.append(item)
    return result[:1000]

def generate(tokens, payload, *, dispatch):
    allowed = {"model", "messages", "max_tokens", "temperature", "stream", "reasoning_effort"}
    body = {k: v for k, v in payload.items() if k in allowed}
    dispatch()
    return http.request("https://router.huggingface.co/v1/chat/completions", method="POST", body=body, headers=headers(tokens), inference=True)
