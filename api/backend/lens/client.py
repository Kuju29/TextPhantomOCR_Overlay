"""Google Lens HTTP client.

Two-step flow:
1. ``POST https://lens.google.com/v3/upload`` with the image — Lens responds
   with a 302 redirect to a result URL.
2. Rewrite that URL to the *translated image* endpoint and ``GET`` it; the
   body is JSON (with a ``)]}'`` XSSI prefix that we strip).
"""

from __future__ import annotations

import base64
import json
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from backend.lens import cookie

_UPLOAD_URL = "https://lens.google.com/v3/upload"
_REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://lens.google.com/",
}


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


def fetch_lens_data(image_path: str, lang: str, firebase_url: str | None = None) -> dict[str, Any]:
    """Upload ``image_path`` to Lens and return the parsed translation JSON."""
    ck = cookie.get(firebase_url)

    with open(image_path, "rb") as f:
        img_bytes = f.read()

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
