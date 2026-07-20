"""Quiet HTTP/WebSocket logging for production.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

The stock uvicorn access log is too noisy for this app because extensions poll
``/health``, ``/warmup``, ``/meta`` and ``/translate/{id}`` frequently.  By
default we disable uvicorn access logs and only emit compact application events
from the route/job code.

Modes via ``TP_ACCESS_LOG_MODE``:
- ``summary`` (default): one compact line for important success/error outcomes.
- ``off`` / ``none``: no app summary lines.
- ``uvicorn``: restore uvicorn's stock access log.
"""

from __future__ import annotations

import logging
from http import HTTPStatus

from fastapi import Request

from backend.config import settings
from backend.log import event

_UVICORN_MODE = "uvicorn"
_EVENT_MODES = {"summary", "custom", "tp", "plain"}
_NOISY_PATHS = ("/health", "/warmup", "/meta")

# The app's REAL route prefixes. A 404 on anything else is internet background
# noise — vulnerability scanners probing /.env, /.git/config, /phpinfo.php,
# /actuator/... on every public host. Those used to be logged one line each
# (dozens per sweep, several sweeps per hour on a public HF Space) and drowned
# out real errors; now they are AGGREGATED into one compact summary line per
# window (see _note_scanner_probe).
_KNOWN_PREFIXES = (
    "/translate", "/ai/", "/ws", "/health", "/warmup", "/meta", "/version",
)

_SCANNER_WINDOW_SEC = 600  # one summary line per 10 minutes at most
_scanner = {"count": 0, "since": 0.0, "samples": []}


def _note_scanner_probe(method: str, path: str) -> None:
    """Count an off-route 404 and emit one summary line per window."""
    import time

    now = time.time()
    if not _scanner["since"]:
        _scanner["since"] = now
    _scanner["count"] += 1
    if len(_scanner["samples"]) < 5:
        _scanner["samples"].append(f"{method} {path}"[:80])
    if now - _scanner["since"] >= _SCANNER_WINDOW_SEC:
        event(
            "http.scanner",
            {
                "probes": _scanner["count"],
                "window_min": round((now - _scanner["since"]) / 60, 1),
                "samples": list(_scanner["samples"]),
            },
            ok=False,
        )
        _scanner.update(count=0, since=now, samples=[])


def _quiet_logger(name: str, *, disable: bool = False) -> None:
    """Lower a third-party logger without risking request handling."""
    try:
        logger = logging.getLogger(name)
        if disable:
            logger.disabled = True
            logger.propagate = False
            logger.setLevel(logging.CRITICAL)
        else:
            logger.setLevel(logging.WARNING)
    except Exception:
        pass


def configure_uvicorn_access_log() -> None:
    """Silence uvicorn/websocket request chatter unless explicitly restored."""
    if settings.access_log_mode == _UVICORN_MODE:
        return

    # This is the source of lines like:
    # INFO: 10.x.x.x:12345 - "GET /health HTTP/1.1" 200 OK
    _quiet_logger("uvicorn.access", disable=True)

    # These suppress websocket lifecycle chatter such as "connection open" /
    # "connection closed" while preserving warnings and errors.
    _quiet_logger("websockets.server")
    _quiet_logger("websockets.protocol")


async def access_log_middleware(request: Request, call_next):
    """Log only HTTP failures; success summaries are emitted by route/job code."""
    try:
        response = await call_next(request)
    except Exception as exc:
        if settings.access_log_mode in _EVENT_MODES:
            event(
                "http.error",
                {
                    "method": request.method,
                    "path": request.url.path,
                    "error": str(exc)[:240],
                },
                ok=False,
            )
        raise

    if settings.access_log_mode in _EVENT_MODES:
        try:
            path = request.url.path
            # No health/warmup/meta/poll success spam.  Only surface HTTP errors.
            if response.status_code >= 400 and not path.startswith(_NOISY_PATHS):
                # Scanner-bot probes (404 on a path we never served) are
                # aggregated, not logged per line — keeps real errors visible.
                if response.status_code == 404 and not path.startswith(_KNOWN_PREFIXES):
                    _note_scanner_probe(request.method, path)
                else:
                    phrase = HTTPStatus(response.status_code).phrase
                    event(
                        "http.error",
                        {
                            "method": request.method,
                            "path": path,
                            "status": response.status_code,
                            "message": phrase,
                        },
                        ok=False,
                    )
        except Exception:
            pass
    return response
