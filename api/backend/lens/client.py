"""Google Lens HTTP client.


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
from backend import trace

_UPLOAD_URL = "https://lens.google.com/v3/upload"
_REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://lens.google.com/",
}

# --- Connection pool ---------------------------------------------------------
# Every Lens call is two requests to the same host, and a `with httpx.Client()`
# around each one meant every request opened a fresh TCP + TLS connection.
# Counted on 2026-08-07: ten images cost TWENTY handshakes; a pooled client
# costs one. Each handshake is two network round trips (TCP, then TLS 1.3), so
# on a 3.0 s Lens call this is pure latency that buys nothing.
#
# ONE client per cookie jar, not one per request:
#   * httpx 0.28 deprecated per-request `cookies=` (the persistence rules are
#     ambiguous), so the jar has to live on the client;
#   * the jar changes only when the Firebase cookie is refreshed, which a
#     background task does about once an hour — so in practice one client
#     serves every request.
#
# The default `keepalive_expiry` of 5 s is deliberately left alone: requests
# within one image (and across a batch) are milliseconds apart and reuse the
# connection, while an idle connection is dropped by us long before Google
# would drop it — which is what makes a stale-socket error impossible here.
_client_lock = threading.Lock()
_client: httpx.Client | None = None
_client_jar_key = ""
_limits = httpx.Limits(max_connections=32, max_keepalive_connections=16)


def _jar_key(ck: dict) -> str:
    """Identity of a cookie jar, so a refresh is noticed and nothing else is."""
    return hashlib.sha256(
        json.dumps(ck or {}, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _session(ck: dict) -> httpx.Client:
    """The pooled client for this cookie jar, rebuilt when the jar changes.

    ``httpx.Client`` is safe to share across threads, which is what makes one
    client serving fifteen workers correct rather than merely convenient.
    """
    global _client, _client_jar_key
    key = _jar_key(ck)
    with _client_lock:
        if _client is not None and _client_jar_key == key:
            return _client
        stale = _client
        _client = httpx.Client(
            cookies=ck,
            headers=_REQUEST_HEADERS,
            follow_redirects=False,
            timeout=60,
            limits=_limits,
        )
        _client_jar_key = key
    if stale is not None:
        # Outside the lock: closing drains sockets and must not block a request
        # that is only waiting to read the new client.
        try:
            stale.close()
        except Exception:  # noqa: BLE001 - a client we are discarding anyway
            pass
    return _client


def close_session() -> None:
    """Drop the pooled client. For tests and shutdown."""
    global _client, _client_jar_key
    with _client_lock:
        stale, _client, _client_jar_key = _client, None, ""
    if stale is not None:
        stale.close()

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


class _Flight:
    def __init__(self) -> None:
        self.done = threading.Event()
        self.data: dict[str, Any] | None = None
        self.error: BaseException | None = None


_FLIGHT_MAX = max(1, int(os.environ.get("TP_LENS_SINGLEFLIGHT_MAX", "128")))
_flights: dict[str, _Flight] = {}
_flights_lock = threading.Lock()


def _cookie_trace(state: str, **data: Any) -> None:
    """Emit compact recovery telemetry when the active trace build supports it."""
    note = getattr(trace, "note", None)
    if callable(note):
        note("lens_cookie", {"state": state, **data}, file="lens/client.py")


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
    """One upload+fetch round trip against Lens with the given cookie jar.

    The two requests are genuinely sequential — the second one's URL comes out
    of the first one's redirect — so the only thing to win here is not paying
    for a new connection twice. Both go through the pooled client.
    """
    c = _session(ck)
    r = c.post(_UPLOAD_URL, files={"encoded_image": ("file.jpg", img_bytes, "image/jpeg")})
    if r.status_code not in (302, 303):
        # Never include the raw upstream body: gateways can echo request data
        # and HTML error pages only make the public/log message noisy.
        raise RuntimeError(f"Lens HTTP {r.status_code} (operation=upload)")
    redirect = r.headers["location"]

    translated_url = _to_translated_url(redirect, lang)
    translated_response = c.get(translated_url)
    if not translated_response.is_success:
        raise RuntimeError(
            f"Lens HTTP {translated_response.status_code} (operation=result)"
        )
    body = translated_response.text

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

    leader = False
    with _flights_lock:
        flight = _flights.get(cache_key)
        if flight is None and len(_flights) < _FLIGHT_MAX:
            flight = _Flight()
            _flights[cache_key] = flight
            leader = True
    if flight is not None and not leader:
        # The route's admission/cancellation boundary remains outside this
        # synchronous client. Waiting shares the leader's network result; it
        # never starts a second Google upload.
        flight.done.wait()
        if flight.error is not None:
            raise flight.error
        return copy.deepcopy(flight.data or {})

    try:
        try:
            initial = cookie.state(firebase_url)
            _cookie_trace("initial", generation=initial.generation)
            data = _fetch_lens_once(img_bytes, lang, initial.data)
        except LensSessionError as initial_error:
            # Refresh is global across image keys, while result singleflight is
            # per image. Generation/epoch prevents every image in one stale
            # batch from independently fetching the same Firebase jar.
            try:
                refreshed = cookie.refresh_after(initial, firebase_url, timeout_sec=30.0)
            except BaseException as refresh_error:
                _cookie_trace("refresh_failed", errorType=type(refresh_error).__name__)
                raise LensSessionError("Lens cookie refresh failed") from refresh_error
            changed = refreshed.generation != initial.generation
            _cookie_trace(
                "refreshed" if changed else "refresh_unchanged",
                generation=refreshed.generation, coalesced=refreshed.coalesced,
            )
            if not changed:
                # Retrying the identical rejected jar only repeats an upload and
                # makes a stale Firebase value look transient.
                raise LensSessionError("Lens cookie source still serves the rejected jar") from initial_error
            try:
                data = _fetch_lens_once(img_bytes, lang, refreshed.data)
            except LensSessionError as refreshed_error:
                _cookie_trace(
                    "refreshed_failed", generation=refreshed.generation,
                    coalesced=refreshed.coalesced,
                )
                raise LensSessionError("Lens rejected the refreshed cookie jar") from refreshed_error
            _cookie_trace(
                "refreshed_success", generation=refreshed.generation,
                coalesced=refreshed.coalesced,
            )

        # Cache only responses that carry text. Genuinely textless images are
        # cheap to re-check; transient empty responses must never stick.
        if isinstance(data, dict) and _has_lens_text(data):
            _lens_cache_set(cache_key, data)
        if leader and flight is not None:
            flight.data = copy.deepcopy(data)
        return data
    except BaseException as exc:
        if leader and flight is not None:
            flight.error = exc
        raise
    finally:
        if leader and flight is not None:
            flight.done.set()
            with _flights_lock:
                _flights.pop(cache_key, None)


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
