"""Firebase-hosted Google Lens session cookie with bounded refresh singleflight."""

from __future__ import annotations

from dataclasses import dataclass
import threading
import time

import httpx

from backend.config import settings

_cache: dict[str, object] = {"ts": 0.0, "url": "", "data": None}
_generation = 0
_refresh_epoch = 0
_refreshing = False
_refresh_error: BaseException | None = None
_condition = threading.Condition()


class CookieRefreshTimeout(RuntimeError):
    """A concurrent cookie refresh did not finish within the bounded wait."""


@dataclass(frozen=True)
class CookieState:
    data: dict
    generation: int
    refresh_epoch: int
    coalesced: bool = False


def _url(firebase_url: str | None) -> str:
    url = (firebase_url or settings.firebase_url or "").strip()
    if not url:
        raise RuntimeError(
            "FIREBASE_URL is empty — Google Lens needs a cookie source. "
            "Unset it to use the built-in jar, or point it at your own."
        )
    return url


def _fresh(url: str, now: float) -> bool:
    return bool(
        _cache.get("data")
        and _cache.get("url") == url
        and (now - float(_cache.get("ts") or 0.0)) < settings.firebase_cookie_ttl_sec
    )


def _fetch(url: str) -> dict:
    response = httpx.get(url, timeout=30)
    response.raise_for_status()
    value = response.json()
    if not isinstance(value, dict) or not value:
        raise RuntimeError("Lens cookie source returned no usable cookie jar")
    return value


def _refresh(url: str, *, observed_epoch: int, timeout_sec: float) -> CookieState:
    """Refresh once, or share a refresh completed after the caller's snapshot."""
    global _generation, _refresh_epoch, _refreshing, _refresh_error
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
        _refreshing = True

    try:
        value = _fetch(url)
        with _condition:
            if value != _cache.get("data") or url != _cache.get("url"):
                _generation += 1
            _cache.update(ts=time.time(), url=url, data=dict(value))
            _refresh_error = None
            return CookieState(dict(value), _generation, _refresh_epoch + 1, False)
    except BaseException as exc:
        with _condition:
            _refresh_error = exc
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
    return _refresh(url, observed_epoch=epoch, timeout_sec=timeout_sec)


def refresh_after(
    prior: CookieState, firebase_url: str | None = None, *, timeout_sec: float = 30.0
) -> CookieState:
    """Return the one refresh performed after *prior* was observed."""
    return _refresh(
        _url(firebase_url), observed_epoch=prior.refresh_epoch, timeout_sec=timeout_sec
    )


def get(firebase_url: str | None = None, *, force_refresh: bool = False) -> dict:
    """Backward-compatible cookie-only API."""
    current = state(firebase_url)
    if force_refresh:
        current = refresh_after(current, firebase_url)
    return current.data


def _reset_for_tests() -> None:
    global _generation, _refresh_epoch, _refreshing, _refresh_error
    with _condition:
        _cache.update(ts=0.0, url="", data=None)
        _generation = 0
        _refresh_epoch = 0
        _refreshing = False
        _refresh_error = None
        _condition.notify_all()
