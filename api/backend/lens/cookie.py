"""Google Lens session cookie jar with bounded refresh singleflight.

Sources (``TP_LENS_COOKIE_SOURCE``): ``direct`` - the API opens lens.google.com
itself; ``firebase`` - a JSON jar at ``FIREBASE_URL``. The default is
``direct-first`` and Firebase is used only when ``FIREBASE_URL`` is set: the
public source has no built-in cookie URL.

Refresh policy: no background polling. :func:`state` refreshes lazily (one
singleflight per expiry); :func:`prefetch` starts a non-blocking refresh when
the jar is missing or close to expiry, and is called on signs of use (warmup,
Lens job submission). When every source fails, further attempts back off
5 -> 15 -> 60 minutes; a jar that only aged past its refresh time keeps serving
meanwhile, and Lens itself reports a jar it rejects.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx, threading, time

from backend.config import settings

_cache: dict[str, object] = {"ts": 0.0, "url": "", "data": None}
_generation = 0
_refresh_epoch = 0
_refreshing = False
_refresh_error: BaseException | None = None
_condition = threading.Condition()
# Source-failure back-off (wall clock). Reset by any successful refresh.
BACKOFF_SEC = (300.0, 900.0, 3600.0)
_failures = 0
_retry_at = 0.0
_prefetching = False

class CookieRefreshTimeout(RuntimeError):
    """A concurrent cookie refresh did not finish within the bounded wait."""

class CookieSourceBackoff(RuntimeError):
    """Every cookie source failed recently; the next attempt is not due yet."""

@dataclass(frozen=True)
class CookieState:
    data: dict
    generation: int
    refresh_epoch: int
    coalesced: bool = False

def _sources(url: str) -> tuple[str, ...]:
    """Configured order, without Firebase when no FIREBASE_URL is set."""
    return tuple(name for name in _order() if name != "firebase" or url)


def _url(firebase_url: str | None) -> str:
    """The Firebase jar URL ('' when unset) after checking a source exists."""
    url = (firebase_url or settings.firebase_url or "").strip()
    if not _sources(url):
        raise RuntimeError(
            "No Google Lens cookie source: TP_LENS_COOKIE_SOURCE=firebase needs "
            "FIREBASE_URL. Use direct-first (default) or set FIREBASE_URL."
        )
    return url


def configured(firebase_url: str | None = None) -> bool:
    """Whether at least one cookie source can be tried."""
    try:
        _url(firebase_url)
    except RuntimeError:
        return False
    return True

def _fresh(url: str, now: float) -> bool:
    return bool(
        _cache.get("data")
        and _cache.get("url") == url
        and (now - float(_cache.get("ts") or 0.0)) < settings.firebase_cookie_ttl_sec
    )

def _fetch_firebase(url: str) -> dict:
    response = httpx.get(url, timeout=30)
    response.raise_for_status()
    value = response.json()
    if not isinstance(value, dict) or not value:
        raise RuntimeError("Lens cookie source returned no usable cookie jar")
    return value

# "direct" source: the API opens https://lens.google.com/ itself, exactly as a
# browser's first visit does, and keeps the cookies Google sets on that response.
# Nothing is forged or solved: if Google answers with a consent page, a challenge
# or no cookies, this source simply fails and the next source is used. Whether
# Google gives a usable jar to the API's network is checked with
#   python -m backend.lens.cookie_check
DIRECT_URL = "https://lens.google.com/"
_DIRECT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/140.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def _fetch_direct() -> dict:
    with httpx.Client(headers=_DIRECT_HEADERS, follow_redirects=True, timeout=15) as client:
        response = client.get(DIRECT_URL)
        host = (response.url.host or "").lower()
        path = response.url.path or ""
        # lens.google.com redirects a plain visit to www.google.com (HTTP 200),
        # whose google.com cookies are kept. Only a consent page or Google's
        # "sorry" (automated traffic) page is a refusal.
        refused = host == "consent.google.com" or path.startswith("/sorry")
        if response.status_code >= 400 or refused or not (host == "google.com" or host.endswith(".google.com")):
            raise RuntimeError(f"direct Lens visit ended at {host or 'unknown'}{'/sorry' if path.startswith('/sorry') else ''} (HTTP {response.status_code})")
        jar = {c.name: c.value for c in client.cookies.jar
               if c.value and (c.domain or "").lstrip(".").endswith("google.com")}
    if not jar:
        raise RuntimeError("direct Lens visit returned no cookies")
    return jar


def _order() -> tuple[str, ...]:
    """TP_LENS_COOKIE_SOURCE: firebase (only), direct (only), auto = firebase then
    direct, direct-first = direct then firebase (default; Firebase stays the
    fallback when Google refuses)."""
    value = (settings.lens_cookie_source or "direct-first").strip().lower()
    return {"firebase": ("firebase",), "direct": ("direct",),
            "direct-first": ("direct", "firebase")}.get(value, ("firebase", "direct"))


_last_source = ""


def source() -> str:
    """Which source supplied the current jar ('' before the first fetch)."""
    return _last_source


def _fetch(url: str, rejected: dict | None = None) -> dict:
    """First source that answers with a jar. After Lens rejected a jar, a source
    still serving that same jar (Firebase while the Pi is down) is skipped."""
    global _last_source
    errors = []
    for name in _sources(url):
        try:
            value = _fetch_firebase(url) if name == "firebase" else _fetch_direct()
        except Exception as exc:  # noqa: BLE001 - try the next source; all failures are raised together
            errors.append(f"{name}: {type(exc).__name__}")
            continue
        if rejected and value == rejected:
            errors.append(f"{name}: same_rejected_jar")
            continue
        _last_source = name
        return value
    raise RuntimeError("no Lens cookie source answered (" + "; ".join(errors) + ")")

def _backoff_check() -> None:
    """Raise while a failed source is backing off (caller holds _condition)."""
    remaining = _retry_at - time.time()
    if remaining > 0:
        raise CookieSourceBackoff(
            f"Lens cookie sources failed recently; next attempt in {int(remaining) + 1}s")


def backoff_remaining() -> float:
    with _condition:
        return max(0.0, _retry_at - time.time())


def _refresh(url: str, *, observed_epoch: int, timeout_sec: float, rejected: dict | None = None) -> CookieState:
    """Refresh once, or share a refresh completed after the caller's snapshot."""
    global _generation, _refresh_epoch, _refreshing, _refresh_error, _failures, _retry_at
    deadline = time.monotonic() + max(0.01, float(timeout_sec))
    with _condition:
        if _refresh_epoch > observed_epoch:
            if _refresh_error is not None:
                raise _refresh_error
            return CookieState(dict(_cache.get("data") or {}), _generation, _refresh_epoch, True)
        if _refreshing:
            while _refreshing and _refresh_epoch <= observed_epoch:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CookieRefreshTimeout("Lens cookie refresh timed out")
                _condition.wait(remaining)
            if _refresh_error is not None:
                raise _refresh_error
            return CookieState(dict(_cache.get("data") or {}), _generation, _refresh_epoch, True)
        _backoff_check()
        _refreshing = True

    try:
        value = _fetch(url, rejected)
        with _condition:
            if value != _cache.get("data") or url != _cache.get("url"):
                _generation += 1
            _cache.update(ts=time.time(), url=url, data=dict(value))
            _refresh_error = None
            _failures, _retry_at = 0, 0.0
            return CookieState(dict(value), _generation, _refresh_epoch + 1, False)
    except BaseException as exc:
        with _condition:
            _refresh_error = exc
            if isinstance(exc, Exception):
                _failures += 1
                _retry_at = time.time() + BACKOFF_SEC[min(_failures, len(BACKOFF_SEC)) - 1]
        raise
    finally:
        with _condition:
            _refreshing = False
            _refresh_epoch += 1
            _condition.notify_all()

