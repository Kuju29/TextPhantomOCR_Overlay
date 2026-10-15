"""Registered callbacks on this API, with an explicit local development origin."""
import base64
import hashlib
import os
from urllib.parse import urlsplit
from .login_provider_contract import LoginError

def public_base(request_base=""):
    value = os.environ.get("TP_LOGIN_PUBLIC_URL", "").strip()
    if not value and os.environ.get("SPACE_HOST"):
        value = "https://"+os.environ["SPACE_HOST"]
    if not value:
        value = request_base
    try:
        uri = urlsplit(value)
        valid = uri.hostname and not uri.username and not uri.password and not uri.query and not uri.fragment and uri.path in ("", "/")
        valid = valid and (uri.scheme == "https" and uri.port in (None, 443) or uri.scheme == "http" and uri.hostname in {"localhost", "127.0.0.1"} and uri.port)
        if not valid:
            raise ValueError()
        return value.rstrip("/")
    except ValueError:
        raise LoginError("login_setup_required", "The API needs its public HTTPS Login callback address.", 503) from None

def challenge(flow):
    return base64.urlsafe_b64encode(hashlib.sha256(flow["verifier"].encode()).digest()).rstrip(b"=").decode()

def access_tokens(data, previous=None):
    import time
    old = previous or {}
    access, expires = data.get("access_token"), data.get("expires_in")
    if not isinstance(access, str) or not 16 <= len(access) <= 32768 or type(expires) is not int or not 0 < expires <= 366*86400:
        raise LoginError("login_token_invalid", "The provider returned an invalid access grant.", 502)
    return {**old, "access_token": access, "refresh_token": data.get("refresh_token") or old.get("refresh_token", ""), "expires_at": time.time()+expires}
