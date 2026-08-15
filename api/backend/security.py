"""Request-boundary security policy.


Two attacks are closed here, both of which were reachable from any web page
because the API has open CORS and no authentication:

1. **Server API-key exfiltration.** ``/translate`` let the caller choose the
   AI ``base_url`` while ``api_key`` silently fell back to the server's own
   ``AI_API_KEY``. A request with ``base_url = "https://attacker.example/v1"``
   therefore made the server post ``Authorization: Bearer <server key>`` to
   the attacker. :func:`assert_ai_base_url_allowed` refuses that combination.

2. **SSRF via the image ``src``.** ``utils.images.download`` fetched any URL
   the caller supplied, including ``http://169.254.169.254/`` (cloud instance
   metadata) and hosts inside the deployment's private network.
   :func:`assert_image_url_allowed` rejects those, and it is applied to *every
   redirect hop* — checking only the first URL is not enough, because an
   attacker-controlled host can simply 302 to the internal address.

Both raise instead of quietly substituting a safe default: a request that
tried to do one of these things is a request the operator wants to see in the
logs, not one that should look like it succeeded.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

from backend.ai.config import PROVIDER_DEFAULTS
from backend.config import settings


class SecurityError(RuntimeError):
    """Base class for policy violations at the request boundary."""


class UnsafeBaseUrl(SecurityError):
    """The requested AI base URL is not allowed for this key."""


class UnsafeImageUrl(SecurityError):
    """The requested image URL points somewhere the server must not fetch."""


# --- AI base URL ------------------------------------------------------------


def _host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").strip().lower()
    except ValueError:
        return ""


def server_key_allowed_hosts() -> frozenset[str]:
    """Hosts the SERVER-OWNED key may ever be sent to.

    The provider defaults plus anything the operator explicitly added via
    ``TP_AI_EXTRA_HOSTS`` (comma-separated). Local/self-hosted providers are
    deliberately excluded: ``localhost`` means the *server's* localhost, and
    the server key has no business going there.
    """
    hosts = {
        _host_of(str(d.get("base_url") or ""))
        for d in PROVIDER_DEFAULTS.values()
    }
    hosts.discard("")
    hosts.discard("localhost")
    hosts.discard("127.0.0.1")
    for extra in settings.ai_extra_hosts.split(","):
        h = extra.strip().lower()
        if h:
            hosts.add(h)
    return frozenset(hosts)


def assert_ai_base_url_allowed(provider: str, base_url: str, *, user_key: bool) -> None:
    """Raise :class:`UnsafeBaseUrl` if this base URL may not receive this key.

    ``user_key=True``  — the caller supplied their own credential. Only their
                         key is at risk, so any endpoint is allowed (this is
                         what makes self-hosted LLM servers work).
    ``user_key=False`` — the request fell back to the server's ``AI_API_KEY``.
                         The endpoint must then be one the operator chose.
    """
    url = (base_url or "").strip()
    if user_key or not url:
        return

    host = _host_of(url)
    allowed = server_key_allowed_hosts()
    if host and host in allowed:
        return

    raise UnsafeBaseUrl(
        f"custom AI base_url is not allowed without your own api_key "
        f"(provider={provider or 'auto'}, host={host or 'none'}). "
        f"Send an 'ai.api_key' of your own, or ask the operator to add this "
        f"host to TP_AI_EXTRA_HOSTS."
    )


# --- Image URLs (SSRF) ------------------------------------------------------

_ALLOWED_IMAGE_SCHEMES = ("http", "https")


def _ip_is_forbidden(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Whether an address belongs to a range the server must never fetch."""
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local        # 169.254.0.0/16 — cloud metadata lives here
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
        or (ip.version == 6 and ip.ipv4_mapped is not None and _ip_is_forbidden(ip.ipv4_mapped))
    )


def resolve_host_addresses(host: str) -> list[str]:
    """Resolve ``host`` to every address it currently maps to.

    Split out so tests can substitute a resolver without touching DNS.
    """
    infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    return [str(info[4][0]) for info in infos]


def assert_image_url_allowed(url: str, *, resolver=resolve_host_addresses) -> None:
    """Raise :class:`UnsafeImageUrl` unless ``url`` is a public http(s) URL.

    Call this for the original URL *and* for every redirect target.
    """
    raw = (url or "").strip()
    if not raw:
        raise UnsafeImageUrl("image url is empty")

    parsed = urlparse(raw)
    scheme = (parsed.scheme or "").lower()
    if scheme not in _ALLOWED_IMAGE_SCHEMES:
        raise UnsafeImageUrl(f"image url scheme '{scheme or 'none'}' is not allowed")

    host = (parsed.hostname or "").strip()
    if not host:
        raise UnsafeImageUrl("image url has no host")

    if settings.allow_private_image_hosts:
        # Explicitly enabled for local deployments (the desktop launcher, where
        # the "server" and the user are the same machine). Logged at boot.
        return

    # A bare IP literal is checked directly; a name is checked against every
    # address it resolves to, so a hostname pointing at 127.0.0.1 is caught.
    try:
        addresses = [str(ipaddress.ip_address(host))]
    except ValueError:
        try:
            addresses = resolver(host)
        except socket.gaierror as exc:
            raise UnsafeImageUrl(f"image url host '{host}' does not resolve") from exc

    if not addresses:
        raise UnsafeImageUrl(f"image url host '{host}' does not resolve")

    for addr in addresses:
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            raise UnsafeImageUrl(f"image url host '{host}' resolved to '{addr}'") from None
        if _ip_is_forbidden(ip):
            raise UnsafeImageUrl(
                f"image url host '{host}' resolves to non-public address {addr}"
            )
