"""Decides whether a request may ask this server to drop its fairness gates."""

from __future__ import annotations

import os, ipaddress

from fastapi import Request

_HEADER = "x-tp-local-unlimited"

_FORWARDED = ("x-forwarded-for", "forwarded", "x-real-ip")

# On a Hugging Face Space every visitor arrives through HF's private-address
# proxy, so "the peer is local" would let anyone skip the shared gates. A Space
# (SPACE_ID / SPACE_HOST set) defaults to off; an operator may still set
# TP_ALLOW_LOCAL_UNLIMITED=1 explicitly.
def _enabled() -> bool:
    raw = os.environ.get("TP_ALLOW_LOCAL_UNLIMITED")
    if raw is None:
        return not (os.environ.get("SPACE_ID") or os.environ.get("SPACE_HOST"))
    return str(raw).strip().lower() not in ("0", "false", "no", "off")

# Whether the peer is this machine or the local network. A client's own claim is
# never enough: the gates exist to share a public server, so only a caller that
# is demonstrably not remote may switch them off.
def is_local_peer(request: Request) -> bool:
    host = getattr(getattr(request, "client", None), "host", "") or ""
    if host in ("", "testclient"):
        return False
    # Came through a proxy: the original caller is unknown, so it is not local.
    if any(request.headers.get(name) for name in _FORWARDED):
        return False
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return host.lower() in ("localhost", "::1")
    return addr.is_loopback or addr.is_private or addr.is_link_local

# True only when the caller asked for it, the peer is local, and the operator has
# not disabled the whole facility with TP_ALLOW_LOCAL_UNLIMITED=0.
def wants_unlimited(request: Request) -> bool:
    if not _enabled():
        return False
    if str(request.headers.get(_HEADER, "")).strip() not in ("1", "true", "yes", "on"):
        return False
    return is_local_peer(request)
