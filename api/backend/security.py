"""Request-boundary security policy.

Public Cloud routes require request-owned credentials and never use
AI_API_KEY; these guards also protect legacy/internal callers. Threats:

1. **Server API-key exfiltration.** A caller-chosen AI ``base_url`` combined
   with a server-owned key would post ``Authorization: Bearer <server key>``
   to an attacker. :func:`assert_ai_base_url_allowed` refuses that combination.

2. **SSRF via the image ``src``.** A caller URL such as
   ``http://169.254.169.254/`` (cloud metadata) or a private-network host.
   :func:`assert_image_url_allowed` rejects those on *every redirect hop*,
   because an attacker-controlled host can 302 to the internal address.

Both raise instead of quietly substituting a safe default: a request that
tried to do one of these things is a request the operator wants to see in the
logs, not one that should look like it succeeded.
"""

from __future__ import annotations

from urllib.parse import urlparse

import socket, ipaddress

from backend.ai.provider_registry import provider_registry
from backend.config import settings

class SecurityError(RuntimeError):
    """Base class for policy violations at the request boundary."""

class UnsafeBaseUrl(SecurityError):
    """The requested AI base URL is not allowed for this key."""

class UnsafeImageUrl(SecurityError):
    """The requested image URL points somewhere the server must not fetch."""

# --- AI base URL ------------------------------------------------------------


def _is_keyless_local_endpoint(provider: str, url: str) -> bool:
    """Allow a keyless local runtime without opening a general SSRF path.

    API-owned Local AI is limited to this API host's loopback interface. LAN
    runtimes must be explicitly allow-listed by the operator in
    ``TP_AI_EXTRA_HOSTS``; browser-owned Local AI has its own private-LAN guard.
    """
    spec = provider_registry.get((provider or "").strip().lower())
    if spec is None or not spec.local:
        return False
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
            return False
        if parsed.query or parsed.fragment:
            return False
        host = (parsed.hostname or "").strip().lower()
        if host == "localhost" or host.endswith(".localhost"):
            return True
        return bool(host and ipaddress.ip_address(host).is_loopback)
    except (ValueError, TypeError):
        return False

def assert_ai_base_url_allowed(
    provider: str, base_url: str, *, user_key: bool, key_present: bool = True,
) -> None:
    """Enforce the server's network policy even for request-owned credentials.

    A BYOK credential is not permission to reach server-private networks. Shared
    installations allow only registry endpoints or exact operator-approved hosts.
    Personal installations may additionally reach Local AI on loopback. There is
    no user-controlled switch and no wildcard/suffix allowlist matching.
    """
    url = (base_url or "").strip()
    if provider == "paid":
        from backend.paid_center import center_base_url
        approved = center_base_url() + "/api/customer" if center_base_url() else ""
        if not approved or url != approved:
            raise UnsafeBaseUrl("Paid endpoint must be the operator-configured Center")
        return
    if not url:
        spec = provider_registry.get(provider)
        # Native adapters with no configurable base (currently Gemini) own a
        # fixed URL internally; empty here is not a caller-selected destination.
        if spec is not None and not spec.local and spec.default_base_url == "":
            return
        raise UnsafeBaseUrl("AI base_url is empty")
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port  # invalid/out-of-range ports fail before any I/O
        if (parsed.scheme not in ("http", "https") or not host or
                parsed.username is not None or parsed.password is not None or
                parsed.query or parsed.fragment or any(c.isspace() or ord(c) < 32 for c in url) or
                "\\" in url):
            raise ValueError()
    except (ValueError, TypeError):
        raise UnsafeBaseUrl("AI base_url must be an http(s) endpoint without userinfo, query or fragment") from None
    policy = str(settings.ai_endpoint_policy).strip().lower()
    if policy not in ("shared", "personal"):
        raise UnsafeBaseUrl("TP_AI_ENDPOINT_POLICY must be shared or personal")
    # Explicit exact hostname grants; ports on these hosts are operator-owned.
    extras = {h.strip().lower().rstrip(".") for h in settings.ai_extra_hosts.split(",") if h.strip()}
    if host in extras:
        return
    if policy == "personal" and _is_keyless_local_endpoint(provider, url):
        return
    for spec in provider_registry:
        if spec.local or spec.provider_id == "paid":
            continue
        default = urlparse(str(spec.default_base_url or ""))
        default_port = default.port or (443 if default.scheme == "https" else 80)
        if (host == (default.hostname or "").lower() and parsed.scheme == default.scheme and
                (port or (443 if parsed.scheme == "https" else 80)) == default_port):
            return
    raise UnsafeBaseUrl(
        f"AI endpoint is not approved by the server network policy "
        f"(provider={provider or 'auto'}, host={host}, policy={policy}). "
        "A user API key does not bypass this policy. The operator can add an exact "
        "host to TP_AI_EXTRA_HOSTS; for a private personal installation using Local AI "
        "on loopback, set TP_AI_ENDPOINT_POLICY=personal."
    )

# --- Image URLs (SSRF) ------------------------------------------------------

_ALLOWED_IMAGE_SCHEMES = ("http", "https")

def _ip_is_forbidden(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Whether an address belongs to a range the server must never fetch."""
    # A NAT64 gateway can translate this globally routable IPv6 prefix back
    # into a server-private IPv4 address. Check that embedded destination too.
    if ip.version == 6 and ip in ipaddress.ip_network('64:ff9b::/96'):
        if _ip_is_forbidden(ipaddress.IPv4Address(int(ip) & 0xffffffff)):
            return True
    return bool(
        not ip.is_global
        or ip.is_private
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
