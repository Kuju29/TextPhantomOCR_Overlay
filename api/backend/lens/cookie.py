"""Firebase-hosted Google Lens session cookie.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

The Lens upload endpoint needs a valid cookie jar.  Rather than logging in
from the server we pull a pre-baked cookie object from a Firebase Realtime
Database URL.  The result is cached in-process for ``firebase_cookie_ttl_sec``.
"""

from __future__ import annotations

import time

import httpx

from backend.config import settings

# Cache: {"ts": float, "url": str, "data": dict | None}
_cache: dict[str, object] = {"ts": 0.0, "url": "", "data": None}


def get(firebase_url: str | None = None, *, force_refresh: bool = False) -> dict:
    """Return the Lens cookie dict, fetching it if the cache is cold/stale.

    ``force_refresh=True`` bypasses the cache — used when a Lens redirect came
    back without a ``gsessionid`` (the usual symptom of an expired cookie).
    """
    url = (firebase_url or settings.firebase_url or "").strip()
    now = time.time()

    if (
        not force_refresh
        and _cache.get("data")
        and _cache.get("url") == url
        and (now - float(_cache.get("ts") or 0.0)) < settings.firebase_cookie_ttl_sec
    ):
        return _cache["data"]  # type: ignore[return-value]

    r = httpx.get(url, timeout=30)
    r.raise_for_status()
    cookie = r.json()

    _cache.update(ts=now, url=url, data=cookie)
    return cookie
