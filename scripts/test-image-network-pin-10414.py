"""Public-IP socket pinning and real local TLS hostname verification fixtures."""
from datetime import datetime, timedelta, timezone
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
from pathlib import Path
import socket
import ssl
import sys
import threading

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.security import UnsafeImageUrl
from backend import security
from backend.utils import images
from backend.utils import image_transport
from backend.utils.image_transport import (PinnedImageNetworkBackend,
    PinnedImageTransport, PinnedSocketStream)


def dns_record(address, port=80):
    ipv6 = ':' in address
    return (socket.AF_INET6 if ipv6 else socket.AF_INET, socket.SOCK_STREAM,
            socket.IPPROTO_TCP, '', (address, port, 0, 0) if ipv6 else (address, port))


class FakeSocket:
    def __init__(self, family, kind, proto):
        self.address = None
        self.closed = False
        self.sent = bytearray()
    def setsockopt(self, *args):
        pass
    def settimeout(self, value):
        self.timeout = value
    def connect(self, address):
        self.address = address
    def getpeername(self):
        return self.address
    def close(self):
        self.closed = True


@pytest.mark.parametrize('address', ['127.0.0.1', '10.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.0.1', '100.64.0.1', '100.100.100.200',
    '0.0.0.0', '224.0.0.1', '::1', 'fe80::1',
    'fc00::1', '::', 'ff02::1', '::ffff:127.0.0.1',
    '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe'])
def test_private_ipv4_ipv6_never_opens_a_socket(address):
    created = []
    backend = PinnedImageNetworkBackend(resolver=lambda *a: [dns_record(address)],
        socket_factory=lambda *a: created.append(a), allow_private=False)
    with pytest.raises(UnsafeImageUrl):
        backend.connect_tcp('images.test', 80)
    assert created == []


def test_mixed_dns_result_blocks_before_public_or_private_connection():
    created = []
    backend = PinnedImageNetworkBackend(resolver=lambda *a: [dns_record('8.8.8.8'),
        dns_record('127.0.0.1')], socket_factory=lambda *a: created.append(a), allow_private=False)
    with pytest.raises(UnsafeImageUrl):
        backend.connect_tcp('mixed.test', 80)
    assert created == []


@pytest.mark.parametrize('address', ['8.8.8.8', '2606:4700:4700::1111'])
def test_connection_uses_numeric_snapshot_without_second_dns_lookup(address):
    lookups = []
    sockets = []
    def resolver(host, port, *args):
        lookups.append(host)
        # A second DNS answer would rebound to loopback. There must not be one.
        return [dns_record(address if len(lookups) == 1 else '127.0.0.1', port)]
    def factory(*args):
        sock = FakeSocket(*args)
        sockets.append(sock)
        return sock
    backend = PinnedImageNetworkBackend(resolver=resolver, socket_factory=factory,
                                        allow_private=False)
    stream = backend.connect_tcp('rebind.test', 80, timeout=1)
    assert lookups == ['rebind.test']
    assert sockets[0].address[0] == address
    assert isinstance(stream, PinnedSocketStream)
    stream.close()
    assert sockets[0].closed


def test_download_rechecks_changed_dns_at_socket_boundary(monkeypatch):
    lookups = []
    sockets = []
    def resolver(host, port, *args, **kwargs):
        lookups.append(host)
        return [dns_record('8.8.8.8' if len(lookups) == 1 else '127.0.0.1', port or 80)]
    monkeypatch.setattr(socket, 'getaddrinfo', resolver)
    monkeypatch.setattr(socket, 'socket', lambda *a, **k: sockets.append(a))
    monkeypatch.setattr(security, 'settings', replace(security.settings, allow_private_image_hosts=False))
    monkeypatch.setattr(image_transport, 'settings', replace(image_transport.settings, allow_private_image_hosts=False))
    with pytest.raises(UnsafeImageUrl):
        images.download('http://rebind.test/image.png')
    assert lookups == ['rebind.test', 'rebind.test'] and sockets == []


def test_socket_peer_must_match_selected_public_address():
    class WrongPeer(FakeSocket):
        def getpeername(self):
            return ('127.0.0.1', 80)
    sockets = []
    def factory(*args):
        sock = WrongPeer(*args)
        sockets.append(sock)
        return sock
    backend = PinnedImageNetworkBackend(resolver=lambda *a: [dns_record('8.8.8.8')],
                                        socket_factory=factory, allow_private=False)
    with pytest.raises(UnsafeImageUrl):
        backend.connect_tcp('peer.test', 80)
    assert sockets[0].closed


