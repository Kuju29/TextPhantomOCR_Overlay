"""Who a request belongs to when lanes are shared fairly.

The admission gates (backend/jobs/admission.py) split each lane between the
people using it. ``fair_key`` there needs request-level evidence that the route
body does not carry; :func:`request_owner` extracts it once per request from the
ASGI scope, and ``IdentityQuotaMiddleware`` binds it for the request.

Order of evidence (first one present wins, see ``admission.fair_key``):

1. ``X-TP-Install`` (32 hex) — one browser install, all of its tabs.
2. The tab session (from the request body/form; old clients send only this).
3. The client IP — see :func:`fairness_client_ip`.
4. A hash of the request's AI key or ``Authorization`` header.

Fairness is NOT a security boundary: every one of these is chosen or
influenced by the client, exactly like the tab session always was. A client
that rotates them gets more queue turns, never more than the lane's concurrency
limit, and never more than its memory share. Security decisions (rate quotas,
local-unlimited, paid sign-in) keep their own stricter rules in ingress.py,
local_client.py and paid_center.py.

Client IP, works on any hosting without configuration:

* ``TP_TRUSTED_PROXY_IPS`` set: Uvicorn's proxy middleware has already replaced
  the peer with the forwarded client when (and only when) the peer is one of
  those proxies, so the peer address is used as is.
* Otherwise, when the TCP peer is loopback/private/link-local (a reverse proxy
  on the same machine or network: nginx, Caddy, cloudflared, a Hugging Face
  Space's ingress), the address that proxy appended to ``X-Forwarded-For``
  (the right-most entry, or ``TP_FAIRNESS_FORWARDED_HOPS`` from the right) is
  used.
* A public (global) peer is the client itself; ``X-Forwarded-For`` from it is
  ignored, so a directly exposed server cannot be steered by a spoofed header.

``TP_FAIRNESS_FORWARDED`` = ``private`` (default), ``trusted`` (only peers in
``TP_TRUSTED_PROXY_IPS``) or ``off`` (always the TCP peer).
``TP_FAIRNESS_FORWARDED_HEADER`` names the header (default ``x-forwarded-for``;
e.g. ``cf-connecting-ip`` or ``x-real-ip`` for a single-value header).
"""

from __future__ import annotations

import hashlib
import ipaddress
import os

from backend.jobs.admission import RequestOwner


def _env(name: str, default: str) -> str:
    return (os.environ.get(name) or default).strip()


def _opaque(kind: str, value: str) -> str:
    return kind + ":" + hashlib.sha256((kind + "\0" + value).encode()).hexdigest()[:24]


def _header(scope, name: bytes) -> str:
    for key, value in scope.get("headers") or ():
        if key == name:
            try:
                return value.decode("latin-1")
            except UnicodeDecodeError:
                return ""
    return ""


def _ip(value: str):
    raw = str(value or "").strip()
    if raw.startswith("[") and "]" in raw:
        raw = raw[1:raw.index("]")]
    elif raw.count(":") == 1 and "." in raw:
        raw = raw.split(":", 1)[0]  # "1.2.3.4:5678"
    try:
        return ipaddress.ip_address(raw)
    except ValueError:
        return None


def _trusted_networks() -> list:
    try:
        from backend.paid_center import trusted_proxy_hosts
        hosts = trusted_proxy_hosts()
    except Exception:
        return []
    out = []
    for item in hosts:
        try:
            out.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            continue
    return out


def _peer_forwards(peer, mode: str) -> bool:
    if mode == "off":
        return False
    trusted = _trusted_networks()
    if any(peer in net for net in trusted):
        return True
    if mode == "trusted":
        return False
    return bool(peer.is_loopback or peer.is_private or peer.is_link_local)


def fairness_client_ip(scope) -> str:
    """Best client-IP evidence for fairness (see module docstring); "" if none."""
    client = scope.get("client") or (None, None)
    peer = _ip(client[0] if client else "")
    if peer is None:
        return ""
    mode = _env("TP_FAIRNESS_FORWARDED", "private").lower()
    if _peer_forwards(peer, mode):
        header = _env("TP_FAIRNESS_FORWARDED_HEADER", "x-forwarded-for").lower().encode("latin-1")
        values = [part.strip() for part in _header(scope, header).split(",") if part.strip()]
        try:
            hops = max(1, int(_env("TP_FAIRNESS_FORWARDED_HOPS", "1")))
        except ValueError:
            hops = 1
        if len(values) >= hops:
            forwarded = _ip(values[-hops])
            if forwarded is not None:
                return str(forwarded)
    return str(peer)


def request_owner(scope) -> RequestOwner:
    from backend.api.ingress import install_id
    install = install_id(_header(scope, b"x-tp-install").strip())
    ip = fairness_client_ip(scope)
    auth = _header(scope, b"authorization").strip()
    return RequestOwner(
        install=_opaque("install", install) if install else "",
        ip=_opaque("ip", ip) if ip else "",
        auth=_opaque("auth", auth) if auth else "",
    )