def state(firebase_url: str | None = None, *, timeout_sec: float = 30.0) -> CookieState:
    """Return a fresh snapshot, coalescing a cold-cache fetch as well."""
    url = _url(firebase_url)
    with _condition:
        if _fresh(url, time.time()):
            return CookieState(dict(_cache.get("data") or {}), _generation, _refresh_epoch)
        epoch = _refresh_epoch
        previous = dict(_cache.get("data") or {}) if _cache.get("url") == url else {}
        previous_generation = _generation
        if previous and _retry_at > time.time():
            # Source is backing off: keep serving the aged jar without a call.
            return CookieState(previous, previous_generation, epoch, coalesced=True)
    try:
        return _refresh(url, observed_epoch=epoch, timeout_sec=timeout_sec)
    except Exception:
        # The jar only aged past its refresh time; the cookie source being
        # down must not stop Lens while that jar still works. Lens itself
        # reports a rejected jar (LensSessionError), and that path calls
        # refresh_after(), which never reuses an old jar. The failure armed the
        # 5/15/60-minute back-off, so later calls do not hit the source.
        if not previous:
            raise
        with _condition:
            current_epoch = _refresh_epoch
        return CookieState(previous, previous_generation, current_epoch, coalesced=True)

def prefetch(firebase_url: str | None = None, *, margin_sec: float | None = None) -> bool:
    """Start a background refresh if the jar is missing or near expiry.

    Never blocks and never raises; returns whether a refresh was started. No
    refresh starts while one is running or while a failed source backs off.
    """
    global _prefetching
    try:
        url = _url(firebase_url)
    except RuntimeError:
        return False
    ttl = float(settings.firebase_cookie_ttl_sec)
    margin = max(30.0, ttl * 0.2) if margin_sec is None else max(0.0, float(margin_sec))
    now = time.time()
    with _condition:
        if _prefetching or _refreshing or _retry_at > now:
            return False
        if (_cache.get("data") and _cache.get("url") == url
                and now - float(_cache.get("ts") or 0.0) < ttl - margin):
            return False
        epoch = _refresh_epoch
        _prefetching = True

    def run() -> None:
        global _prefetching
        try:
            _refresh(url, observed_epoch=epoch, timeout_sec=30.0)
        except Exception:
            pass  # recorded by _refresh (error + back-off); requests keep the old jar
        finally:
            with _condition:
                _prefetching = False

    try:
        threading.Thread(target=run, name="tp-lens-cookie-prefetch", daemon=True).start()
    except RuntimeError:
        with _condition:
            _prefetching = False
        return False
    return True

def refresh_after(
    prior: CookieState, firebase_url: str | None = None, *, timeout_sec: float = 30.0
) -> CookieState:
    """Return the one refresh performed after *prior* was observed."""
    return _refresh(
        _url(firebase_url), observed_epoch=prior.refresh_epoch, timeout_sec=timeout_sec,
        rejected=dict(prior.data or {}),
    )

def get(firebase_url: str | None = None, *, force_refresh: bool = False) -> dict:
    """Backward-compatible cookie-only API."""
    current = state(firebase_url)
    if force_refresh:
        current = refresh_after(current, firebase_url)
    return current.data

def _reset_for_tests() -> None:
    global _generation, _refresh_epoch, _refreshing, _refresh_error, _failures, _retry_at, _prefetching
    with _condition:
        _cache.update(ts=0.0, url="", data=None)
        _generation = 0
        _refresh_epoch = 0
        _refreshing = False
        _refresh_error = None
        _failures, _retry_at, _prefetching = 0, 0.0, False
        _condition.notify_all()
