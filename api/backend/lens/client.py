"""Google Lens HTTP client.

Two-step flow:
1. ``POST https://lens.google.com/v3/upload`` with the image — Lens responds
   with a 302 redirect to a result URL.
2. Rewrite that URL to the *translated image* endpoint and ``GET`` it; the
   body is JSON (with a ``)]}'`` XSSI prefix that we strip).
"""

from __future__ import annotations

import base64
import hashlib
import json
import threading
import time
from collections import OrderedDict
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from backend.config import settings
from backend.lens import cookie
from backend.log import dbg

_UPLOAD_URL = "https://lens.google.com/v3/upload"
_REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://lens.google.com/",
}

# --- Shared HTTP client (connection pooling) --------------------------------
# Creating a fresh httpx.Client per request costs a new TCP + TLS handshake
# (several hundred ms) on EVERY job.  One pooled client reuses connections.
# Cookies are passed per-request (not on the client) so a cookie refresh
# never requires rebuilding the client.
_client_lock = threading.Lock()
_client: httpx.Client | None = None


def _shared_client() -> httpx.Client:
    global _client
    with _client_lock:
        if _client is None or _client.is_closed:
            _client = httpx.Client(
                headers=_REQUEST_HEADERS,
                follow_redirects=False,
                timeout=60,
                limits=httpx.Limits(
                    max_connections=20, max_keepalive_connections=10, keepalive_expiry=30.0
                ),
            )
        return _client


# --- Lens response cache -----------------------------------------------------
# Keyed by (sha256(image), lang).  All three sources (original / translated /
# ai) and both modes need the same Lens JSON for a given image+lang, so
# switching modes must NOT redo the Google roundtrip (~1-2 s).
_LENS_CACHE_MAX = 48
_LENS_CACHE_TTL = 600.0  # seconds
_lens_cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_lens_cache_lock = threading.Lock()


def _lens_cache_get(key: str) -> dict[str, Any] | None:
    now = time.time()
    with _lens_cache_lock:
        hit = _lens_cache.get(key)
        if not hit:
            return None
        ts, data = hit
        if now - ts > _LENS_CACHE_TTL:
            _lens_cache.pop(key, None)
            return None
        _lens_cache.move_to_end(key)
        return data


def _lens_cache_set(key: str, data: dict[str, Any]) -> None:
    with _lens_cache_lock:
        _lens_cache[key] = (time.time(), data)
        _lens_cache.move_to_end(key)
        while len(_lens_cache) > _LENS_CACHE_MAX:
            _lens_cache.popitem(last=False)


def _to_translated_url(redirect_url: str, lang: str) -> str:
    """Rewrite a Lens result URL into its ``translatedimage`` equivalent."""
    q = parse_qs(urlparse(redirect_url).query)
    params = {
        "vsrid": q["vsrid"][0],
        "gsessionid": q["gsessionid"][0],
        "sl": "auto",
        "tl": lang,
        "se": 1,
        "ib": "1",
    }
    return "https://lens.google.com/translatedimage?" + urlencode(params)


def _fetch_once(img_bytes: bytes, lang: str, ck: dict) -> dict[str, Any]:
    """One upload + result-fetch roundtrip against Lens."""
    c = _shared_client()
    r = c.post(
        _UPLOAD_URL,
        files={"encoded_image": ("file.jpg", img_bytes, "image/jpeg")},
        cookies=ck,
    )
    if r.status_code not in (302, 303):
        raise RuntimeError(f"Lens upload failed: {r.status_code}\n{r.text}")
    redirect = r.headers["location"]

    translated_url = _to_translated_url(redirect, lang)
    body = c.get(translated_url, cookies=ck, follow_redirects=True).text

    # Strip the XSSI-protection prefix Google prepends to JSON responses.
    if body.startswith(")]}'"):
        body = body[5:]
    return json.loads(body)


def fetch_lens_data(image_path: str, lang: str, firebase_url: str | None = None) -> dict[str, Any]:
    """Upload ``image_path`` to Lens and return the parsed translation JSON.

    Results are cached in-process by (image hash, lang) so re-requesting the
    same image — e.g. when the user flips between original / translated / AI
    modes — skips the Google roundtrip entirely.
    """
    with open(image_path, "rb") as f:
        img_bytes = f.read()

    cache_key = hashlib.sha256(img_bytes).hexdigest() + "|" + (lang or "")
    cached = _lens_cache_get(cache_key)
    if cached is not None:
        dbg("lens.cache.hit", {"lang": lang})
        return cached

    ck = cookie.get(firebase_url)
    try:
        data = _fetch_once(img_bytes, lang, ck)
    except KeyError:
        # Redirect URL missing vsrid/gsessionid — usually a stale/invalid
        # cookie. Refresh the cookie once and retry instead of failing the job.
        dbg("lens.retry", {"reason": "missing redirect params"})
        ck = cookie.get(firebase_url, force_refresh=True)
        data = _fetch_once(img_bytes, lang, ck)

    if isinstance(data, dict):
        _lens_cache_set(cache_key, data)
    return data


def _b64_pad(s: str) -> str:
    return s + "=" * ((4 - (len(s) % 4)) % 4)


def decode_image_url_to_data_uri(image_url: str | None) -> str | None:
    """Best-effort decode of the Lens ``imageUrl`` field into a data URI.

    The field is sometimes already a data URI, sometimes a base64 blob that
    *contains* a data URI.  Returns ``None`` when nothing usable is found.
    """
    if not image_url:
        return None
    if isinstance(image_url, str) and image_url.startswith("data:image") and "base64," in image_url:
        return image_url

    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            raw = decoder(_b64_pad(image_url))
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("utf-8", errors="ignore")
            if "data:image" in text and "base64," in text:
                i = text.find("data:image")
                return text[i:].strip() if i >= 0 else text.strip()
        except Exception:
            continue
    return None
