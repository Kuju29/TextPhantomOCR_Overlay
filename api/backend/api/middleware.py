"""Quiet HTTP/WebSocket logging for production.

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