@pytest.fixture
def tls_server(tmp_path):
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'images.test')])
    now = datetime.now(timezone.utc)
    certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
        .public_key(private.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1)).not_valid_after(now + timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName('images.test')]), False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), True)
        .sign(private, hashes.SHA256()))
    cert_path, key_path = tmp_path / 'fixture-cert.pem', tmp_path / 'fixture-key.pem'
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(private.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    observed = {'host': [], 'sni': []}
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def do_GET(self):
            observed['host'].append(self.headers['Host'])
            self.send_response(200)
            self.send_header('Content-Length', '7')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(b'fixture')
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    context.set_servername_callback(lambda sock, name, ctx: observed['sni'].append(name))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port, cert_path, observed
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_real_tls_keeps_original_sni_host_and_certificate_validation(tls_server):
    port, cert, observed = tls_server
    backend = PinnedImageNetworkBackend(resolver=lambda host, target, *a:
        [dns_record('127.0.0.1', target)], allow_private=True)
    context = ssl.create_default_context(cafile=str(cert))
    with httpx.Client(transport=PinnedImageTransport(backend=backend, ssl_context=context),
                      trust_env=False, timeout=2) as client:
        response = client.get(f'https://images.test:{port}/fixture.png')
    assert response.content == b'fixture'
    assert observed == {'host': [f'images.test:{port}'], 'sni': ['images.test']}
    assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED


def test_real_tls_rejects_wrong_original_hostname(tls_server):
    port, cert, observed = tls_server
    backend = PinnedImageNetworkBackend(resolver=lambda host, target, *a:
        [dns_record('127.0.0.1', target)], allow_private=True)
    with httpx.Client(transport=PinnedImageTransport(backend=backend,
        ssl_context=ssl.create_default_context(cafile=str(cert))), trust_env=False, timeout=2) as client:
        with pytest.raises(httpx.ConnectError):
            client.get(f'https://different.test:{port}/fixture.png')
    assert observed == {'host': [], 'sni': ['different.test']}


def test_tls_verification_cannot_be_disabled():
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    with pytest.raises(ValueError, match='verification'):
        PinnedImageTransport(ssl_context=context)


def test_download_preserves_streamed_image_and_ignores_environment_proxy(monkeypatch):
    observed = []
    def reply(request):
        observed.append(request)
        return httpx.Response(200, headers={'Content-Type': 'image/png'}, stream=httpx.ByteStream(b'fixture-png'))
    monkeypatch.setattr(images, 'assert_image_url_allowed', lambda url: None)
    monkeypatch.setattr(images, 'PinnedImageTransport', lambda: httpx.MockTransport(reply))
    monkeypatch.setenv('HTTPS_PROXY', 'http://127.0.0.1:1')
    monkeypatch.setenv('ALL_PROXY', 'socks5://127.0.0.1:1')
    blob, mime = images.download('https://images.test/fixture.png', referer='https://reader.test/')
    assert blob == b'fixture-png' and mime == 'image/png'
    assert observed[0].headers['Host'] == 'images.test'
    assert observed[0].headers['Referer'] == 'https://reader.test/'
    # 2026.10.16.3: compressed transfers are accepted again (as before .91),
    # decoded here with the size cap on the decoded bytes.
    assert observed[0].headers['Accept-Encoding'] == images._ACCEPT_ENCODING
    assert 'gzip' in images._ACCEPT_ENCODING and 'deflate' in images._ACCEPT_ENCODING


def _serve(monkeypatch, encoding, body):
    def reply(request):
        return httpx.Response(200, headers={'Content-Type': 'image/png', 'Content-Encoding': encoding},
                              stream=httpx.ByteStream(body))
    monkeypatch.setattr(images, 'assert_image_url_allowed', lambda url: None)
    monkeypatch.setattr(images, 'PinnedImageTransport', lambda: httpx.MockTransport(reply))


@pytest.mark.parametrize('encoding', ['gzip', 'deflate', 'identity, gzip'])
def test_compressed_http_body_is_decoded_with_the_cap_on_decoded_bytes(monkeypatch, encoding):
    import gzip, zlib
    payload = b'\x89PNG fixture ' * 100
    body = zlib.compress(payload) if encoding == 'deflate' else gzip.compress(payload)
    _serve(monkeypatch, encoding, body)
    blob, mime = images.download('https://images.test/compressed.png')
    assert blob == payload and mime == 'image/png'


def test_compression_bomb_stops_at_the_decoded_size_cap(monkeypatch):
    import dataclasses, gzip
    bomb = gzip.compress(b'\0' * (8 * 1024 * 1024))
    _serve(monkeypatch, 'gzip', bomb)
    monkeypatch.setattr(images, 'settings', dataclasses.replace(images.settings, max_image_bytes=1024 * 1024))
    decoded = []
    real_emit = images._BoundedDecoder._emit
    def emit(self, data):
        decoded.append(len(data))
        return real_emit(self, data)
    monkeypatch.setattr(images._BoundedDecoder, '_emit', emit)
    with pytest.raises(images.ImageTooLarge):
        images.download('https://images.test/bomb.png')
    assert sum(decoded) <= 1024 * 1024 + 1, 'never inflates past the cap'


@pytest.mark.parametrize('encoding', ['zstd', 'compress', 'gzip, br'])
def test_undecodable_transfer_is_an_image_fetch_failure(monkeypatch, encoding):
    if encoding == 'br' and images._brotli is not None:
        pytest.skip('brotli installed')
    _serve(monkeypatch, encoding, b'\x00\x01')
    with pytest.raises(images.ImageTransferError) as caught:
        images.download('https://images.test/odd.png')
    assert caught.value.tp_stage == 'image_fetch'  # the browser may fetch it instead


def test_redirect_to_private_destination_is_refused(monkeypatch):
    checked = []
    def check(url):
        checked.append(url)
        if '127.0.0.1' in url:
            raise UnsafeImageUrl('fixture private redirect')
    def reply(request):
        return httpx.Response(302, headers={'Location': 'http://127.0.0.1/internal'})
    monkeypatch.setattr(images, 'assert_image_url_allowed', check)
    monkeypatch.setattr(images, 'PinnedImageTransport', lambda: httpx.MockTransport(reply))
    with pytest.raises(UnsafeImageUrl):
        images.download('https://images.test/public.png')
    assert checked == ['https://images.test/public.png', 'http://127.0.0.1/internal']
