"""Small logging helpers used across the backend.

Production defaults are intentionally quiet: no uvicorn access spam, no health
polls, and no debug payload dumps.  ``event`` emits one compact JSON line for
important outcomes only (for example a translation job finishing or failing).
``dbg`` remains available for deep troubleshooting when ``TP_DEBUG=1``.
"""

from __future__ import annotations

import json
from typing import Any

from backend.config import settings

_MAX_PAYLOAD_CHARS = 2000
_EVENT_MODES = {"summary", "custom", "tp", "plain"}


def _json(data: Any) -> str:
    text = json.dumps(data, ensure_ascii=False, default=str, separators=(",", ":"))
    if len(text) > _MAX_PAYLOAD_CHARS:
        text = text[:_MAX_PAYLOAD_CHARS] + "…"
    return text


def event(tag: str, data: Any | None = None, *, ok: bool = True) -> None:
    """Emit one compact production log line for an important outcome.

    Controlled by ``TP_ACCESS_LOG_MODE``:
    - ``summary`` / ``custom`` / ``tp`` / ``plain``: emit these compact lines.
    - ``off`` / ``none``: emit nothing except explicit startup prints and fatal
      process errors.
    - ``uvicorn``: do not duplicate uvicorn's own access log.
    """
    if settings.access_log_mode not in _EVENT_MODES:
        return
    level = "ok" if ok else "err"
    try:
        if data is None:
            print(f"[TextPhantom][{level}] {tag}", flush=True)
        else:
            print(f"[TextPhantom][{level}] {tag} {_json(data)}", flush=True)
    except Exception:
        # Logging must never break request handling.
        pass


def dbg(tag: str, data: Any | None = None) -> None:
    """Print a tagged debug line only when ``TP_DEBUG`` is enabled."""
    if not settings.debug:
        return
    try:
        if data is None:
            print(f"[TextPhantom][dbg] {tag}", flush=True)
            return
        print(f"[TextPhantom][dbg] {tag} {_json(data)}", flush=True)
    except Exception:
        # Last-resort: don't let logging break a request.
        try:
            print(f"[TextPhantom][dbg] {tag} {data!r}", flush=True)
        except Exception:
            pass
