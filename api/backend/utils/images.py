"""Image byte helpers: base64 / data-URI conversion and remote downloads."""

from __future__ import annotations

import base64
import hashlib

import httpx

from backend.config import settings

_DOWNLOAD_USER_AGENT = "Mozilla/5.0 (TextPhantomOCR; +https://huggingface.co/spaces)"


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
    """
    u = (url or "").strip()
    if not u:
        return b"", ""

    headers = {"user-agent": _DOWNLOAD_USER_AGENT}
    ref = (referer or "").strip()
    if ref:
        headers["referer"] = ref

    with httpx.Client(
        timeout=settings.http_timeout_sec,
        follow_redirects=True,
        headers=headers,
    ) as client:
        r = client.get(u)
        r.raise_for_status()
        content_type = (r.headers.get("content-type") or "").split(";")[0].strip()
        return r.content, content_type
