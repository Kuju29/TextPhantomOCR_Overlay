"""Image byte helpers: base64 / data-URI conversion and remote downloads.

"""

from __future__ import annotations

import base64
import hashlib

import httpx

from backend.config import settings
from backend.security import UnsafeImageUrl, assert_image_url_allowed

_DOWNLOAD_USER_AGENT = "Mozilla/5.0 (TextPhantomOCR; +https://huggingface.co/spaces)"


class ImageTooLarge(RuntimeError):
    """A remote image exceeded ``TP_MAX_IMAGE_BYTES``."""


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
    address. The body is also size-capped: the caller-supplied URL used to be
    able to stream an unbounded response into the worker's memory.
    """
    u = (url or "").strip()
    if not u:
        return b"", ""

    headers = {"user-agent": _DOWNLOAD_USER_AGENT}
    ref = (referer or "").strip()
    if ref:
        headers["referer"] = ref

    # Checked before anything is opened, so a refused URL costs no connection.
    assert_image_url_allowed(u)

    limit = settings.max_image_bytes
    with httpx.Client(
        timeout=settings.http_timeout_sec,
        follow_redirects=False,
        headers=headers,
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

                declared = r.headers.get("content-length")
                if declared and int(declared) > limit:
                    raise ImageTooLarge(
                        f"image is {declared} bytes, limit is {limit} "
                        f"(raise TP_MAX_IMAGE_BYTES to allow it)"
                    )

                chunks: list[bytes] = []
                total = 0
                for chunk in r.iter_bytes():
                    total += len(chunk)
                    if total > limit:
                        raise ImageTooLarge(
                            f"image exceeded {limit} bytes while downloading "
                            f"(raise TP_MAX_IMAGE_BYTES to allow it)"
                        )
                    chunks.append(chunk)

                content_type = (r.headers.get("content-type") or "").split(";")[0].strip()
                return b"".join(chunks), content_type

    raise UnsafeImageUrl(
        f"too many redirects while fetching the image "
        f"(limit {settings.max_image_redirects})"
    )
