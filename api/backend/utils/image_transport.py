"""Image HTTP connections pinned to a checked DNS snapshot.

Only the socket destination changes: HTTP Host, HTTPS SNI and certificate
hostname validation still use the original URL. Environment proxies are not
used because they can resolve the destination outside this network policy.
"""
from __future__ import annotations

from contextlib import contextmanager
import ipaddress
import select
import socket
import ssl
import time

import httpcore
import httpx

from backend.config import settings
from backend.security import UnsafeImageUrl, _ip_is_forbidden


class PinnedSocketStream(httpcore.NetworkStream):
    def __init__(self, sock):
        self.sock = sock

    def read(self, max_bytes, timeout=None):
        try:
            self.sock.settimeout(timeout)
            return self.sock.recv(max_bytes)
        except socket.timeout as exc:
            raise httpcore.ReadTimeout() from exc
        except OSError as exc:
            raise httpcore.ReadError() from exc

    def write(self, buffer, timeout=None):
        try:
            self.sock.settimeout(timeout)
            self.sock.sendall(buffer)
        except socket.timeout as exc:
            raise httpcore.WriteTimeout() from exc
        except OSError as exc:
            raise httpcore.WriteError() from exc

    def close(self):
        self.sock.close()

    def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        # The request's hostname reaches here through httpcore. Never replace
        # it with the selected numeric destination or disable verification.
        if ssl_context.verify_mode != ssl.CERT_REQUIRED or not ssl_context.check_hostname:
            self.close()
            raise httpcore.ConnectError('image TLS verification is required')
        try:
            self.sock.settimeout(timeout)
            wrapped = ssl_context.wrap_socket(self.sock, server_hostname=server_hostname)
            return PinnedSocketStream(wrapped)
        except socket.timeout as exc:
            self.close()
            raise httpcore.ConnectTimeout() from exc
        except OSError as exc:
            self.close()
            raise httpcore.ConnectError() from exc

    def get_extra_info(self, info):
        if info == 'ssl_object':
            return self.sock if isinstance(self.sock, ssl.SSLSocket) else None
        if info == 'client_addr':
            return self.sock.getsockname()
        if info == 'server_addr':
            return self.sock.getpeername()
        if info == 'socket':
            return self.sock
        if info == 'is_readable':
            return bool(select.select([self.sock], [], [], 0)[0])
        return None


class PinnedImageNetworkBackend(httpcore.NetworkBackend):
    def __init__(self, *, resolver=None, socket_factory=None, allow_private=None):
        self.resolver = resolver
        self.socket_factory = socket_factory
        self.allow_private = allow_private

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        if local_address is not None:
            raise httpcore.ConnectError('image transport does not accept a local address')
        resolver = self.resolver or socket.getaddrinfo
        try:
            records = resolver(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
        except socket.timeout as exc:
            raise httpcore.ConnectTimeout() from exc
        except OSError as exc:
            raise httpcore.ConnectError() from exc
        if not records or len(records) > 64:
            raise UnsafeImageUrl('image destination has no bounded DNS result')
        allow_private = (settings.allow_private_image_hosts if self.allow_private is None
                         else bool(self.allow_private))
        approved = []
        for family, kind, proto, _name, address in records:
            if family not in (socket.AF_INET, socket.AF_INET6) or kind != socket.SOCK_STREAM:
                raise UnsafeImageUrl('image DNS result has an unsupported address')
            try:
                ip = ipaddress.ip_address(address[0])
            except (ValueError, TypeError, IndexError):
                raise UnsafeImageUrl('image DNS result is invalid') from None
            if not allow_private and _ip_is_forbidden(ip):
                raise UnsafeImageUrl('image destination resolves to a non-public address')
            # sockaddr is a numeric IP from this snapshot, not a hostname that
            # socket.create_connection/httpx can resolve a second time.
            candidate = (family, kind, proto, address, ip)
            if candidate not in approved:
                approved.append(candidate)
        factory = self.socket_factory or socket.socket
        deadline = time.monotonic() + timeout if timeout is not None else None
        last_error = None
        for family, kind, proto, address, ip in approved:
            sock = None
            try:
                sock = factory(family, kind, proto)
                for option in socket_options or ():
                    sock.setsockopt(*option)
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                remaining = max(0, deadline - time.monotonic()) if deadline is not None else None
                sock.settimeout(remaining)
                sock.connect(address)
                if ipaddress.ip_address(sock.getpeername()[0]) != ip:
                    raise UnsafeImageUrl('image connection did not reach the approved address')
                return PinnedSocketStream(sock)
            except UnsafeImageUrl:
                if sock is not None:
                    sock.close()
                raise
            except (OSError, ValueError) as exc:
                if sock is not None:
                    sock.close()
                last_error = exc
                if deadline is not None and time.monotonic() >= deadline:
                    raise httpcore.ConnectTimeout() from exc
        if isinstance(last_error, socket.timeout):
            raise httpcore.ConnectTimeout() from last_error
        raise httpcore.ConnectError('image connection failed') from last_error

    def connect_unix_socket(self, *args, **kwargs):
        raise UnsafeImageUrl('image transport does not accept Unix sockets')


_CORE_ERRORS = (
    (httpcore.ConnectTimeout, httpx.ConnectTimeout),
    (httpcore.ReadTimeout, httpx.ReadTimeout),
    (httpcore.WriteTimeout, httpx.WriteTimeout),
    (httpcore.PoolTimeout, httpx.PoolTimeout),
    (httpcore.ConnectError, httpx.ConnectError),
    (httpcore.ReadError, httpx.ReadError),
    (httpcore.WriteError, httpx.WriteError),
    (httpcore.LocalProtocolError, httpx.LocalProtocolError),
    (httpcore.RemoteProtocolError, httpx.RemoteProtocolError),
    (httpcore.UnsupportedProtocol, httpx.UnsupportedProtocol),
)


@contextmanager
def map_core_errors():
    try:
        yield
    except Exception as exc:
        for source, target in _CORE_ERRORS:
            if isinstance(exc, source):
                raise target(str(exc)) from exc
        raise


class ImageResponseStream(httpx.SyncByteStream):
    def __init__(self, stream):
        self.stream = stream

    def __iter__(self):
        with map_core_errors():
            yield from self.stream

    def close(self):
        self.stream.close()


class PinnedImageTransport(httpx.BaseTransport):
    def __init__(self, *, backend=None, ssl_context=None):
        context = ssl_context or httpcore.default_ssl_context()
        if context.verify_mode != ssl.CERT_REQUIRED or not context.check_hostname:
            raise ValueError('image TLS verification is required')
        self.pool = httpcore.ConnectionPool(
            ssl_context=context, network_backend=backend or PinnedImageNetworkBackend(),
            max_connections=4, max_keepalive_connections=4, retries=0, http2=False)

    def handle_request(self, request):
        core_request = httpcore.Request(
            method=request.method, url=httpcore.URL(
                scheme=request.url.raw_scheme, host=request.url.raw_host,
                port=request.url.port, target=request.url.raw_path),
            headers=request.headers.raw, content=request.stream, extensions=request.extensions)
        with map_core_errors():
            response = self.pool.handle_request(core_request)
        return httpx.Response(response.status, headers=response.headers,
                              stream=ImageResponseStream(response.stream), extensions=response.extensions)

    def close(self):
        self.pool.close()
