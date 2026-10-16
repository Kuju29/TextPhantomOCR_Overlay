"""Image byte helpers: base64 / data-URI conversion and remote downloads.

"""

from __future__ import annotations

import httpx, base64, hashlib, time, zlib

from backend.config import settings
from backend.security import UnsafeImageUrl, assert_image_url_allowed
from backend.utils.image_transport import PinnedImageTransport

_DOWNLOAD_USER_AGENT = "Mozilla/5.0 (TextPhantomOCR; +https://huggingface.co/spaces)"

class ImageTooLarge(RuntimeError):
    """A remote image exceeded ``TP_MAX_IMAGE_BYTES``."""

class ImageTransferError(RuntimeError):
    """The image response's transfer encoding could not be decoded.

    A site problem, not a security refusal: stamped ``image_fetch`` so the
    client may fetch the image in the browser instead.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.tp_stage = "image_fetch"

try:  # optional, only when the deployment installed a Brotli binding
    import brotli as _brotli  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001
    _brotli = None

# Advertise only what can be decoded here (br only with a Brotli binding).
_ACCEPT_ENCODING = "gzip, deflate, br" if _brotli is not None else "gzip, deflate"


class _BoundedDecoder:
    """Content-Encoding decoder whose OUTPUT is capped at ``limit`` bytes."""

    def __init__(self, encoding: str | None, limit: int) -> None:
        codings = [c.strip().lower() for c in str(encoding or "").split(",") if c.strip()]
        codings = [c for c in codings if c != "identity"]
        if len(codings) > 1:
            raise ImageTransferError(f"stacked content-encodings are not supported ({encoding})")
        self.coding = codings[0] if codings else ""
        self.identity = not self.coding
        self.limit = int(limit)
        self.total = 0
        self.chunks: list[bytes] = []
        self._zlib = None
        self._br = None
        if self.coding in ("gzip", "x-gzip"):
            self._zlib = zlib.decompressobj(zlib.MAX_WBITS | 16)
        elif self.coding == "deflate":
            self._zlib = None  # zlib-wrapped or raw: decided on the first bytes
        elif self.coding == "br" and _brotli is not None:
            self._br = _brotli.Decompressor()
        elif not self.identity:
            raise ImageTransferError(f"unsupported image content-encoding {self.coding!r}")

    def _emit(self, data: bytes) -> None:
        if not data:
            return
        self.total += len(data)
        if self.total > self.limit:
            raise ImageTooLarge(
                f"image exceeded {self.limit} bytes while downloading "
                f"(raise TP_MAX_IMAGE_BYTES to allow it)"
            )
        self.chunks.append(data)

    def _inflate(self, data: bytes) -> None:
        obj = self._zlib
        buf = data
        while buf:
            out = obj.decompress(buf, self.limit - self.total + 1)
            self._emit(out)
            buf = obj.unconsumed_tail

    def feed(self, chunk: bytes) -> None:
        if not chunk:
            return
        if self.identity:
            self._emit(chunk)
            return
        if self._br is not None:
            self._emit(self._br.process(chunk))
            return
        if self._zlib is None and self.coding == "deflate":
            # RFC 9110 "deflate" is zlib-wrapped; some servers send raw deflate.
            wbits = zlib.MAX_WBITS if (len(chunk) >= 2 and (chunk[0] * 256 + chunk[1]) % 31 == 0
                                       and chunk[0] & 0x0F == 8) else -zlib.MAX_WBITS
            self._zlib = zlib.decompressobj(wbits)
        try:
            self._inflate(chunk)
        except zlib.error as exc:
            raise ImageTransferError(f"invalid {self.coding} image transfer") from exc

    def finish(self) -> bytes:
        if self._zlib is not None:
            try:
                self._emit(self._zlib.flush())
            except zlib.error as exc:
                raise ImageTransferError(f"invalid {self.coding} image transfer") from exc
        return b"".join(self.chunks)

def sha256_hex(blob: bytes) -> str:
    """Hex SHA-256 of ``blob`` (empty string for empty input)."""
    return hashlib.sha256(blob).hexdigest() if blob else ""

def b64_to_bytes(b64: str) -> bytes:
    """Decode base64, tolerating missing ``=`` padding."""
    pad = "=" * ((4 - (len(b64) % 4)) % 4)
    return base64.b64decode(b64 + pad)

def data_uri_to_bytes(data_uri: str) -> tuple[bytes, str]:
    """Split a ``data:`` URI into ``(raw_bytes, mime_type)``.

    Returns ``(b"", "")`` if the input is not a data URI.
    """
    s = (data_uri or "").strip()
    if not s.startswith("data:"):
        return b"", ""
    head, _, b64 = s.partition(",")
    mime = ""
    if ";" in head:
        mime = head[5 : head.index(";")]
    return b64_to_bytes(b64), mime or "application/octet-stream"

def bytes_to_data_uri(blob: bytes, mime: str) -> str:
    """Encode raw bytes as a ``data:<mime>;base64,...`` URI."""
    b64 = base64.b64encode(blob).decode("ascii")
    return f"data:{mime};base64,{b64}"

def download(url: str, referer: str = "") -> tuple[bytes, str]:
    """Fetch ``url`` and return ``(content, content_type)``.

    A ``referer`` header is attached when supplied — some CDNs hot-link
    protect their images and reject requests without it.

    Redirects are followed MANUALLY so that every hop passes the SSRF policy.
    With ``follow_redirects=True`` only the first URL would ever be checked,
    and an attacker-controlled host could 302 the server to an internal
    address. The body is also size-capped so a caller-supplied URL cannot
    stream an unbounded response into the worker's memory.
    """
    u = (url or "").strip()
    if not u:
        return b"", ""

    # Some CDNs/WAFs gzip everything, images included, whatever we ask for.
    # The pre-.91 API accepted that (httpx's default decoding); refusing it made
    # those sites fail. Decode here ourselves, bounded: the size cap applies to
    # the DECODED bytes and the decoder never produces more than the cap + 1
    # byte per step, so a compression bomb cannot expand past the limit.
    headers = {"user-agent": _DOWNLOAD_USER_AGENT, "accept-encoding": _ACCEPT_ENCODING}
    ref = (referer or "").strip()
    if ref:
        headers["referer"] = ref

    # Checked before anything is opened, so a refused URL costs no connection.
    assert_image_url_allowed(u)

    limit = settings.max_image_bytes
    total_budget = max(1.0, float(settings.http_timeout_sec))
    deadline = time.monotonic() + total_budget
    timeout = httpx.Timeout(total_budget, connect=min(15.0, total_budget),
                            read=min(30.0, total_budget))
    with httpx.Client(
        timeout=timeout,
        follow_redirects=False,
        headers=headers,
        transport=PinnedImageTransport(),
        trust_env=False,
    ) as client:
        for _hop in range(settings.max_image_redirects + 1):
            with client.stream("GET", u) as r:
                if r.is_redirect:
                    location = r.headers.get("location") or ""
                    if not location:
                        raise UnsafeImageUrl(f"redirect from {u} carried no Location")
                    u = str(httpx.URL(u).join(location))
                    assert_image_url_allowed(u)  # every hop, not just the first
                    continue
                r.raise_for_status()

                decoder = _BoundedDecoder(r.headers.get("content-encoding"), limit)

                declared = r.headers.get("content-length")
                if declared and decoder.identity and int(declared) > limit:
                    raise ImageTooLarge(
                        f"image is {declared} bytes, limit is {limit} "
                        f"(raise TP_MAX_IMAGE_BYTES to allow it)"
                    )

                for chunk in r.iter_raw(chunk_size=64 * 1024):
                    decoder.feed(chunk)
                    if time.monotonic() > deadline:
                        raise httpx.ReadTimeout(
                            f"image download exceeded {total_budget:g}s in total")
                content = decoder.finish()

                content_type = (r.headers.get("content-type") or "").split(";")[0].strip()
                return content, content_type

    raise UnsafeImageUrl(
        f"too many redirects while fetching the image "
        f"(limit {settings.max_image_redirects})"
    )
