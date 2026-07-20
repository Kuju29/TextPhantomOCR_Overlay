"""Google Lens HTTP client.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

Two-step flow:
1. ``POST https://lens.google.com/v3/upload`` with the image — Lens responds
   with a 302 redirect to a result URL.
2. Rewrite that URL to the *translated image* endpoint and ``GET`` it; the
   body is JSON (with a ``)]}'`` XSSI prefix that we strip).
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import threading
import time
from collections import OrderedDict
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from backend.lens import cookie

_UPLOAD_URL = "https://lens.google.com/v3/upload"
_REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://lens.google.com/",
}

# --- Lens response cache (in-process, TTL LRU) -------------------------------
# Keyed by (sha256(image), lang). Switching source (original / translated /
# AI) re-sends the SAME image+lang, so the ~2 s Google roundtrip (measured
# lens_ms) can be skipped entirely on repeats. This wraps fetch_lens_data
# only — the HTTP requests themselves are untouched.
# Sized for translated->AI passes over large batches (100+ images); entries
# are Lens JSON dicts, typically tens of KB each. Override via env if needed.
_LENS_CACHE_MAX = max(8, int(os.environ.get("TP_LENS_CACHE_MAX", "256")))
_LENS_CACHE_TTL_SEC = 600.0
_lens_cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_lens_cache_lock = threading.Lock()


def _lens_cache_get(key: str) -> dict[str, Any] | None:
    with _lens_cache_lock:
        hit = _lens_cache.get(key)
        if not hit:
            return None
        ts, data = hit
        if time.time() - ts > _LENS_CACHE_TTL_SEC:
            _lens_cache.pop(key, None)
            return None
        _lens_cache.move_to_end(key)
        # Deep-copy out so callers can never mutate the cached response.
        return copy.deepcopy(data)


def _lens_cache_set(key: str, data: dict[str, Any]) -> None:
    with _lens_cache_lock:
        _lens_cache[key] = (time.time(), copy.deepcopy(data))
        _lens_cache.move_to_end(key)
        while len(_lens_cache) > _LENS_CACHE_MAX:
            _lens_cache.popitem(last=False)


class LensSessionError(RuntimeError):
    """The Lens redirect lacked session params (stale/rejected cookie)."""


def _to_translated_url(redirect_url: str, lang: str) -> str:
    """Rewrite a Lens result URL into its ``translatedimage`` equivalent.

    Raises :class:`LensSessionError` when the redirect does not carry the
    ``vsrid``/``gsessionid`` params — the classic symptom of an expired or
    rejected cookie (Lens bounced us to a consent/error page instead of a
    result URL). Callers refresh the cookie and retry once.
    """
    q = parse_qs(urlparse(redirect_url).query)
    vsrid = (q.get("vsrid") or [""])[0]
    gsessionid = (q.get("gsessionid") or [""])[0]
    if not vsrid or not gsessionid:
        raise LensSessionError(
            f"Lens redirect missing session params (vsrid={bool(vsrid)}, "
            f"gsessionid={bool(gsessionid)}) — cookie likely expired"
        )
    params = {
        "vsrid": vsrid,
        "gsessionid": gsessionid,
        "sl": "auto",
        "tl": lang,
        "se": 1,
        "ib": "1",
    }
    return "https://lens.google.com/translatedimage?" + urlencode(params)


def _has_lens_text(data: dict[str, Any]) -> bool:
    """Whether a Lens response actually carries OCR text/paragraphs.

    Empty responses are NOT cached: Lens occasionally returns a valid but
    empty payload under load, and caching that made the image permanently
    "no text" for the TTL window (the reported untranslated-images bug).
    """
    return bool(
        data.get("originalParagraphs")
        or data.get("translatedParagraphs")
        or str(data.get("originalTextFull") or "").strip()
    )


def _fetch_lens_once(img_bytes: bytes, lang: str, ck: dict) -> dict[str, Any]:
    """One upload+fetch round trip against Lens with the given cookie jar."""
    with httpx.Client(cookies=ck, headers=_REQUEST_HEADERS, follow_redirects=False, timeout=60) as c:
        r = c.post(_UPLOAD_URL, files={"encoded_image": ("file.jpg", img_bytes, "image/jpeg")})
        if r.status_code not in (302, 303):
            raise RuntimeError(f"Lens upload failed: {r.status_code}\n{r.text}")
        redirect = r.headers["location"]

    translated_url = _to_translated_url(redirect, lang)
    with httpx.Client(cookies=ck, headers=_REQUEST_HEADERS, timeout=60) as c:
        body = c.get(translated_url).text

    # Strip the XSSI-protection prefix Google prepends to JSON responses.
    if body.startswith(")]}'"):
        body = body[5:]
    return json.loads(body)


def fetch_lens_data(image_path: str, lang: str, firebase_url: str | None = None) -> dict[str, Any]:
    """Upload ``image_path`` to Lens and return the parsed translation JSON.

    Repeats of the same image+lang within the cache TTL are served from the
    in-process cache (no Google roundtrip). A stale-cookie redirect (missing
    ``gsessionid``) triggers ONE forced cookie refresh + retry instead of
    failing the job.
    """
    with open(image_path, "rb") as f:
        img_bytes = f.read()

    cache_key = hashlib.sha256(img_bytes).hexdigest() + "|" + (lang or "")
    cached = _lens_cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        data = _fetch_lens_once(img_bytes, lang, cookie.get(firebase_url))
    except LensSessionError:
        # Cookie went stale mid-flight — refresh it and retry once.
        data = _fetch_lens_once(
            img_bytes, lang, cookie.get(firebase_url, force_refresh=True)
        )

    # Cache only responses that carry text. Genuinely textless images are
    # cheap to re-check; transient empty responses must never stick.
    if isinstance(data, dict) and _has_lens_text(data):
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
